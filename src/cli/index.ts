#!/usr/bin/env bun
/**
 * `orc` — the orc CLI dispatcher. Parses the subcommand first, then parses the
 * remainder with that command's own options map (parseArgs is strict on unknowns).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { agent } from '../agent.ts';
import { listSessions, getSession, pruneSessions } from '../index.ts';
import { renderTurns, selectTurns } from '../transcript.ts';
import type { TurnSelection } from '../transcript.ts';
import {
  runWorkflow,
  resumeWorkflow,
  retryWorkflow,
  cancelWorkflow,
  cleanupWorkflow,
  reconcileRun,
  assembleStepLogs,
  validateWorkflowDef,
} from '../workflow.ts';
import {
  awaitRunnerHandoff,
  currentRunnerInfo,
  followRunnerLog,
  launchDetachedRecovery,
  launchDetachedRun,
  trapRunnerTermination,
  RUNNER_FLAG,
} from '../workflow-runner.ts';

import type { WorkflowDef, WorkflowEvent, WorkflowRun, StepResult } from '../workflow.ts';
import { readRun, listRuns } from '../runs.ts';
import { resolveUntil } from '../state.ts';
import { isLoopback, resolveBind } from '../daemon/bind.ts';
import { tailscaleIp4, tailscaleSelf } from '../daemon/tailscale.ts';
import { MCP_PATH, mcpAllowedHosts } from '../mcp/hosts.ts';
import { serveDaemon } from '../daemon/server.ts';
import { loadDaemonTokensFromEnv } from '../daemon/auth.ts';
import type { Scope } from '../daemon/auth.ts';
import { readPeers, addPeer, removePeer, peerHosts, DEFAULT_DAEMON_PORT } from '../daemon/peers.ts';
import { DaemonClient, parseHostArg } from '../daemon/client.ts';
import type { RemoteTarget, DetachedWorkflowLaunch } from '../daemon/client.ts';
import {
  decideHost,
  defaultHostNotice,
  defaultModelsOf,
  loadSettings,
  renderSettingsView,
  resolveSpawnDefaults,
  settingsView,
} from '../settings.ts';
import type { HostDecision, Settings } from '../settings.ts';
import type { AgentOptions, Provider, SystemPromptMode } from '../types.ts';
import type { Session, SessionStateDetail } from '../session.ts';
import type { SendResult } from '../messages.ts';
import { renderJournal } from '../journal-render.ts';
import type { JournalEntry } from '../runtime/types.ts';
import { VERSION } from '../version.ts';
import {
  printJson,
  printError,
  formatError,
  renderSessionDetail,
  renderSessionList,
  renderSessionListWithHost,
  renderWorkflowEvent,
  renderRunDetail,
  publicRunView,
  renderRunList,
  formatWarning,
  renderHelp,
  runnerLogWriter,
  setTerminalStyles,
  terminalStyles,
} from './output.ts';
import type { SessionView, HostSessionView, TerminalStyles } from './output.ts';
import { COLOR_MODES, createStyle, decideColor } from '../style.ts';
import type { ColorMode, Style } from '../style.ts';

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

/** The stdout style (PLAIN until main() decides; JSON output never goes through it). */
function out(): Style {
  return terminalStyles().out;
}

