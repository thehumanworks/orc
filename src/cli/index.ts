#!/usr/bin/env bun
/**
 * `orc` — the orc CLI dispatcher. Parses the subcommand first, then parses the
 * remainder with that command's own options map (parseArgs is strict on unknowns).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { agent } from '../agent.ts';
import { listSessions, getSession, pruneSessions } from '../index.ts';
import { renderTurns, selectTurns } from '../transcript.ts';
import type { TurnSelection } from '../transcript.ts';
import {
  runWorkflow,
  runnerTmuxName,
  reconcileRun,
  assembleStepLogs,
  validateWorkflowDef,
} from '../workflow.ts';
import type { WorkflowDef, WorkflowEvent, WorkflowRun, StepResult } from '../workflow.ts';
import { readRun, listRuns, writeRun } from '../runs.ts';
import { getDriver } from '../drivers/driver.ts';
import { orcHome } from '../paths.ts';
import { resolveUntil } from '../state.ts';
import { resolveBind } from '../daemon/bind.ts';
import { tailscaleIp4 } from '../daemon/tailscale.ts';
import { serveDaemon } from '../daemon/server.ts';
import { readPeers, addPeer, removePeer, peerHosts, DEFAULT_DAEMON_PORT } from '../daemon/peers.ts';
import { DaemonClient, parseHostArg } from '../daemon/client.ts';
import type { RemoteTarget } from '../daemon/client.ts';
import type { AgentOptions, AgentState, Provider, SystemPromptMode } from '../types.ts';
import {
  printJson,
  printError,
  renderSessionDetail,
  renderSessionList,
  renderSessionListWithHost,
  renderWorkflowEvent,
  renderRunDetail,
  renderRunList,
  HELP_TEXT,
} from './output.ts';
import type { SessionView, HostSessionView } from './output.ts';

type ArgvOptions = NonNullable<ParseArgsConfig['options']>;

interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

function parse(args: string[], options: ArgvOptions): Parsed {
  const { values, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true,
  });
  return { values: values as Parsed['values'], positionals };
}

/**
 * Decide how a prompt arg should be sourced WITHOUT performing any I/O. This is the
 * load-bearing decision behind BUG 1 (spawn/send hanging forever on a never-closing
 * pipe): we must only ever block on `Bun.stdin.text()` when stdin is EXPLICITLY
 * requested ('-') or, for commands where a prompt is required, when stdin is actually
 * piped (`!isTTY`). For `spawn`, an omitted prompt means "no initial prompt" — we never
 * read stdin opportunistically. Pure + synchronous so it's unit-testable.
 *
 *  - 'literal' : use `value` verbatim as the prompt.
 *  - 'file'    : read the file at `value`.
 *  - 'stdin'   : read from stdin (blocking).
 *  - 'none'    : no prompt (omitted, and we are not allowed to read stdin here).
 *  - 'error'   : a prompt is required but none was provided and stdin is a TTY.
 */
export type PromptSource =
  | { kind: 'literal'; value: string }
  | { kind: 'file'; value: string }
  | { kind: 'stdin' }
  | { kind: 'none' }
  | { kind: 'error' };

export function decidePromptSource(
  arg: string | undefined,
  opts: { requireStdin: boolean; isTTY: boolean },
): PromptSource {
  if (arg === '-') return { kind: 'stdin' };
  if (arg === undefined) {
    if (!opts.requireStdin) return { kind: 'none' };
    // Prompt is required: only read stdin when it's actually piped; otherwise error
    // rather than block forever on a TTY (or on a never-closing pipe via spawn).
    return opts.isTTY ? { kind: 'error' } : { kind: 'stdin' };
  }
  if (arg.startsWith('@')) return { kind: 'file', value: arg.slice(1) };
  return { kind: 'literal', value: arg };
}

/**
 * Resolve a prompt argument to its text (performing I/O per the decided source).
 * `requireStdin` distinguishes commands where the prompt is optional (spawn: omitted →
 * no prompt) from those where it's required (send: omitted → read piped stdin or error).
 */
async function resolvePromptArg(
  arg: string | undefined,
  opts: { requireStdin: boolean } = { requireStdin: false },
): Promise<string | undefined> {
  const source = decidePromptSource(arg, {
    requireStdin: opts.requireStdin,
    isTTY: process.stdin.isTTY === true,
  });
  switch (source.kind) {
    case 'none':
      return undefined;
    case 'error':
      throw new Error(
        "no prompt provided; pass a prompt arg, '-', or @file, or pipe via stdin",
      );
    case 'stdin': {
      const text = await Bun.stdin.text();
      // Treat empty stdin (e.g. `< /dev/null`) as "no prompt" so callers can error
      // cleanly rather than delivering an empty message.
      return text.length > 0 ? text : undefined;
    }
    case 'file': {
      const file = Bun.file(source.value);
      if (!(await file.exists())) {
        throw new Error(`prompt file not found: ${source.value}`);
      }
      return file.text();
    }
    case 'literal':
      return source.value;
  }
}

function jsonFlag(values: Parsed['values']): boolean {
  return values.json === true;
}

async function getSessionForCli(
  idOrName: string,
  json: boolean,
): Promise<Awaited<ReturnType<typeof getSession>> | undefined> {
  try {
    return await getSession(idOrName);
  } catch (e) {
    printError((e as Error).message, json);
    return undefined;
  }
}

