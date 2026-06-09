#!/usr/bin/env bun
/**
 * `agi` — the orc CLI dispatcher. Parses the subcommand first, then parses the
 * remainder with that command's own options map (parseArgs is strict on unknowns).
 */
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { agent } from '../agent.ts';
import { listSessions, getSession, pruneSessions } from '../index.ts';
import { renderTurns } from '../transcript.ts';
import type { AgentOptions, Provider, SystemPromptMode } from '../types.ts';
import {
  printJson,
  printError,
  renderSessionDetail,
  renderSessionList,
  HELP_TEXT,
} from './output.ts';
import type { SessionView } from './output.ts';

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

async function cmdSpawn(args: string[]): Promise<number> {
  const { values } = parse(args, {
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    agent: { type: 'string' },
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
    printError('send requires <id|name>', json);
    return 1;
  }
  const session = await getSession(idOrName);
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
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('read requires <id|name>', json);
    return 1;
  }
  const session = await getSession(idOrName);
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
    if (turns.length > 0) {
      if (json) {
        printJson(turns);
      } else {
        process.stdout.write(`${renderTurns(turns)}\n`);
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
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
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

async function cmdAttach(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'read-only': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const json = jsonFlag(values);
  const idOrName = positionals[0];
  if (!idOrName) {
    printError('attach requires <id|name>', json);
    return 1;
  }
  const session = await getSession(idOrName);
  if (!session) {
    printError(`no session found for '${idOrName}'`, json);
    return 1;
  }
  const cmd = session.attachCommand({ readOnly: values['read-only'] === true });
  if (json) printJson({ id: session.id, command: cmd });
  else process.stdout.write(`${cmd}\n`);
  return 0;
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
    printError('kill requires <id|name>', json);
    return 1;
  }
  const session = await getSession(idOrName);
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
    case 'list':
    case 'ps':
      return 'list';
    case 'attach':
      return 'attach';
    case 'kill':
      return 'kill';
    case 'prune':
      return 'prune';
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
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  const command = resolveCommand(sub);

  switch (command) {
    case 'spawn':
      return cmdSpawn(rest);
    case 'send':
      return cmdSend(rest);
    case 'read':
      return cmdRead(rest);
    case 'list':
      return cmdList(rest);
    case 'attach':
      return cmdAttach(rest);
    case 'kill':
      return cmdKill(rest);
    case 'prune':
      return cmdPrune(rest);
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