/** The stderr style. */
function err(): Style {
  return terminalStyles().err;
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

/** No provider from --provider or settings.toml. */
const PROVIDER_REQUIRED = '--provider is required (claude|codex|pi), or set `provider` in settings.toml';

async function cmdSpawn(args: string[], settings?: Settings): Promise<number> {
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

  // --provider/--model, else the settings.toml defaults (orc settings shows them).
  const defaults = resolveSpawnDefaults({
    provider: values.provider as string | undefined,
    model: values.model as string | undefined,
    agent: values.agent as string | undefined,
    settings,
  });
  const provider = defaults.provider as Provider | undefined;
  if (!provider) {
    printError(PROVIDER_REQUIRED, json);
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
    model: defaults.model,
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
      process.stdout.write(`${renderSessionDetail(rec, out())}\n`);
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/** D8: acknowledged → 0, queued → 0, unknown → 3, failed → 1. */
export function sendExitCode(phase: SendResult['phase']): number {
  switch (phase) {
    case 'acknowledged':
    case 'queued':
      return 0;
    case 'unknown':
      return 3;
    default:
      return 1;
  }
}

/**
 * `orc --host … send` exit code for a phase from ANY daemon version: a v1 (pre-actor)
 * daemon reports `submitted` for a prompt it wrote but could not yet confirm — delivered
 * as far as v1 knew, so success like v2 `queued`. A missing phase (older v1) = acked.
 */
export function remoteSendExitCode(phase: string | undefined): number {
  switch (phase) {
    case undefined:
    case 'submitted':
      return 0;
    case 'acknowledged':
    case 'queued':
    case 'unknown':
    case 'failed':
      return sendExitCode(phase);
    default:
      return 1;
  }
}

function renderSendResult(id: string, r: { phase: string; messageId?: string; replayed?: boolean }, st: Style): string {
  const replay = r.replayed ? ', replayed' : '';
  const key = r.messageId ? ` [${r.messageId}]` : '';
  return `sent to ${st.id(id)} (${st.tone(r.phase)}${st.muted(replay)})${st.muted(key)}\n`;
}

async function cmdSend(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'idempotency-key': { type: 'string' },
    'no-wake': { type: 'boolean' },
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
  const key = values['idempotency-key'] as string | undefined;
  let r: SendResult;
  try {
    r = await session.send(prompt, {
      ...(key !== undefined ? { messageId: key } : {}),
      ...(values['no-wake'] === true ? { wake: false } : {}),
    });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const code = sendExitCode(r.phase);
  if (json) printJson({ ok: code === 0, id: session.id, ...r });
  else if (code === 0) process.stdout.write(renderSendResult(session.id, r, out()));
  else {
    process.stderr.write(
      formatError(
        r.phase === 'unknown'
          ? `delivery to ${session.id} is unknown (cut before the provider acknowledged it); not re-sent — check \`orc read ${session.id}\` and send again with a new key`
          : `delivery to ${session.id} failed before the provider accepted it`,
        err(),
      ),
    );
  }
  return code;
}

/** Normalized journal entries as JSONL (one entry per line). */
function journalJsonl(entries: JournalEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
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
    // --raw: the session journal (normalized provider events + lifecycle facts). The
    // escape hatch for when the parsed transcript isn't enough.
    if (values.raw === true) {
      const journal = session.journal();
      if (json) {
        printJson({ id: session.id, journal });
      } else if (journal.length > 0) {
        process.stdout.write(`${journalJsonl(journal)}\n`);
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
        process.stdout.write(`${renderTurns(selected, out())}\n`);
      }
      return 0;
    }

    // Fallback: no provider transcript on disk yet. Render the session journal so `read`
    // always shows something, and flag it so callers can tell.
    const journal = session.journal();
    if (json) {
      printJson({ id: session.id, fallback: true, journal });
    } else {
      writeJournalFallback(journal);
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/** `read` with no provider transcript yet: a stderr notice, then the journal rendered as text. */
function writeJournalFallback(journal: JournalEntry[]): void {
  process.stderr.write(`${err().muted('(no on-disk transcript yet — showing the session journal; --raw for JSONL)')}\n`);
  const text = renderJournal(journal, out());
  process.stdout.write(text.length > 0 ? `${text}\n` : `${out().muted('(empty)')}\n`);
}

/** Record + kernel status (D1) + derived state, for list/get views. */
export async function sessionViewOf(s: Session): Promise<SessionView> {
  const d = await s.stateDetail().catch(() => undefined);
  return { ...s.toJSON(), status: d?.status ?? 'dead', ...(d ? { state: d.state } : {}) };
}

async function cmdList(args: string[]): Promise<number> {
  const { values } = parse(args, {
    workspace: { type: 'string' },
    all: { type: 'boolean' },
    dead: { type: 'boolean' },
    'all-hosts': { type: 'boolean' },
    run: { type: 'string' },
    lineage: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  if (values['all-hosts'] === true) {
    return cmdListAllHosts(values, json);
  }
  const runId = typeof values.run === 'string' ? values.run : undefined;
  const sessions = await listSessions({
    workspace: values.workspace as string | undefined,
    all: values.all === true || Boolean(runId),
    dead: values.dead === true,
    runId,
  });
  const views: SessionView[] = await Promise.all(sessions.map(sessionViewOf));
  const showLineage = values.lineage === true || Boolean(runId);
  if (json) {
    printJson(
      views.map((v) => ({
        ...v,
        lineage: {
          rootRunId: v.rootRunId,
          parentRunId: v.parentRunId,
          parentSessionId: v.parentSessionId,
          stepId: v.stepId,
          depth: v.depth,
          owner: v.owner,
        },
      })),
    );
  } else {
    process.stdout.write(`${renderSessionList(views, { lineage: showLineage, style: out() })}\n`);
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
  for (const s of local) rows.push({ ...(await sessionViewOf(s)), host: 'local' });

  const peers = await readPeers();
  for (const p of peers) {
    const client = new DaemonClient({ host: p.host, port: p.port ?? DEFAULT_DAEMON_PORT });
    try {
      const remote = await client.listSessions(filter);
      for (const r of remote) rows.push({ ...r, state: r.state as SessionView['state'], host: p.host });
    } catch (e) {
      process.stderr.write(formatWarning(`peer ${p.host} unreachable: ${(e as Error).message}`, err()));
    }
  }

  if (json) printJson(rows);
  else process.stdout.write(`${renderSessionListWithHost(rows, out())}\n`);
  return 0;
}

/**
 * `orc attach <id>` — follow the session journal rendered as text (prompts, replies,
 * outcomes, lifecycle) until the session stops/suspends or Ctrl-C. Read-only by
 * construction (`--read-only` accepted and ignored). `--json` prints
 * `{id, command, journalPath}` and does not follow.
 */
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
  if (json) {
    printJson({ id: session.id, command: session.attachCommand(), journalPath: session.journalPath() });
    return 0;
  }
  const ac = new AbortController();
  const onInt = () => ac.abort();
  process.once('SIGINT', onInt);
  try {
    return await session.attach({ signal: ac.signal, style: out() });
  } catch (e) {
    printError((e as Error).message, false);
    return 1;
  } finally {
    process.off('SIGINT', onInt);
  }
}

/**
 * `orc resume <id>` — hand a stopped (killed / taken-over) or suspended session back to
 * an actor: clear the sticky stop, wake it (re-checking maxConcurrentSessions) and wait
 * for the provider to be ready. Purged and legacy sessions cannot be resumed.
 */
async function cmdResume(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('resume requires <id|@alias>', json);
    return 1;
  }
  // @alias resolves only active (running/suspended) sessions; a killed or taken-over
  // session is addressed by its id.
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  let d: SessionStateDetail;
  try {
    d = await session.resume();
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson(d);
  else process.stdout.write(`resumed ${out().id(session.id)}: ${out().status(d.state)}\n`);
  return 0;
}

/**
 * `orc takeover <id>` — the escape hatch: stop the actor cleanly (sticky: a send cannot
 * wake a second writer), then print the provider's own resume command for a human.
 * Handback: `orc resume <id>`. `--json` prints `{id, cwd, command}`.
 */
async function cmdTakeover(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('takeover requires <id|@alias>', json);
    return 1;
  }
  const session = await getSessionForCli(idOrName, json);
  if (session === undefined) return 1;
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  try {
    const t = await session.takeover();
    if (json) printJson({ id: t.id, cwd: t.cwd, command: t.command, ...(t.note ? { note: t.note } : {}) });
    else {
      const st = out();
      process.stdout.write(
        `${st.muted(`# orc stopped ${t.id}; continue it yourself with:`)}\n${st.command(t.command)}\n${t.note ? `${st.muted(`# ${t.note}`)}\n` : ''}${st.muted(`# hand it back with: orc resume ${t.id}`)}\n`,
      );
    }
    return 0;
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
  else process.stdout.write(`${purge ? 'purged' : 'killed'} ${out().id(session.id)}\n`);
  return 0;
}

async function cmdPrune(args: string[]): Promise<number> {
  const { values } = parse(args, {
    worktree: { type: 'boolean' },
    suspended: { type: 'boolean' },
    'taken-over': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  let removed: string[];
  try {
    removed = await pruneSessions({
      removeWorktree: values.worktree === true,
      suspended: values.suspended === true,
      takenOver: values['taken-over'] === true,
    });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson({ ok: true, pruned: removed });
  else {
    const what = values.suspended === true ? 'dead/suspended' : 'dead';
    process.stdout.write(`pruned ${out().bold(String(removed.length))} ${what} record(s)\n`);
  }
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
  let d: SessionStateDetail;
  try {
    d = await session.stateDetail();
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (json) printJson(d);
  else {
    const note = d.stopped ? ' (stopped)' : d.suspended ? ' (suspended)' : '';
    process.stdout.write(`${out().status(d.state)}${out().muted(note)}\n`);
  }
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
  let state: string;
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
    process.stdout.write(`${out().status(state)}${timedOut ? out().warning(' (timed out)') : ''}\n`);
  }
  return reached ? 0 : 1;
}

/**
 * `orc workflow <sub>` — the only command with a sub-arg. argv[1] is the workflow
 * subcommand (run|list|status); the remainder is that sub's own args.
 */
async function cmdWorkflow(args: string[], settings?: Settings): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  // settings.toml `[models]`: the steps' default models, fixed when a run STARTS (recorded
  // on the run). resume/retry — and a detached runner — use the record, never settings.
  const defaultModels = settings ? defaultModelsOf(settings) : undefined;
  switch (sub) {
    case 'run':
      return cmdWorkflowRun(rest, defaultModels);
    case 'list':
      return cmdWorkflowList(rest);
    case 'status':
      return cmdWorkflowStatus(rest);
    case 'attach':
      return cmdWorkflowAttach(rest);
    case 'logs':
      return cmdWorkflowLogs(rest);
    case 'resume':
      return cmdWorkflowResume(rest);
    case 'retry':
      return cmdWorkflowRetry(rest);
    case 'cancel':
      return cmdWorkflowCancel(rest);
    case 'cleanup':
      return cmdWorkflowCleanup(rest);
    default:
      printError(
        `unknown workflow subcommand '${sub ?? ''}' (run|list|status|attach|logs|resume|retry|cancel|cleanup)`,
        false,
      );
      return 1;
  }
}

function parseMaxConcurrencyFlag(
  raw: string | undefined,
  json: boolean,
): { ok: true; value?: number } | { ok: false; code: number } {
  if (raw === undefined) return { ok: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    printError(`--max-concurrency must be a positive integer (>= 1), got '${raw}'`, json);
    return { ok: false, code: 1 };
  }
  if (n > 10_000) {
    printError(`--max-concurrency must be <= 10000, got '${raw}'`, json);
    return { ok: false, code: 1 };
  }
  return { ok: true, value: n };
}

type DefaultModels = Partial<Record<Provider, string>>;

async function cmdWorkflowRun(args: string[], defaultModels?: DefaultModels): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
    'run-id': { type: 'string' },
    'max-concurrency': { type: 'string' },
  });
  const json = jsonFlag(values);
  const file = positionals[0];
  if (!file) {
    printError('workflow run requires <file> (a TS module default-exporting a WorkflowDef)', json);
    return 1;
  }
  const conc = parseMaxConcurrencyFlag(values['max-concurrency'] as string | undefined, json);
  if (!conc.ok) return conc.code;
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
    return cmdWorkflowRunDetached(absFile, def, json, conc.value, defaultModels);
  }

  let run: WorkflowRun;
  // `--run-id` is the entrypoint a detached runner executes: reuse the id minted by
  // `--detach` and self-report this process as the run's `runner` (the runner
  // re-persists the record from scratch, stamping its own identity on the lease).
  const runId = values['run-id'] as string | undefined;
  const runner = runId ? await startDetachedRunner(runId, 'run') : undefined;
  // A detached runner runs with what its LAUNCHER recorded (absent = none) — never this
  // host's settings: a daemon launch (over --host) applies no [models], exactly like a
  // foreground daemon run, and a CLI launch already recorded its settings.
  const models = runId ? (await readRun(runId))?.defaultModels : defaultModels;
  const term = trapRunnerTermination();
  try {
    // Stream step events to stdout in human mode; --json prints only the final record.
    run = await runWorkflow(def, {
      runId,
      runner,
      signal: term.signal,
      sourcePath: absFile,
      maxConcurrency: conc.value,
      defaultModels: models,
      onEvent: json ? undefined : (e: WorkflowEvent) => process.stdout.write(renderWorkflowEvent(e, out())),
    });
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  } finally {
    term.dispose();
  }
  if (term.signal.aborted) return runnerTerminated(run);

  if (json) printJson(run);
  // Non-zero exit when the run failed, so callers/CI can gate on it.
  return run.status === 'done' ? 0 : 1;
}

/**
 * A detached runner (`--run-id` / `--runner`) reports itself: a separator line in its
 * log (resumed/retried runners append to the same file) and its `runner` identity —
 * after waiting for the launcher's stamp, so its first owning write follows the handoff.
 */
async function startDetachedRunner(
  runId: string,
  action: string,
): Promise<ReturnType<typeof currentRunnerInfo>> {
  const runner = currentRunnerInfo(runId);
  process.stdout.write(`# orc runner pid=${runner.pid} action=${action} run=${runId} at ${runner.startedAt}\n`);
  if (!(await awaitRunnerHandoff(runId))) {
    process.stdout.write(`# orc runner pid=${runner.pid}: launcher handoff not confirmed; proceeding\n`);
  }
  return runner;
}

/** SIGTERM'd runner (e.g. `orc workflow cancel`): it wrote nothing further; exit 143. */
function runnerTerminated(run: WorkflowRun): number {
  process.stdout.write(`# orc runner pid=${process.pid} terminated (SIGTERM); run ${run.id} ${run.status}\n`);
  return 143;
}

/**
 * `--detach`: run the workflow as a detached runner process. Mint the runId up front,
 * write an initial `running` record (so `status` resolves immediately), spawn
 * `<orc> workflow run <absFile> --run-id <runId>` fully detached (own session, no
 * terminal, output → ~/.orc/runs/<runId>/runner.log), stamp its identity on the record,
 * then print and exit 0. The runner owns the record from there. cwd is THIS
 * invocation's cwd so steps that share cwd behave identically to a foreground run.
 */
async function cmdWorkflowRunDetached(
  absFile: string,
  def: WorkflowDef,
  json: boolean,
  maxConcurrency?: number,
  defaultModels?: DefaultModels,
): Promise<number> {
  try {
    const launch = await launchDetachedRun(def, absFile, { maxConcurrency, defaultModels });
    if (json) printJson({ runId: launch.runId, logPath: launch.logPath });
    else process.stdout.write(`${out().text(launch.runId)}\n`);
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    printError((e as { code?: string }).code === 'RUNNER_SPAWN_FAILED' ? `failed to launch detached runner: ${msg}` : msg, json);
    return 1;
  }
}

async function cmdWorkflowList(args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  const runs = await listRuns();
  // Reconcile each stale `running` against its runner's liveness (persists the verdict).
  const reconciled = await Promise.all(runs.map((r) => reconcileRun(r)));
  if (json) printJson(reconciled.map(publicRunView));
  else process.stdout.write(`${renderRunList(reconciled, out())}\n`);
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
  const reconciled = await reconcileRun(run);
  if (json) printJson(publicRunView(reconciled));
  else process.stdout.write(`${renderRunDetail(reconciled, out())}\n`);
  return 0;
}

/**
 * `orc workflow attach <runId>` — follow a detached run's runner log in-process: print
 * what is there, then tail it until the run is finalized and its runner is gone (or
 * Ctrl-C). `--json` prints `{ runId, logPath, runner }` and does not follow.
 * `--read-only` is accepted and ignored (following is read-only by construction).
 */
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
  if (!run.runner) {
    printError(
      run.legacyRunnerTmux
        ? `run '${runId}' was started by a legacy (pre-actor) runner; it has no runner log`
        : `run '${runId}' has no runner log (it was not run with --detach)`,
      json,
    );
    return 1;
  }
  if (json) {
    printJson({ runId, logPath: run.runner.logPath, runner: run.runner });
    return 0;
  }
  const ac = new AbortController();
  const onInt = () => ac.abort();
  process.once('SIGINT', onInt);
  const follow = runnerLogWriter(out(), (t) => void process.stdout.write(t));
  try {
    const last = await followRunnerLog(runId, { signal: ac.signal, write: follow.write });
    follow.end();
    if (!ac.signal.aborted && last) {
      const st = err();
      process.stderr.write(`${st.muted('# run')} ${st.id(runId)} ${st.status(last.status)}\n`);
    }
    return 0;
  } catch (e) {
    follow.end();
    printError((e as Error).message, false);
    return 1;
  } finally {
    process.off('SIGINT', onInt);
  }
}

/** Journal entries per step shown by `workflow logs --raw`. */
const RAW_JOURNAL_TAIL = 200;

/**
 * `orc workflow logs <runId> [--step <id>] [--raw]` — read the actual work each step's
 * agent did. Default: the full token-efficient parsed transcript per step (the same
 * parsed format as `orc read --full`), labeled `### step <id> (<provider>)`. `--raw` shows
 * each step session's journal tail instead. `--json` emits `{ step, turns }[]` (parsed)
 * or `{ step, provider, journal }[]` (raw).
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
      // Raw: each step session's journal tail (normalized provider events + lifecycle).
      const logs: { step: string; provider: StepResult['provider']; journal: JournalEntry[] }[] = [];
      for (const s of selected) {
        let journal: JournalEntry[] = [];
        if (s.sessionId) {
          const session = await getSession(s.sessionId);
          if (session) journal = session.journal({ tail: RAW_JOURNAL_TAIL });
        }
        logs.push({ step: s.id, provider: s.provider, journal });
      }
      if (json) {
        printJson(logs);
      } else {
        const st = out();
        process.stdout.write(
          `${logs
            .map((l) => `${stepHeading(l.step, l.provider, st)}\n${renderJournal(l.journal, st) || st.muted('(no journal — session gone)')}`)
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
      const st = out();
      process.stdout.write(
        `${logs
          .map((l) => `${stepHeading(l.step, l.provider, st)}\n${renderTurns(l.turns, st) || st.muted('(no transcript on disk yet)')}`)
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

/** Detach a resume/retry into a detached runner process (spawn first, then stamp). */
async function detachWorkflowControl(
  action: 'resume' | 'retry',
  runId: string,
  def: WorkflowDef,
  absFile: string,
  json: boolean,
  stepId?: string,
): Promise<number> {
  try {
    const launch = await launchDetachedRecovery(action, runId, def, absFile, { stepId });
    if (json) printJson({ runId, logPath: launch.logPath, action });
    else process.stdout.write(`${out().text(runId)}\n`);
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    printError(
      (e as { code?: string }).code === 'RUNNER_SPAWN_FAILED' ? `failed to launch detached ${action}: ${msg}` : msg,
      json,
    );
    return 1;
  }
}

async function loadWorkflowDefFromFile(file: string): Promise<{ def: WorkflowDef; absPath: string }> {
  const absPath = path.resolve(file);
  const mod = (await import(absPath)) as { default?: WorkflowDef };
  if (!mod.default) throw new Error(`workflow file '${file}' has no default export`);
  validateWorkflowDef(mod.default);
  return { def: mod.default, absPath };
}

/** `orc workflow resume <runId> [workflowFile] [--detach]` */

/**
 * Refuse resume/retry when reconcile still reports running (owner not proven dead).
 * A detached runner (`--runner`) whose own identity was stamped by its parent is the
 * live owner itself, which is allowed.
 */
async function assertNoLiveOwner(
  runId: string,
  json: boolean,
  opts?: { asRunner?: boolean },
): Promise<WorkflowRun | null> {
  const existing = await readRun(runId);
  if (!existing) {
    printError(`no run found for '${runId}'`, json);
    return null;
  }
  const live = await reconcileRun(existing);
  const isSelf = opts?.asRunner === true && live.runner?.pid === process.pid;
  if (live.status === 'running' && !isSelf) {
    printError(
      `run '${runId}' still has a live owner; wait for it to finish/expire or cancel first`,
      json,
    );
    return null;
  }
  return live;
}

async function cmdWorkflowResume(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
    runner: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  const file = positionals[1];
  if (!runId) {
    printError('workflow resume requires <runId> [workflowFile]', json);
    return 1;
  }
  const asRunner = values.runner === true;
  const runner = asRunner ? await startDetachedRunner(runId, 'resume') : undefined;
  if (!(await assertNoLiveOwner(runId, json, { asRunner }))) return 1;
  if (!file) {
    printError(
      'workflow resume requires the original workflow file (function predicates remain non-portable; prefer verify descriptors)',
      json,
    );
    return 1;
  }
  try {
    const { def, absPath } = await loadWorkflowDefFromFile(file);
    if (values.detach === true) {
      return detachWorkflowControl('resume', runId, def, absPath, json);
    }
    const term = trapRunnerTermination();
    try {
      const run = await resumeWorkflow(runId, def, {
        sourcePath: absPath,
        runner,
        signal: term.signal,
        onEvent: json ? undefined : (e: WorkflowEvent) => process.stdout.write(renderWorkflowEvent(e, out())),
      });
      if (term.signal.aborted) return runnerTerminated(run);
      if (json) printJson(run);
      return run.status === 'done' ? 0 : 1;
    } finally {
      term.dispose();
    }
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/** `orc workflow retry <runId> [--step <id>] [workflowFile] [--detach]` */
async function cmdWorkflowRetry(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
    step: { type: 'string' },
    runner: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  const file = positionals[1];
  if (!runId) {
    printError('workflow retry requires <runId> [--step <id>] [workflowFile]', json);
    return 1;
  }
  const asRunner = values.runner === true;
  const runner = asRunner ? await startDetachedRunner(runId, 'retry') : undefined;
  if (!(await assertNoLiveOwner(runId, json, { asRunner }))) return 1;
  if (!file) {
    printError(
      'workflow retry requires the original workflow file (function predicates remain non-portable; prefer verify descriptors)',
      json,
    );
    return 1;
  }
  try {
    const { def, absPath } = await loadWorkflowDefFromFile(file);
    const stepId = values.step as string | undefined;
    if (values.detach === true) {
      return detachWorkflowControl('retry', runId, def, absPath, json, stepId);
    }
    const term = trapRunnerTermination();
    try {
      const run = await retryWorkflow(runId, def, {
        sourcePath: absPath,
        stepId,
        runner,
        signal: term.signal,
        onEvent: json ? undefined : (e: WorkflowEvent) => process.stdout.write(renderWorkflowEvent(e, out())),
      });
      if (term.signal.aborted) return runnerTerminated(run);
      if (json) printJson(run);
      return run.status === 'done' ? 0 : 1;
    } finally {
      term.dispose();
    }
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/** `orc workflow cancel <runId> [--cascade]` */
async function cmdWorkflowCancel(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    cascade: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow cancel requires <runId>', json);
    return 1;
  }
  try {
    const run = await cancelWorkflow(runId, { cascade: values.cascade === true });
    if (json) printJson(run);
    else process.stdout.write(`${out().tone('cancelled')} ${out().id(run.id)}${out().muted(values.cascade ? ' (cascade)' : '')}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/** `orc workflow cleanup <runId> [--sessions] [--worktrees]` */
async function cmdWorkflowCleanup(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    sessions: { type: 'boolean' },
    worktrees: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow cleanup requires <runId> [--sessions] [--worktrees]', json);
    return 1;
  }
  try {
    const result = await cleanupWorkflow(runId, {
      sessions: values.sessions === true,
      worktrees: values.worktrees === true,
    });
    if (json) printJson(result);
    else {
      const st = out();
      process.stdout.write(
        `cleanup ${st.id(result.runId)}: ${st.label('sessions=')}${result.sessions.length} ${st.label('worktrees=')}${result.worktrees.length}\n`,
      );
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function cmdDaemon(args: string[]): Promise<number> {
  const { values } = parse(args, {
    port: { type: 'string' },
    bind: { type: 'string' },
    insecure: { type: 'boolean' },
    'mcp-allow-host': { type: 'string', multiple: true },
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
  let tokens: Map<string, Scope[]>;
  try {
    tokens = loadDaemonTokensFromEnv();
  } catch (e) {
    printError(`invalid ORC_DAEMON_TOKENS: ${(e as Error).message}`, json);
    return 1;
  }
  const allowlist = await peerHosts();

  // /mcp's DNS-rebinding guard: the names this daemon answers to (the bind address; loopback
  // names on loopback; this node's MagicDNS name + IPs on the tailnet; --mcp-allow-host).
  let mcpHosts: string[];
  try {
    const tailnet = isLoopback(decision.address) ? null : await tailscaleSelf();
    const extra = (values['mcp-allow-host'] as unknown as string[] | undefined) ?? [];
    mcpHosts = mcpAllowedHosts({ bind: decision.address, tailnet, extra });
  } catch (e) {
    printError(`invalid --mcp-allow-host: ${(e as Error).message}`, json);
    return 1;
  }

  let server: Bun.Server<undefined>;
  try {
    server = serveDaemon({ hostname: decision.address, port, secret, tokens, mcp: { allowedHosts: mcpHosts } });
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
    tokensConfigured: tokens.size,
    mcp: { path: MCP_PATH, allowedHosts: mcpHosts },
  };
  if (json) {
    printJson(startup);
  } else {
    const st = err();
    process.stderr.write(`orc daemon listening on ${st.accent(`http://${decision.address}:${server.port}`)}\n`);
    process.stderr.write(
      `${st.label('mcp:')} ${st.accent(`http://${decision.address}:${server.port}${MCP_PATH}`)} ${st.muted(`(Host: ${mcpHosts.join(', ')})`)}\n`,
    );
    if (values.insecure === true) {
      process.stderr.write(
        `${st.warningLabel('WARNING:')} ${st.warning('--insecure bind — the agent-control API may be reachable off-tailnet.')}\n`,
      );
    }
    const mechanisms: string[] = [];
    if (allowlist.length > 0) mechanisms.push(`${allowlist.length} allowlisted peer(s)`);
    if (tokens.size > 0) mechanisms.push(`${tokens.size} scoped bearer token(s)`);
    if (secret) mechanisms.push('legacy shared secret (x-orc-secret, all scopes)');
    process.stderr.write(
      mechanisms.length > 0
        ? `${st.label('auth:')} ${mechanisms.join(' + ')} ${st.muted('(whois preferred; loopback whois cannot resolve)')}\n`
        : `${st.label('auth:')} ${st.warning('NONE configured — every request will 401.')} Add peers (orc remote add), set ORC_DAEMON_TOKENS, or ORC_DAEMON_SECRET.\n`,
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
/**
 * `orc login chatgpt [--import-pi] [--no-browser]` | `orc login status [--json]` — the codex
 * harness's OpenAI credentials (src/codex/login.ts; loaded lazily: it pulls in pi-ai).
 */
async function cmdLogin(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'import-pi': { type: 'boolean' },
    'no-browser': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const what = positionals[0];
  const login = await import('../codex/login.ts');
  if (what === 'status') {
    const s = await login.loginStatus();
    if (json) printJson(s);
    else process.stdout.write(`${login.renderLoginStatus(s, out())}\n`);
    return s.active === 'error' ? 1 : 0;
  }
  if (what === 'chatgpt') {
    return login.loginChatGPT({ importPi: values['import-pi'] === true, noBrowser: values['no-browser'] === true });
  }
  printError(`usage: orc login chatgpt [--import-pi] [--no-browser] | orc login status [--json]`, json);
  return 1;
}

/** `orc logout chatgpt` — remove orc's ChatGPT credential (pi's login is never touched). */
async function cmdLogout(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  if (positionals[0] !== 'chatgpt') {
    printError('usage: orc logout chatgpt', json);
    return 1;
  }
  return (await import('../codex/login.ts')).logoutChatGPT();
}

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
      else process.stdout.write(`added peer ${out().bold(`${entry.host}${entry.port ? `:${entry.port}` : ''}`)}\n`);
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
            ? `${peers.map((p) => out().text(`${p.host}${p.port ? `:${p.port}` : ''}`)).join('\n')}\n`
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
      else process.stdout.write(`removed peer ${out().bold(host)}\n`);
      return 0;
    }
    default:
      printError(`unknown remote subcommand '${sub ?? ''}' (add|list|rm)`, false);
      return 1;
  }
}

/**
 * Strip the global `--host <h>` / `--host=<h>` and `--local` flags from argv (they may
 * appear before the subcommand). Returns the host (if any), `local: true` when `--local`
 * was given, and the remaining argv. Pure + unit-testable.
 */
export function extractHostFlag(argv: string[]): { host?: string; local?: true; rest: string[] } {
  const rest: string[] = [];
  let host: string | undefined;
  let local = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--local') {
      local = true;
      continue;
    }
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
  return { ...(host !== undefined ? { host } : {}), ...(local ? { local: true as const } : {}), rest };
}

/**
 * Strip the global `--color[=WHEN]` / `--no-color` flags from argv, anywhere before a
 * literal `--` (which ends option parsing: it and everything after it are kept verbatim).
 * `--color` alone = always, `--no-color` = never; the last one wins. An invalid WHEN is
 * reported in `error`. Pure + unit-testable.
 */
export function extractColorFlag(argv: string[]): { color?: ColorMode; error?: string; rest: string[] } {
  const rest: string[] = [];
  let color: ColorMode | undefined;
  let error: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--no-color') {
      color = 'never';
      continue;
    }
    if (a === '--color') {
      color = 'always';
      continue;
    }
    if (a.startsWith('--color=')) {
      const when = a.slice('--color='.length);
      if ((COLOR_MODES as readonly string[]).includes(when)) color = when as ColorMode;
      else error = `invalid --color '${when}' (auto|always|never)`;
      continue;
    }
    rest.push(a);
  }
  return { ...(color !== undefined ? { color } : {}), ...(error !== undefined ? { error } : {}), rest };
}

/**
 * A detached workflow runner (`workflow run … --run-id <id>`, `workflow resume|retry …
 * --runner`): its stdout/stderr are the runner log, which stays plain text.
 */
export function isRunnerInvocation(command: string, rest: string[]): boolean {
  return command === 'workflow' && rest.some((a) => a === RUNNER_FLAG || a === '--run-id' || a.startsWith('--run-id='));
}

/**
 * This invocation's per-stream styles. Colour is decided per stream (`decideColor`), but
 * never with `--json` (on either stream: a JSON consumer is a program) and never in a
 * detached runner. Sanitizing (terminal-safe dynamic text) applies whenever the stream is
 * a TTY, colour or not; piped/redirected output is never altered.
 */
export function terminalStylesFor(opts: {
  mode?: ColorMode;
  json: boolean;
  runner: boolean;
  env?: Record<string, string | undefined>;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
}): TerminalStyles {
  const env = opts.env ?? process.env;
  const stream = (isTTY: boolean): Style =>
    createStyle({
      color: !opts.json && !opts.runner && decideColor({ mode: opts.mode, env, isTTY }),
      sanitize: isTTY,
    });
  return {
    out: stream(opts.stdoutIsTTY ?? process.stdout.isTTY === true),
    err: stream(opts.stderrIsTTY ?? process.stderr.isTTY === true),
  };
}

/** `### step <id> (<provider>)`, the per-step heading of `workflow logs`. */
function stepHeading(step: string, provider: string, st: Style): string {
  return `${st.heading(`### step ${step}`)} ${st.muted(`(${provider})`)}`;
}

/**
 * `orc settings [--json]` — the effective settings per key with their source (flag / env /
 * local file / global file / default), the files considered and any warnings. Host-local.
 */
async function cmdSettings(args: string[], opts: { local: boolean }): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  const peers = settings.host?.source === 'local' ? await readPeers() : [];
  const view = settingsView(settings, { local: opts.local, peers });
  if (json) printJson(view);
  else process.stdout.write(`${renderSettingsView(view, out())}\n`);
  return 0;
}

/**
 * `orc mcp [--wait-timeout SEC]` — serve orc's commands as MCP tools over stdio for a lead
 * agent (src/mcp/; loaded lazily: it pulls in the MCP SDK). Host-local. Each tool runs
 * `orc <cmd> … --json`; `wait` returns within --wait-timeout seconds (default 45).
 */
async function cmdMcp(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'wait-timeout': { type: 'string' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  if (positionals.length > 0) {
    printError(`unexpected argument '${positionals[0]}' (usage: orc mcp [--wait-timeout SEC])`, json);
    return 1;
  }
  let waitTimeoutSec = 45;
  if (values['wait-timeout'] !== undefined) {
    const n = Number(values['wait-timeout']);
    if (!Number.isFinite(n) || n < 1 || n > 600) {
      printError(`invalid --wait-timeout '${values['wait-timeout']}' (seconds, 1-600)`, json);
      return 1;
    }
    waitTimeoutSec = n;
  }
  return (await import('../mcp/stdio.ts')).runMcpStdio({ waitTimeoutSec });
}

/** Dispatch a command to its remote (HTTP) implementation when `--host` is present. */
async function cmdRemote(command: string, host: string, rest: string[], settings?: Settings): Promise<number> {
  const target = parseHostArg(host);
  const client = new DaemonClient(target);
  switch (command) {
    case 'list':
      return remoteList(client, rest, target);
    case 'spawn':
      return remoteSpawn(client, rest, settings);
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
    else {
      process.stdout.write(
        `${renderSessionList(
          views.map((v) => ({ ...v, state: v.state as SessionView['state'] })),
          { style: out() },
        )}\n`,
      );
    }
    return 0;
  } catch (e) {
    void target;
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteSpawn(client: DaemonClient, args: string[], settings?: Settings): Promise<number> {
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
  // Defaults resolve on THIS (client) side and are sent explicitly.
  const defaults = resolveSpawnDefaults({
    provider: values.provider as string | undefined,
    model: values.model as string | undefined,
    agent: values.agent as string | undefined,
    settings,
  });
  const provider = defaults.provider;
  if (!provider) {
    printError(PROVIDER_REQUIRED, json);
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
    model: defaults.model,
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
    else process.stdout.write(`${renderSessionDetail(rec, out())}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteSend(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'idempotency-key': { type: 'string' },
    'no-wake': { type: 'boolean' },
    json: { type: 'boolean' },
  });
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
    const key = values['idempotency-key'] as string | undefined;
    const r = await client.send(id, prompt, {
      ...(key !== undefined ? { messageId: key } : {}),
      ...(values['no-wake'] === true ? { wake: false } : {}),
    });
    const phase = r.phase ?? 'acknowledged';
    const code = remoteSendExitCode(r.phase);
    if (json) printJson(r);
    else if (code === 0) process.stdout.write(renderSendResult(r.id, { ...r, phase }, out()));
    else process.stderr.write(formatError(`delivery to ${r.id} ${phase}`, err()));
    return code;
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
    if (res.kind === 'parsed') {
      if (json) printJson(res.turns);
      else process.stdout.write(`${renderTurns(res.turns, out())}\n`);
      return 0;
    }
    if ('pane' in res) {
      // A pre-actor (v1) daemon: it still answers raw/fallback reads with a pane.
      if (json) printJson({ id: res.id, ...(res.kind === 'fallback' ? { fallback: true } : {}), pane: res.pane });
      else {
        const pane = out().text(res.pane);
        process.stdout.write(pane.endsWith('\n') ? pane : `${pane}\n`);
      }
      return 0;
    }
    if (res.kind === 'raw') {
      if (json) printJson({ id: res.id, journal: res.journal });
      else if (res.journal.length > 0) process.stdout.write(`${journalJsonl(res.journal)}\n`);
      return 0;
    }
    // fallback: no transcript on disk yet — the daemon returned the session journal.
    if (json) {
      printJson({ id: res.id, fallback: true, journal: res.journal });
    } else {
      writeJournalFallback(res.journal);
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
    else process.stdout.write(`${out().status(r.state)}${r.timedOut ? out().warning(' (timed out)') : ''}\n`);
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
    if (json) {
      printJson({
        id: rec.id,
        state: rec.state,
        ...(rec.status !== undefined ? { status: rec.status } : {}),
        ...(rec.suspended !== undefined ? { suspended: rec.suspended } : {}),
        ...(rec.stopped !== undefined ? { stopped: rec.stopped } : {}),
      });
    } else {
      const note = rec.stopped ? ' (stopped)' : rec.suspended ? ' (suspended)' : '';
      process.stdout.write(`${out().status(String(rec.state))}${out().muted(note)}\n`);
    }
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
    else process.stdout.write(`${r.purged ? 'purged' : 'killed'} ${out().id(r.id)}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

/**
 * Remote attach is HOST-LOCAL: the session journal lives on the remote host. Print the
 * `tailscale ssh <host> orc attach <id>` command that follows it there.
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
  let resolved = id;
  try {
    resolved = (await client.getSession(id)).id;
  } catch {
    /* still give the ssh hint even if the lookup failed */
  }
  const command = `tailscale ssh ${target.host} orc attach ${resolved}`;
  if (json) {
    printJson({ id: resolved, host: target.host, command });
  } else {
    const st = out();
    process.stdout.write(`${st.muted(`# session ${resolved} lives on ${target.host}; follow it over tailscale:`)}\n${st.command(command)}\n`);
  }
  return 0;
}

/** Type guard: detach launch returns {runId,logPath}; foreground returns WorkflowRun. */
function isDetachedWorkflowLaunch(
  res: WorkflowRun | DetachedWorkflowLaunch,
): res is DetachedWorkflowLaunch {
  return (
    typeof res === 'object' &&
    res !== null &&
    'runId' in res &&
    typeof (res as { runId?: unknown }).runId === 'string' &&
    !('status' in res)
  );
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
    case 'resume':
      return remoteWorkflowResume(client, rest);
    case 'retry':
      return remoteWorkflowRetry(client, rest);
    case 'cancel':
      return remoteWorkflowCancel(client, rest);
    case 'cleanup':
      return remoteWorkflowCleanup(client, rest);
    default:
      printError(
        `unknown workflow subcommand '${sub ?? ''}' (run|list|status|attach|logs|resume|retry|cancel|cleanup)`,
        false,
      );
      return 1;
  }
}

async function remoteWorkflowRun(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    detach: { type: 'boolean' },
    'max-concurrency': { type: 'string' },
  });
  const json = jsonFlag(values);
  const file = positionals[0];
  if (!file) {
    printError('workflow run requires <file> (an ABSOLUTE path on the remote host)', json);
    return 1;
  }
  const conc = parseMaxConcurrencyFlag(values['max-concurrency'] as string | undefined, json);
  if (!conc.ok) return conc.code;
  try {
    const res = await client.runWorkflow({
      file,
      detach: values.detach === true,
      maxConcurrency: conc.value,
    });
    if (isDetachedWorkflowLaunch(res)) {
      if (json) printJson(res);
      else process.stdout.write(`${out().text(res.runId)}\n`);
      return 0;
    }
    if (json) printJson(res);
    else process.stdout.write(`${renderRunDetail(res, out())}\n`);
    return res.status === 'done' ? 0 : 1;
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
    else process.stdout.write(`${renderRunList(runs, out())}\n`);
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
    else process.stdout.write(`${renderRunDetail(run, out())}\n`);
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
        const st = out();
        process.stdout.write(
          `${res.logs
            .map((l) => {
              const body =
                'journal' in l ? renderJournal(l.journal, st) : st.text((l as { pane?: string }).pane?.trimEnd() ?? '');
              return `${stepHeading(l.step, l.provider, st)}\n${body || st.muted('(no journal — session gone)')}`;
            })
            .join('\n\n')}\n`,
        );
      }
      return 0;
    }
    if (json) {
      printJson(res.logs.map((l) => ({ step: l.step, turns: l.turns })));
    } else {
      const st = out();
      process.stdout.write(
        `${res.logs
          .map((l) => `${stepHeading(l.step, l.provider, st)}\n${renderTurns(l.turns, st) || st.muted('(no transcript on disk yet)')}`)
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
  let hasRunner = false;
  try {
    const run = await client.getRun(runId);
    hasRunner = !!run.runner;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  if (!hasRunner) {
    printError(`run '${runId}' has no runner log (it was not run with --detach)`, json);
    return 1;
  }
  // The runner log is host-local: follow it ON the host (`--read-only` is moot).
  const command = `tailscale ssh ${target.host} orc workflow attach ${runId}`;
  if (json) {
    printJson({ runId, host: target.host, command });
  } else {
    const st = out();
    process.stdout.write(`${st.muted(`# run ${runId} runs on ${target.host}; follow its runner log over tailscale:`)}\n${st.command(command)}\n`);
  }
  return 0;
}

/** Map a raw subcommand (with aliases) to a canonical name. */

async function remoteWorkflowResume(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  const file = positionals[1];
  if (!runId) {
    printError('workflow resume requires <runId> [workflowFile]', json);
    return 1;
  }
  try {
    const res = await client.resumeWorkflow(runId, file ? { file } : undefined);
    if ('status' in res) {
      if (json) printJson(res);
      else process.stdout.write(`${renderRunDetail(res, out())}\n`);
      return res.status === 'done' ? 0 : 1;
    }
    // Detached: { runId, logPath, action }
    if (json) printJson(res);
    else process.stdout.write(`${out().text(res.runId)}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowRetry(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    step: { type: 'string' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  const file = positionals[1];
  if (!runId) {
    printError('workflow retry requires <runId> [--step <id>] [workflowFile]', json);
    return 1;
  }
  try {
    const body: { file?: string; step?: string } = {};
    if (file) body.file = file;
    if (values.step) body.step = values.step as string;
    const res = await client.retryWorkflow(runId, body);
    if (res && typeof res === 'object' && 'runId' in res && !('status' in res)) {
      if (json) printJson(res);
      else process.stdout.write(`${out().text((res as { runId: string }).runId)}\n`);
      return 0;
    }
    const run = res as WorkflowRun;
    if (json) printJson(run);
    else process.stdout.write(`${renderRunDetail(run, out())}\n`);
    return run.status === 'done' ? 0 : 1;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowCancel(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    cascade: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow cancel requires <runId>', json);
    return 1;
  }
  try {
    const run = await client.cancelWorkflow(runId, { cascade: values.cascade === true });
    if (json) printJson(run);
    else process.stdout.write(`${renderRunDetail(run, out())}\n`);
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}

async function remoteWorkflowCleanup(client: DaemonClient, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' },
    sessions: { type: 'boolean' },
    worktrees: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const runId = positionals[0];
  if (!runId) {
    printError('workflow cleanup requires <runId> [--sessions] [--worktrees]', json);
    return 1;
  }
  try {
    const result = await client.cleanupWorkflow(runId, {
      sessions: values.sessions === true,
      worktrees: values.worktrees === true,
    });
    if (json) printJson(result);
    else {
      const st = out();
      process.stdout.write(
        `cleaned run ${st.id(result.runId)}: ${st.label('sessions=')}${result.sessions.length} ${st.label('worktrees=')}${result.worktrees.length}\n`,
      );
    }
    return 0;
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
}


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
    case 'resume':
      return 'resume';
    case 'takeover':
      return 'takeover';
    case 'prune':
      return 'prune';
    case 'workflow':
    case 'wf':
      return 'workflow';
    case 'daemon':
      return 'daemon';
    case 'remote':
      return 'remote';
    case 'login':
      return 'login';
    case 'logout':
      return 'logout';
    case 'settings':
      return 'settings';
    case 'mcp':
      return 'mcp';
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return 'help';
    default:
      return 'unknown';
  }
}

/**
 * Commands that run against a daemon over `--host` — and therefore follow a DEFAULT host
 * (ORC_HOST / settings.toml). Everything else is host-local and ignores default hosts.
 */
const REMOTE_CAPABLE: ReadonlySet<string> = new Set([
  'list',
  'spawn',
  'send',
  'read',
  'wait',
  'state',
  'kill',
  'attach',
  'workflow',
]);

/** `orc --version [--json]` (alias `-V`): this binary's version — `orc <v>` or `{version}`. */
function cmdVersion(args: string[]): number {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  const json = jsonFlag(values);
  if (positionals.length > 0) {
    printError(`unexpected argument '${positionals[0]}' (usage: orc --version [--json])`, json);
    return 1;
  }
  if (json) printJson({ version: VERSION });
  else process.stdout.write(`orc ${VERSION}\n`);
  return 0;
}

async function main(): Promise<number> {
  // Hidden: the detached per-session actor (src/runtime/actor-main.ts). Not a user command.
  if (process.argv[2] === '__actor') return (await import('../runtime/actor-main.ts')).runActorMain(process.argv.slice(3));
  // Hidden: the codex harness child the codex runtime spawns (src/codex/harness.ts), and its
  // offline `--self-test` (used to check a compiled binary).
  if (process.argv[2] === '__codex-harness') {
    return (await import('../codex/harness.ts')).runCodexHarnessMain(process.argv.slice(3));
  }
  // Peel the global `--color[=WHEN]` / `--no-color` and `--host <h>` / `--local` (they may
  // precede the subcommand) BEFORE per-command parsing, which is strict on unknown options.
  const colorFlag = extractColorFlag(process.argv.slice(2));
  const { host, local: localFlag, rest: argv } = extractHostFlag(colorFlag.rest);
  const local = localFlag === true;
  const sub = argv[0];
  const rest = argv.slice(1);
  const command = resolveCommand(sub);
  setTerminalStyles(
    terminalStylesFor({
      mode: colorFlag.color,
      json: rest.includes('--json'),
      runner: isRunnerInvocation(command, rest),
    }),
  );
  if (colorFlag.error) {
    printError(colorFlag.error, rest.includes('--json'));
    return 1;
  }
  // `--version` / `-V` is answered before settings are loaded or a host is chosen: it
  // reports THIS binary and never goes remote (not with --host, nor with a default host).
  if (sub === '--version' || sub === '-V') return cmdVersion(rest);

  if (!REMOTE_CAPABLE.has(command)) {
    // Host-local: default hosts never apply (nor error); an explicit --host keeps the
    // "not supported over --host" error unless --local overrides it.
    if (host !== undefined && !local) return cmdRemote(command, host, rest);
    return runLocal(command, sub, rest, { local });
  }

  // Remote-capable: settings give the default host and spawn/workflow defaults.
  const json = rest.includes('--json');
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (e) {
    printError((e as Error).message, json);
    return 1;
  }
  for (const w of settings.warnings) process.stderr.write(`${err().muted('orc:')} ${formatWarning(w, err())}`);

  // `list --all-hosts` is the fleet view from here: never redirected by a default host.
  const allHosts = command === 'list' && host === undefined && rest.includes('--all-hosts');
  const peerCheck = !local && host === undefined && !allHosts && settings.host?.source === 'local';
  const decision: HostDecision = allHosts
    ? { kind: 'local', why: 'none' }
    : decideHost({ local, host, settings, peers: peerCheck ? await readPeers() : [] });
  switch (decision.kind) {
    case 'refused':
      printError(decision.message, json);
      return 1;
    case 'remote':
      // stderr even with --json: stdout stays machine-clean.
      if (!decision.explicit) process.stderr.write(err().muted(defaultHostNotice(decision.host, decision.from)));
      return cmdRemote(command, decision.host, rest, settings);
    case 'local':
      return runLocal(command, sub, rest, { local, settings });
  }
}

/** Run a command on THIS host (`settings` is loaded for remote-capable commands). */
async function runLocal(
  command: string,
  sub: string | undefined,
  rest: string[],
  ctx: { local: boolean; settings?: Settings },
): Promise<number> {
  switch (command) {
    case 'spawn':
      return cmdSpawn(rest, ctx.settings);
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
    case 'resume':
      return cmdResume(rest);
    case 'takeover':
      return cmdTakeover(rest);
    case 'prune':
      return cmdPrune(rest);
    case 'workflow':
      return cmdWorkflow(rest, ctx.settings);
    case 'daemon':
      return cmdDaemon(rest);
    case 'remote':
      return cmdRemoteAdmin(rest);
    case 'login':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout(rest);
    case 'settings':
      return cmdSettings(rest, { local: ctx.local });
    case 'mcp':
      return cmdMcp(rest);
    case 'help':
      process.stdout.write(renderHelp(out()));
      return 0;
    default:
      process.stderr.write(`${err().danger(`unknown command '${sub}'`)}\n\n${renderHelp(err())}`);
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
      // An error that escaped a command (e.g. an option-parse error: strict parseArgs throws
      // before a command's own error handling): with --json, the documented {"error"} shape
      // on stdout; otherwise `fatal:` on stderr.
      const message = (e as Error).message;
      if (process.argv.slice(2).includes('--json')) {
        printError(message, true);
      } else {
        const st = terminalStyles().err;
        process.stderr.write(`${st.errorLabel('fatal:')} ${st.text(message)}\n`);
      }
      process.exit(1);
    });
}