export interface ReadFlagValues {
  raw?: string | boolean;
  full?: string | boolean;
  last?: string | boolean;
  index?: string | boolean;
}

export function readSelectionFromFlags(values: ReadFlagValues): TurnSelection {
  const raw = values.raw === true;
  const full = values.full === true;
  const last = values.last === true;
  const hasIndex = values.index !== undefined;

  if (raw && (full || last || hasIndex)) {
    throw new Error('--raw cannot be combined with --full, --last, or --index');
  }

  const selectionFlags = [full, last, hasIndex].filter(Boolean).length;
  if (selectionFlags > 1) {
    throw new Error('--full, --last, and --index are mutually exclusive');
  }

  if (hasIndex) {
    const rawIndex = values.index;
    if (typeof rawIndex !== 'string') {
      throw new Error("invalid --index 'true' (non-negative integer)");
    }
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`invalid --index '${rawIndex}' (non-negative integer)`);
    }
    return { mode: 'index', index };
  }

  if (full) return { mode: 'full' };
  return { mode: 'latest' };
}

async function cmdSpawn(args: string[]): Promise<number> {
  const { values } = parse(args, {
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    agent: { type: 'string' },
    alias: { type: 'string' },
    'system-prompt': { type: 'string' },
    'system-prompt-mode': { type: 'string' },
    prompt: { type: 'string' },
    cwd: { type: 'string' },
    workspace: { type: 'string' },
    worktree: { type: 'boolean' },
    branch: { type: 'string' },
    'no-wait': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);

  const provider = values.provider as Provider | undefined;
  if (!provider) {
    printError('--provider is required (claude|codex|pi)', json);
    return 1;
  }

  const promptRaw = values.prompt as string | undefined;
  let prompt: string | undefined;
  try {
    // spawn: prompt is OPTIONAL. An omitted --prompt means no initial prompt; we never
    // read stdin opportunistically (that hung forever on a never-closing pipe — BUG 1).
    // Explicit '-' / '@file' still work.
    prompt = await resolvePromptArg(promptRaw, { requireStdin: false });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }

  const mode = values['system-prompt-mode'] as SystemPromptMode | undefined;
  if (mode && mode !== 'append' && mode !== 'replace') {
    printError(`invalid --system-prompt-mode '${mode}' (append|replace)`, json);
    return 1;
  }

  const opts: AgentOptions = {
    provider,
    model: values.model as string | undefined,
    agentName: values.agent as string | undefined,
    alias: values.alias as string | undefined,
    systemPrompt: values['system-prompt'] as string | undefined,
    systemPromptMode: mode,
    prompt,
    cwd: values.cwd as string | undefined,
    workspace: values.workspace as string | undefined,
    worktree: values.worktree
      ? values.branch
        ? { branch: values.branch as string }
        : true
      : undefined,
    waitForReady: values['no-wait'] ? false : true,
  };

  try {
    const session = await agent(opts);
    const rec = session.toJSON();
    if (json) {
      printJson(rec);
    } else {
      process.stdout.write(`${renderSessionDetail(rec)}\n`);
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function cmdSend(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('send requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  let prompt: string | undefined;
  try {
    // send: prompt is REQUIRED. If omitted, read piped stdin (!isTTY) or '-'; on a TTY
    // with no arg, error clearly rather than blocking forever on stdin (BUG 1).
    prompt = await resolvePromptArg(positionals[1], { requireStdin: true });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (prompt === undefined) {
    printError(
      "no prompt provided; pass a prompt arg, '-', or @file, or pipe via stdin",
      json,
    );
    return 1;
  }
  try {
    await session.send(prompt);
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson({ ok: true, id: session.id });
  else process.stdout.write(`sent to ${session.id}\n`);
  return 0;
}

async function cmdRead(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    raw: { type: 'boolean' },
    full: { type: 'boolean' },
    last: { type: 'boolean' },
    index: { type: 'string' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  let selection: TurnSelection;
  try {
    selection = readSelectionFromFlags(values);
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('read requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  try {
    // --raw: the full tmux pane (with scrollback) exactly as tmux shows it. The escape
    // hatch for when the parsed transcript isn't enough.
    if (values.raw === true) {
      const pane = await session.capture({ scrollback: true });
      if (json) {
        printJson({ id: session.id, pane });
      } else {
        process.stdout.write(pane.endsWith('\n') ? pane : `${pane}\n`);
      }
      return 0;
    }

    // Default: the token-efficient parsed transcript (conversation + one-line tool
    // summaries) read from the provider's on-disk JSONL.
    const turns = await session.readParsed();
    const selected = selectTurns(turns, selection);
    if (turns.length > 0) {
      if (json) {
        printJson(selected);
      } else {
        process.stdout.write(`${renderTurns(selected)}\n`);
      }
      return 0;
    }

    // Fallback: nothing on disk yet (just booted / nothing written). Show the live
    // pane so `read` always shows something, and flag it so callers can tell.
    const pane = await session.capture();
    if (json) {
      printJson({ id: session.id, fallback: true, pane });
    } else {
      process.stderr.write('(no on-disk transcript yet — showing live pane; --raw for full pane)\n');
      process.stdout.write(pane.endsWith('\n') ? pane : `${pane}\n`);
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function cmdList(args: string[]): Promise<number> {
  const { values } = parse(args, {
    workspace: { type: 'string' },
    all: { type: 'boolean' },
    dead: { type: 'boolean' },
    'all-hosts': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  if (values['all-hosts'] === true) {
    return cmdListAllHosts(values, json);
  }
  const sessions = await listSessions({
    workspace: values.workspace as string | undefined,
    all: values.all === true,
    dead: values.dead === true,
  });
  const views: SessionView[] = await Promise.all(
    sessions.map(async (s) => {
      const status = (await s.status().catch(() => 'dead')) as 'running' | 'dead';
      return { ...s.toJSON(), status };
    }),
  );
  if (json) {
    printJson(views);
  } else {
    process.stdout.write(`${renderSessionList(views)}\n`);
  }
  return 0;
}

/**
 * `orc list --all-hosts` — the fleet view: aggregate local sessions plus every trusted
 * peer's, tagged with a `host` column. Cross-host workspace filtering is meaningless, so
 * this shows ALL sessions on each host unless an explicit `--workspace` is given. An
 * unreachable peer warns to stderr and is skipped (a down host never breaks the view).
 */
async function cmdListAllHosts(values: Parsed['values'], json: boolean): Promise<number> {
  const workspace = values.workspace as string | undefined;
  const dead = values.dead === true;
  const filter = { workspace, all: workspace === undefined ? true : values.all === true, dead };

  const rows: HostSessionView[] = [];
  const local = await listSessions(filter);
  for (const s of local) {
    const status = (await s.status().catch(() => 'dead')) as 'running' | 'dead';
    rows.push({ ...s.toJSON(), status, host: 'local' });
  }

  const peers = await readPeers();
  for (const p of peers) {
    const client = new DaemonClient({ host: p.host, port: p.port ?? DEFAULT_DAEMON_PORT });
    try {
      const remote = await client.listSessions(filter);
      for (const r of remote) rows.push({ ...r, host: p.host });
    } catch (e) {
      process.stderr.write(`warning: peer ${p.host} unreachable: ${(e as Error).message}\n`);
    }
  }

  if (json) printJson(rows);
  else process.stdout.write(`${renderSessionListWithHost(rows)}\n`);
  return 0;
}

async function cmdAttach(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'read-only': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('attach requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  const cmd = session.attachCommand({ readOnly: values['read-only'] === true });
  if (json) {
    printJson({ id: session.id, command: cmd });
    return 0;
  }
  try {
    return await session.attach({ readOnly: values['read-only'] === true });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function cmdKill(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    worktree: { type: 'boolean' },
    purge: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('kill requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  const purge = values.purge === true;
  try {
    await session.kill({ removeWorktree: values.worktree === true, purge });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson({ ok: true, id: session.id, purged: purge });
  else process.stdout.write(`${purge ? 'purged' : 'killed'} ${session.id}\n`);
  return 0;
}

async function cmdPrune(args: string[]): Promise<number> {
  const { values } = parse(args, {
    worktree: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  let removed: string[];
  try {
    removed = await pruneSessions({ removeWorktree: values.worktree === true });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson({ ok: true, pruned: removed });
  else process.stdout.write(`pruned ${removed.length} dead record(s)\n`);
  return 0;
}

// `resolveUntil` (the `--for` → state-set map) lives in state.ts so the daemon route
// mapping can share it without a circular import; re-exported here for the CLI's tests
// and imported at the top of this module for `cmdWait`.
export { resolveUntil };

async function cmdState(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('state requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  let state: AgentState;
  try {
    state = await session.state();
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson({ id: session.id, state });
  else process.stdout.write(`${state}\n`);
  return 0;
}

async function cmdWait(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    for: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('wait requires <id|@alias>', json);
    return 1;
  }
  const forArg = (values.for as string | undefined) ?? 'settled';
  const until = resolveUntil(forArg);
  if (!until) {
    printError(`invalid --for '${forArg}' (done|waiting|failed|settled)`, json);
    return 1;
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const sec = Number(values.timeout);
    if (!Number.isFinite(sec) || sec < 0) {
      printError(`invalid --timeout '${values.timeout}' (seconds)`, json);
      return 1;
    }
    timeoutMs = Math.round(sec * 1000);
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  const startedAt = Date.now();
  let state: AgentState;
  let reached: boolean;
  try {
    const result = await session.waitForResult({ until, timeoutMs });
    state = result.state;
    reached = result.settled;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const elapsedMs = Date.now() - startedAt;
  const timedOut = !reached;
  if (json) {
    printJson({ id: session.id, state, elapsedMs, timedOut });
  } else {
    process.stdout.write(`${state}${timedOut ? ' (timed out)' : ''}\n`);
  }
  return reached ? 0 : 1;
}

/**
 * `orc workflow <sub>` — the only command with a sub-arg. argv[1] is the workflow
 * subcommand (run|list|status); the remainder is that sub's own args.
 */
async function cmdWorkflow(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'run':
      return cmdWorkflowRun(rest);
    case 'list':
      return cmdWorkflowList(rest);
    case 'status':
      return cmdWorkflowStatus(rest);
    case 'attach':
      return cmdWorkflowAttach(rest);
    case 'logs':
      return cmdWorkflowLogs(rest);
    default:
      printError(`unknown workflow subcommand '${sub ?? ''}' (run|list|status|attach|logs)`, false);
      return 1;
  }
}

async function cmdWorkflowRun(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
    'run-id': { type: 'string' },
  });
  const json = jsonFlag(values);
  const file = positionals[0];
  if (!file) {
    printError('workflow run requires <file> (a TS module default-exporting a WorkflowDef)', json);
    return 1;
  }
  const absFile = path.resolve(file);

  // Dynamically import the file. A WorkflowDef is a PLAIN object default-export — the
  // file needs no import to work; runWorkflow VALIDATES the shape. (`defineWorkflow` is
  // an optional typing helper an author may import via a relative path.)
  let def: WorkflowDef;
  try {
    const mod = (await import(absFile)) as { default?: WorkflowDef };
    if (!mod.default) {
      printError(`workflow file '${file}' has no default export`, json);
      return 1;
    }
    def = mod.default;
  } catch (e) {
    printError(`failed to import workflow '${file}': ${(e as Error).message}`, json);
    return 1;
  }

  if (values.detach === true) {
    return cmdWorkflowRunDetached(absFile, def, json);
  }

  let run: WorkflowRun;
  try {
    // Stream step events to stdout in human mode; --json prints only the final record.
    // `--run-id` is the entrypoint a detached runner executes: reuse the id minted by
    // `--detach` and re-thread runnerTmux (the runner re-persists the record from scratch).
    const runId = values['run-id'] as string | undefined;
    run = await runWorkflow(def, {
      runId,
      runnerTmux: runId ? runnerTmuxName(runId) : undefined,
      onEvent: json ? undefined : (e: WorkflowEvent) => process.stdout.write(renderWorkflowEvent(e)),
    });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }

  if (json) printJson(run);
  // Non-zero exit when the run failed, so callers/CI can gate on it.
  return run.status === 'done' ? 0 : 1;
}

/**
 * `--detach`: run the workflow as a detached, reattachable tmux session — consistent with
 * how orc runs agents (reuse the Driver; never nohup a bare process). Mint the runId up
 * front, write an initial `running` record (so `status` resolves immediately), spawn a
 * session `orc-wf-<runId>` whose argv runs the workflow in the FOREGROUND inside it
 * (`<bun> <cli> workflow run <absFile> --run-id <runId>`), then print and exit 0. The
 * detached runner owns the record from there. cwd is THIS invocation's cwd so steps that
 * share cwd behave identically to a foreground run.
 */
async function cmdWorkflowRunDetached(
  absFile: string,
  def: WorkflowDef,
  json: boolean,
): Promise<number> {
  // The parent doesn't call runWorkflow, so validate the def here — a malformed workflow
  // must fail cleanly now, not spawn a doomed runner and hand back a self-orphaning runId.
  try {
    validateWorkflowDef(def);
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }

  const runId = randomUUID().slice(0, 8);
  const runnerTmux = runnerTmuxName(runId);

  const run: WorkflowRun = {
    id: runId,
    name: def.name,
    startedAt: new Date().toISOString(),
    status: 'running',
    runnerTmux,
    steps: [],
  };
  await writeRun(run);

  // process.execPath = the exact bun binary running us → no reliance on the tmux server's
  // PATH resolving `bun`. Thread ORC_HOME so the runner persists to the same runs dir
  // (a new tmux session inherits the server env, not ours).
  const argv = [process.execPath, import.meta.path, 'workflow', 'run', absFile, '--run-id', runId];
  try {
    await getDriver().spawn({
      name: runnerTmux,
      cwd: process.cwd(),
      argv,
      env: { ORC_HOME: orcHome() },
    });
  } catch (e) {
    // Spawn failed → finalize the record we wrote so it doesn't linger as a phantom run.
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    await writeRun(run).catch(() => {});
    printError(`failed to launch detached runner: ${(e as Error).message}`, json);
    return 1;
  }

  if (json) printJson({ runId, runnerTmux });
  else process.stdout.write(`${runId}\n`);
  return 0;
}

async function cmdWorkflowList(args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const runs = await listRuns();
  // Reconcile each stale `running` against its runner's liveness (persists the verdict).
  const reconciled = await Promise.all(runs.map((r) => reconcileRun(r)));
  if (json) printJson(reconciled);
  else process.stdout.write(`${renderRunList(reconciled)}\n`);
  return 0;
}

async function cmdWorkflowStatus(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow status requires <runId>', json);
    return 1;
  }
  const run = await readRun(runId);
  if (!run) {
    printError(`no run found for '${runId}'`, json);
    return 1;
  }
  // Don't trust a stale `running`: if the runner session is gone, report `orphaned`.
  await reconcileRun(run);
  if (json) printJson(run);
  else process.stdout.write(`${renderRunDetail(run)}\n`);
  return 0;
}

async function cmdWorkflowAttach(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'read-only': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow attach requires <runId>', json);
    return 1;
  }
  const run = await readRun(runId);
  if (!run) {
    printError(`no run found for '${runId}'`, json);
    return 1;
  }
  if (!run.runnerTmux) {
    printError(`run '${runId}' has no runner session to attach (it was not run with --detach)`, json);
    return 1;
  }
  const cmd = getDriver().attachCommand(run.runnerTmux, { readOnly: values['read-only'] === true });
  if (json) printJson({ runId, command: cmd });
  else process.stdout.write(`${cmd}\n`);
  return 0;
}

/**
 * `orc workflow logs <runId> [--step <id>] [--raw]` — read the actual work each step's
 * agent did. Default: the full token-efficient parsed transcript per step (the same
 * parsed format as `orc read --full`), labeled `### step <id> (<provider>)`. `--raw` shows the live pane capture
 * instead. `--json` emits `{ step, turns }[]` (parsed) or `{ step, provider, pane }[]` (raw).
 */
async function cmdWorkflowLogs(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    step: { type: 'string' },
    raw: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow logs requires <runId>', json);
    return 1;
  }
  const run = await readRun(runId);
  if (!run) {
    printError(`no run found for '${runId}'`, json);
    return 1;
  }
  const stepId = values.step as string | undefined;

  // Select the step(s) to read; an unknown --step is a clear error.
  let selected: StepResult[] = run.steps;
  if (stepId !== undefined) {
    selected = run.steps.filter((s) => s.id === stepId);
    if (selected.length === 0) {
      const have = run.steps.map((s) => s.id).join(', ') || 'none';
      printError(`run '${runId}' has no step '${stepId}' (steps: ${have})`, json);
      return 1;
    }
  }

  try {
    if (values.raw === true) {
      // Raw: the live tmux pane (with scrollback) of each step's still-alive session.
      const panes: { step: string; provider: StepResult['provider']; pane: string }[] = [];
      for (const s of selected) {
        let pane = '';
        if (s.sessionId) {
          const session = await getSession(s.sessionId);
          if (session) pane = await session.capture({ scrollback: true }).catch(() => '');
        }
        panes.push({ step: s.id, provider: s.provider, pane });
      }
      if (json) {
        printJson(panes);
      } else {
        process.stdout.write(
          `${panes
            .map((p) => `### step ${p.step} (${p.provider})\n${p.pane.trimEnd() || '(no pane — session gone)'}`)
            .join('\n\n')}\n`,
        );
      }
      return 0;
    }

    // Default: each step's parsed transcript, read from the provider's on-disk JSONL.
    const logs = await assembleStepLogs(selected, async (s) => {
      if (!s.sessionId) return [];
      const session = await getSession(s.sessionId);
      if (!session) return [];
      return session.readParsed().catch(() => []);
    });
    if (json) {
      printJson(logs.map((l) => ({ step: l.step, turns: l.turns })));
    } else {
      process.stdout.write(
        `${logs
          .map((l) => `### step ${l.step} (${l.provider})\n${renderTurns(l.turns) || '(no transcript on disk yet)'}`)
          .join('\n\n')}\n`,
      );
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

// ============================================================================
// Daemon + remote (feature 3): the HTTP server, the trusted-peer admin, and the
// `--host` client path. The remote handlers reuse the LOCAL renderers so `--host`
// output is identical to local (`--json` byte-for-byte).
// ============================================================================

/**
 * `orc daemon [--port 8787] [--bind <ip>] [--insecure]` — run the HTTP daemon. Binds to
 * the host's tailscale IP by default (never 0.0.0.0); `resolveBind` refuses an unsafe bind
 * unless `--insecure`. The process blocks here serving forever (Ctrl-C / SIGTERM stops it).
 */
async function cmdDaemon(args: string[]): Promise<number> {
  const { values } = parse(args, {
    port: { type: 'string' },
    bind: { type: 'string' },
    insecure: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);

  let port = DEFAULT_DAEMON_PORT;
  if (values.port !== undefined) {
    const n = Number(values.port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      printError(`invalid --port '${values.port}' (0-65535)`, json);
      return 1;
    }
    port = n;
  }

  const tailscaleIp = await tailscaleIp4();
  const decision = resolveBind({
    bind: values.bind as string | undefined,
    insecure: values.insecure === true,
    tailscaleIp,
  });
  if (!decision.ok) {
    printError(decision.error, json);
    return 1;
  }

  const envSecret = process.env.ORC_DAEMON_SECRET;
  const secret = envSecret && envSecret.length > 0 ? envSecret : null;
  const allowlist = await peerHosts();

  let server: Bun.Server<undefined>;
  try {
    server = serveDaemon({ hostname: decision.address, port, secret });
  } catch (e) {
    printError(`failed to start daemon: ${(e as Error).message}`, json);
    return 1;
  }

  const startup = {
    ok: true,
    bind: decision.address,
    port: server.port,
    insecure: values.insecure === true,
    allowlistedPeers: allowlist.length,
    secretConfigured: secret !== null,
  };
  if (json) {
    printJson(startup);
  } else {
    process.stderr.write(`orc daemon listening on http://${decision.address}:${server.port}\n`);
    if (values.insecure === true) {
      process.stderr.write(
        'WARNING: --insecure bind — the agent-control API may be reachable off-tailnet.\n',
      );
    }
    const mechanisms: string[] = [];
    if (allowlist.length > 0) mechanisms.push(`${allowlist.length} allowlisted peer(s)`);
    if (secret) mechanisms.push('shared secret (x-orc-secret)');
    process.stderr.write(
      mechanisms.length > 0
        ? `trust: ${mechanisms.join(' + ')} (whois preferred; loopback whois cannot resolve)\n`
        : 'trust: NONE configured — every request will 403. Add peers (orc remote add) or set ORC_DAEMON_SECRET.\n',
    );
  }

  const shutdown = (): void => {
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Block forever — returning would let main() process.exit() and tear down the server.
  await new Promise<void>(() => {});
  return 0; // unreachable
}

/** `orc remote add|list|rm <host>` — manage the trusted-peer file (~/.orc/peers.json). */
async function cmdRemoteAdmin(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add': {
      const { values, positionals } = parse(rest, {
        port: { type: 'string' },
        json: { type: 'boolean' },
      });
      const json = jsonFlag(values);
      const host = positionals[0];
      if (!host) {
        printError('remote add requires <host>', json);
        return 1;
      }
      let pport: number | undefined;
      if (values.port !== undefined) {
        const n = Number(values.port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          printError(`invalid --port '${values.port}' (1-65535)`, json);
          return 1;
        }
        pport = n;
      }
      const entry = await addPeer(host, pport);
      if (json) printJson({ ok: true, peer: entry });
      else process.stdout.write(`added peer ${entry.host}${entry.port ? `:${entry.port}` : ''}\n`);
      return 0;
    }
    case 'list': {
      const { values } = parse(rest, { json: { type: 'boolean' } });
      const json = jsonFlag(values);
      const peers = await readPeers();
      if (json) {
        printJson(peers);
      } else {
        process.stdout.write(
          peers.length > 0
            ? `${peers.map((p) => `${p.host}${p.port ? `:${p.port}` : ''}`).join('\n')}\n`
            : '(no peers)\n',
        );
      }
      return 0;
    }
    case 'rm':
    case 'remove': {
      const { values, positionals } = parse(rest, { json: { type: 'boolean' } });
      const json = jsonFlag(values);
      const host = positionals[0];
      if (!host) {
        printError('remote rm requires <host>', json);
        return 1;
      }
      const removed = await removePeer(host);
      if (!removed) {
        printError(`no peer '${host}' to remove`, json);
        return 1;
      }
      if (json) printJson({ ok: true, removed: host });
      else process.stdout.write(`removed peer ${host}\n`);
      return 0;
    }
    default:
      printError(`unknown remote subcommand '${sub ?? ''}' (add|list|rm)`, false);
      return 1;
  }
}

/**
 * Strip a global `--host <h>` / `--host=<h>` flag from argv (it may appear before the
 * subcommand). Returns the host (if any) and the remaining argv. Pure + unit-testable.
 */
export function extractHostFlag(argv: string[]): { host?: string; rest: string[] } {
  const rest: string[] = [];
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--host') {
      host = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--host=')) {
      host = a.slice('--host='.length);
      continue;
    }
    rest.push(a);
  }
  return { ...(host !== undefined ? { host } : {}), rest };
}

/** Dispatch a command to its remote (HTTP) implementation when `--host` is present. */
async function cmdRemote(command: string, host: string, rest: string[]): Promise<number> {
  const target = parseHostArg(host);
  const client = new DaemonClient(target);
  switch (command) {
    case 'list':
      return remoteList(client, rest, target);
    case 'spawn':
      return remoteSpawn(client, rest);
    case 'send':
      return remoteSend(client, rest);
    case 'read':
      return remoteRead(client, rest);
    case 'wait':
      return remoteWait(client, rest);
    case 'state':
      return remoteState(client, rest);
    case 'kill':
      return remoteKill(client, rest);
    case 'attach':
      return remoteAttach(client, rest, target);
    case 'workflow':
      return remoteWorkflow(client, rest, target);
    default:
      printError(`'${command}' is not supported over --host (host-local command)`, false);
      return 1;
  }
}

async function remoteList(client: DaemonClient, args: string[], target: RemoteTarget): Promise<number> {
  const { values } = parse(args, {
    workspace: { type: 'string' },
    all: { type: 'boolean' },
    dead: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  try {
    const views = await client.listSessions({
      workspace: values.workspace as string | undefined,
      all: values.all === true,
      dead: values.dead === true,
    });
    if (json) printJson(views);
    else process.stdout.write(`${renderSessionList(views as SessionView[])}\n`);
    return 0;
  } catch (e) {
    void target;
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteSpawn(client: DaemonClient, args: string[]): Promise<number> {
  const { values } = parse(args, {
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    agent: { type: 'string' },
    alias: { type: 'string' },
    'system-prompt': { type: 'string' },
    'system-prompt-mode': { type: 'string' },
    prompt: { type: 'string' },
    cwd: { type: 'string' },
    workspace: { type: 'string' },
    worktree: { type: 'boolean' },
    branch: { type: 'string' },
    'no-wait': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const provider = values.provider as string | undefined;
  if (!provider) {
    printError('--provider is required (claude|codex|pi)', json);
    return 1;
  }
  let prompt: string | undefined;
  try {
    prompt = await resolvePromptArg(values.prompt as string | undefined, { requireStdin: false });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const mode = values['system-prompt-mode'] as string | undefined;
  if (mode && mode !== 'append' && mode !== 'replace') {
    printError(`invalid --system-prompt-mode '${mode}' (append|replace)`, json);
    return 1;
  }
  const body = {
    provider,
    model: values.model,
    agent: values.agent,
    alias: values.alias,
    systemPrompt: values['system-prompt'],
    systemPromptMode: mode,
    prompt,
    cwd: values.cwd,
    workspace: values.workspace,
    worktree: values.worktree === true ? true : undefined,
    branch: values.branch,
    noWait: values['no-wait'] === true ? true : undefined,
  };
  try {
    const rec = await client.spawn(body);
    if (json) printJson(rec);
    else process.stdout.write(`${renderSessionDetail(rec)}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteSend(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const id = positionals[0];
  if (!id) {
    printError('send requires <id|@alias>', json);
    return 1;
  }
  let prompt: string | undefined;
  try {
    prompt = await resolvePromptArg(positionals[1], { requireStdin: true });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (prompt === undefined) {
    printError("no prompt provided; pass a prompt arg, '-', or @file, or pipe via stdin", json);
    return 1;
  }
  try {
    const r = await client.send(id, prompt);
    if (json) printJson(r);
    else process.stdout.write(`sent to ${r.id}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteRead(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    raw: { type: 'boolean' },
    full: { type: 'boolean' },
    last: { type: 'boolean' },
    index: { type: 'string' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  let selection: TurnSelection;
  try {
    selection = readSelectionFromFlags(values);
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const id = positionals[0];
  if (!id) {
    printError('read requires <id|@alias>', json);
    return 1;
  }
  try {
    const res = await client.read(id, { raw: values.raw === true, selection });
    if (res.kind === 'raw') {
      if (json) printJson({ id: res.id, pane: res.pane });
      else process.stdout.write(res.pane.endsWith('\n') ? res.pane : `${res.pane}\n`);
      return 0;
    }
    if (res.kind === 'parsed') {
      if (json) printJson(res.turns);
      else process.stdout.write(`${renderTurns(res.turns)}\n`);
      return 0;
    }
    // fallback: nothing on disk yet — the daemon returned the live pane.
    if (json) {
      printJson({ id: res.id, fallback: true, pane: res.pane });
    } else {
      process.stderr.write('(no on-disk transcript yet — showing live pane; --raw for full pane)\n');
      process.stdout.write(res.pane.endsWith('\n') ? res.pane : `${res.pane}\n`);
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWait(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    for: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const id = positionals[0];
  if (!id) {
    printError('wait requires <id|@alias>', json);
    return 1;
  }
  const forArg = (values.for as string | undefined) ?? 'settled';
  if (!resolveUntil(forArg)) {
    printError(`invalid --for '${forArg}' (done|waiting|failed|settled)`, json);
    return 1;
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const sec = Number(values.timeout);
    if (!Number.isFinite(sec) || sec < 0) {
      printError(`invalid --timeout '${values.timeout}' (seconds)`, json);
      return 1;
    }
    timeoutMs = Math.round(sec * 1000);
  }
  try {
    const r = await client.wait(id, { for: forArg, timeoutMs });
    if (json) printJson(r);
    else process.stdout.write(`${r.state}${r.timedOut ? ' (timed out)' : ''}\n`);
    return r.timedOut ? 1 : 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteState(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const id = positionals[0];
  if (!id) {
    printError('state requires <id|@alias>', json);
    return 1;
  }
  try {
    const rec = await client.getSession(id);
    if (json) printJson({ id: rec.id, state: rec.state });
    else process.stdout.write(`${rec.state}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteKill(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    worktree: { type: 'boolean' },
    purge: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const id = positionals[0];
  if (!id) {
    printError('kill requires <id|@alias>', json);
    return 1;
  }
  const purge = values.purge === true;
  try {
    const r = await client.kill(id, { worktree: values.worktree === true, purge });
    if (json) printJson(r);
    else process.stdout.write(`${r.purged ? 'purged' : 'killed'} ${r.id}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/**
 * Remote attach is HOST-LOCAL: the tmux session lives on the remote host, so a local
 * `tmux attach` is useless. Print the host + a `tailscale ssh <host>` hint (and the exact
 * `tmux attach` to run once there).
 */
async function remoteAttach(
  client: DaemonClient,
  args: string[],
  target: RemoteTarget,
): Promise<number> {
  const { values, positionals } = parse(args, {
    'read-only': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const id = positionals[0];
  if (!id) {
    printError('attach requires <id|@alias>', json);
    return 1;
  }
  let tmuxName: string | undefined;
  try {
    const rec = await client.getSession(id);
    tmuxName = rec.tmuxName;
  } catch {
    /* still give the ssh hint even if the lookup failed */
  }
  const ssh = `tailscale ssh ${target.host}`;
  const ro = values['read-only'] === true ? ' -r' : '';
  const remoteTmux = `tmux attach${ro} -t ${tmuxName ?? '<tmux-session>'}`;
  if (json) {
    printJson({ id, host: target.host, ssh, command: remoteTmux });
  } else {
    process.stdout.write(
      `# session ${id} lives on ${target.host}; reattach over tailscale:\n` +
        `${ssh}\n# then on ${target.host}:\n${remoteTmux}\n`,
    );
  }
  return 0;
}

async function remoteWorkflow(
  client: DaemonClient,
  args: string[],
  target: RemoteTarget,
): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'run':
      return remoteWorkflowRun(client, rest);
    case 'list':
      return remoteWorkflowList(client, rest);
    case 'status':
      return remoteWorkflowStatus(client, rest);
    case 'logs':
      return remoteWorkflowLogs(client, rest);
    case 'attach':
      return remoteWorkflowAttach(client, rest, target);
    default:
      printError(`unknown workflow subcommand '${sub ?? ''}' (run|list|status|attach|logs)`, false);
      return 1;
  }
}

async function remoteWorkflowRun(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const file = positionals[0];
  if (!file) {
    printError('workflow run requires <file> (an ABSOLUTE path on the remote host)', json);
    return 1;
  }
  try {
    const res = await client.runWorkflow({ file, detach: values.detach === true });
    if (values.detach === true) {
      const r = res as { runId: string; runnerTmux: string };
      if (json) printJson(r);
      else process.stdout.write(`${r.runId}\n`);
      return 0;
    }
    const run = res as WorkflowRun;
    if (json) printJson(run);
    else process.stdout.write(`${renderRunDetail(run)}\n`);
    return run.status === 'done' ? 0 : 1;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowList(client: DaemonClient, args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  try {
    const runs = await client.listRuns();
    if (json) printJson(runs);
    else process.stdout.write(`${renderRunList(runs)}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowStatus(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow status requires <runId>', json);
    return 1;
  }
  try {
    const run = await client.getRun(runId);
    if (json) printJson(run);
    else process.stdout.write(`${renderRunDetail(run)}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowLogs(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    step: { type: 'string' },
    raw: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow logs requires <runId>', json);
    return 1;
  }
  try {
    const res = await client.runLogs(runId, {
      step: values.step as string | undefined,
      raw: values.raw === true,
    });
    if (res.kind === 'raw') {
      if (json) {
        printJson(res.logs);
      } else {
        process.stdout.write(
          `${res.logs
            .map((p) => `### step ${p.step} (${p.provider})\n${p.pane.trimEnd() || '(no pane — session gone)'}`)
            .join('\n\n')}\n`,
        );
      }
      return 0;
    }
    if (json) {
      printJson(res.logs.map((l) => ({ step: l.step, turns: l.turns })));
    } else {
      process.stdout.write(
        `${res.logs
          .map((l) => `### step ${l.step} (${l.provider})\n${renderTurns(l.turns) || '(no transcript on disk yet)'}`)
          .join('\n\n')}\n`,
      );
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowAttach(
  client: DaemonClient,
  args: string[],
  target: RemoteTarget,
): Promise<number> {
  const { values, positionals } = parse(args, {
    'read-only': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow attach requires <runId>', json);
    return 1;
  }
  let runnerTmux: string | undefined;
  try {
    const run = await client.getRun(runId);
    runnerTmux = run.runnerTmux;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (!runnerTmux) {
    printError(`run '${runId}' has no runner session to attach (it was not run with --detach)`, json);
    return 1;
  }
  const ssh = `tailscale ssh ${target.host}`;
  const ro = values['read-only'] === true ? ' -r' : '';
  const remoteTmux = `tmux attach${ro} -t ${runnerTmux}`;
  if (json) {
    printJson({ runId, host: target.host, ssh, command: remoteTmux });
  } else {
    process.stdout.write(
      `# run ${runId} runs on ${target.host}; reattach over tailscale:\n` +
        `${ssh}\n# then on ${target.host}:\n${remoteTmux}\n`,
    );
  }
  return 0;
}

/** Map a raw subcommand (with aliases) to a canonical name. */
export function resolveCommand(raw: string | undefined): string {
  switch (raw) {
    case 'spawn':
    case 'agent':
    case 'new':
      return 'spawn';
    case 'send':
      return 'send';
    case 'read':
      return 'read';
    case 'state':
      return 'state';
    case 'wait':
      return 'wait';
    case 'list':
    case 'ps':
      return 'list';
    case 'attach':
      return 'attach';
    case 'kill':
      return 'kill';
    case 'prune':
      return 'prune';
    case 'workflow':
    case 'wf':
      return 'workflow';
    case 'daemon':
      return 'daemon';
    case 'remote':
      return 'remote';
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return 'help';
    default:
      return 'unknown';
  }
}

async function main(): Promise<number> {
  // Peel a global `--host <h>` (it may precede the subcommand) BEFORE per-command parsing,
  // which is strict on unknown options. When present, the command runs over HTTP.
  const { host, rest: argv } = extractHostFlag(process.argv.slice(2));
  const sub = argv[0];
  const rest = argv.slice(1);
  const command = resolveCommand(sub);

  if (host !== undefined) {
    return cmdRemote(command, host, rest);
  }

  switch (command) {
    case 'spawn':
      return cmdSpawn(rest);
    case 'send':
      return cmdSend(rest);
    case 'read':
      return cmdRead(rest);
    case 'state':
      return cmdState(rest);
    case 'wait':
      return cmdWait(rest);
    case 'list':
      return cmdList(rest);
    case 'attach':
      return cmdAttach(rest);
    case 'kill':
      return cmdKill(rest);
    case 'prune':
      return cmdPrune(rest);
    case 'workflow':
      return cmdWorkflow(rest);
    case 'daemon':
      return cmdDaemon(rest);
    case 'remote':
      return cmdRemoteAdmin(rest);
    case 'help':
      process.stdout.write(HELP_TEXT);
      return 0;
    default:
      process.stderr.write(`unknown command '${sub}'\n\n${HELP_TEXT}`);
      return 1;
  }
}

// Only run the dispatcher when executed as the entry point (not when imported,
// e.g. by unit tests that exercise resolveCommand).
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(1);
    });
}
