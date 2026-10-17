/**
 * The orc MCP tool registry. Every tool mirrors one orc CLI command and runs it as a child
 * process (`orc <cmd> … --no-color … --json`, see exec.ts): the CLI's `--json` output is
 * the contract, no command logic is re-implemented here. A tool adds only what an MCP
 * caller needs: a zod input schema, forced non-blocking flags (`spawn --no-wait`,
 * `workflow … --detach`), bounded output, result shaping and error hints.
 *
 * Modes: `stdio` (`orc mcp`, the lead's machine; remote-capable tools take `host` →
 * `orc --host <h> …`) and `daemon` (`orc daemon`'s `/mcp`; every call runs `orc --local …`
 * on the daemon host, paths must be absolute, and each tool needs a daemon scope).
 */
import path from 'node:path';
import { z } from 'zod';
import type { Scope } from '../daemon/auth.ts';
import { resolveUntil } from '../state.ts';
import { renderTurns } from '../transcript.ts';
import type { Turn } from '../transcript.ts';
import { renderJournalEntry } from '../journal-render.ts';
import type { JournalEntry } from '../runtime/types.ts';
import { publicRunView, renderSessionLine } from '../cli/output.ts';
import type { SessionView } from '../cli/output.ts';
import { renderSettingsView } from '../settings.ts';
import type { SettingsView } from '../settings.ts';
import type { WorkflowRun } from '../workflow.ts';
import { childEnv } from './exec.ts';
import type { CliResult, CliRunner } from './exec.ts';
import { guideText, guideTopic, guideTopics } from './guide.ts';
import {
  cliErrorMessage,
  cliFailure,
  compactJson,
  errorResult,
  isRecord,
  keepTail,
  okResult,
  tailWindow,
  textResult,
} from './shape.ts';
import type { ToolResult } from './shape.ts';

export type McpMode = 'stdio' | 'daemon';

/** Per-server configuration the descriptions and schemas depend on. */
export interface ToolConfig {
  mode: McpMode;
  /** `wait`'s default timeout (seconds): `orc mcp --wait-timeout`, default 45. */
  waitTimeoutSec: number;
}

/** What a tool call runs with. */
export interface ToolEnv extends ToolConfig {
  run: CliRunner;
  /** Base environment of the CLI children (daemon credentials are stripped per call). */
  env: Record<string, string | undefined>;
  /** The server's working directory: the default cwd of every CLI child. */
  cwd: string;
}

export interface ToolCtx {
  env: ToolEnv;
  /** Aborted when the MCP request is cancelled: kills the CLI child(ren). */
  signal: AbortSignal;
}

/** MCP tool annotations (hints for clients; see the MCP spec). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

type Shape = z.ZodRawShape;

export interface OrcTool {
  name: string;
  title: string;
  /** Daemon scope the tool needs (the scope of its REST route); null = any authenticated caller. */
  scope: Scope | null;
  modes: readonly McpMode[];
  /** Runs against a peer's daemon in stdio mode when `host` is given (`orc --host`). */
  remote: boolean;
  annotations: ToolAnnotations;
  description(cfg: ToolConfig): string;
  schema(cfg: ToolConfig): z.ZodObject<Shape>;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}

/** `wait` accepts this many ids per call (each is one `orc wait` child process). */
export const MAX_WAIT_IDS = 16;
/** `wait`'s upper bound on timeout_seconds (the CLI's own default). */
export const MAX_WAIT_TIMEOUT_SEC = 600;
/** `read` / `workflow_logs` output bounds. */
export const DEFAULT_MAX_CHARS = 16_000;
export const MAX_MAX_CHARS = 100_000;
/** A system prompt travels in argv (`--system-prompt=`): stay far below the per-argument limit. */
export const MAX_SYSTEM_PROMPT_CHARS = 32_000;
/** Safety net for one CLI child (a `wait` child gets its timeout + this). */
const CALL_TIMEOUT_MS = 180_000;
const WAIT_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------------------

/** A positional value: never starts with `-` (no option injection), no whitespace. */
const TOKEN = /^[^\s-]\S*$/;

const sessionRef = (): z.ZodString =>
  z
    .string()
    .min(1)
    .max(200)
    .regex(TOKEN, 'a session id, @alias or @workspace:alias (no spaces; not starting with -)')
    .describe('session id (short or full), @alias, or @workspace:alias');

const runRef = (): z.ZodString =>
  z.string().min(1).max(200).regex(TOKEN, 'a workflow run id (no spaces; not starting with -)').describe('workflow run id');

const hostField = (cfg: ToolConfig): Shape =>
  cfg.mode === 'stdio'
    ? {
        host: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^\s/-][^\s/]*$/, 'a host or host:port')
          .optional()
          .describe("run this call on that peer's orc daemon (host or host:port); omit to run here"),
      }
    : {};

const filePath = (what: string): z.ZodString =>
  z.string().min(1).max(4096).regex(/^[^-]/, 'a path (not starting with -)').describe(what);

const maxChars = (): z.ZodDefault<z.ZodNumber> =>
  z
    .number()
    .int()
    .min(1_000)
    .max(MAX_MAX_CHARS)
    .default(DEFAULT_MAX_CHARS)
    .describe(`output budget in characters (default ${DEFAULT_MAX_CHARS}); beyond it the start is cut and the end kept`);

// ---------------------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------------------

interface OrcOpts {
  host?: string;
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run `orc [--local | --host=<h>] --no-color <args…> --json`. Daemon mode always runs
 * locally (`--local`: a default host in settings must not bounce the call elsewhere);
 * stdio mode adds `--host` only when the caller asked for one, so orc's own host routing
 * applies exactly as if the lead ran `orc` itself.
 */
export function orcArgs(mode: McpMode, args: readonly string[], host?: string): string[] {
  const pre = mode === 'daemon' ? ['--local'] : host !== undefined ? [`--host=${host}`] : [];
  return [...pre, '--no-color', ...args, '--json'];
}

function orc(ctx: ToolCtx, args: string[], opts: OrcOpts = {}): Promise<CliResult> {
  const { env } = ctx;
  const host = env.mode === 'stdio' ? opts.host : undefined;
  return env.run({
    args: orcArgs(env.mode, args, host),
    stdin: opts.stdin,
    cwd: opts.cwd ?? env.cwd,
    env: childEnv(env.env, { remote: host !== undefined }),
    signal: opts.signal ?? ctx.signal,
    timeoutMs: opts.timeoutMs ?? CALL_TIMEOUT_MS,
  });
}

/** `--name=value` (the `=` form: a value starting with `-` is never read as an option). */
function opt(out: string[], name: string, value: string | number | undefined): void {
  if (value !== undefined) out.push(`--${name}=${value}`);
}

function flag(out: string[], name: string, on: boolean | undefined): void {
  if (on === true) out.push(`--${name}`);
}

/** A successful CLI call returned a JSON value that is not an `{error}` document. */
function succeeded(r: CliResult): boolean {
  return r.code === 0 && r.json !== undefined && cliErrorMessage(r.json) === undefined;
}

/**
 * Daemon mode: a path argument must be absolute (the daemon's own cwd is arbitrary), and
 * `required` ones must be present. Stdio mode: no constraint (null).
 */
function needAbsolute(env: ToolEnv, field: string, value: string | undefined, required = false): ToolResult | null {
  if (env.mode !== 'daemon') return null;
  const hint = "the daemon's own working directory is arbitrary: pass the absolute path of the project directory.";
  if (value === undefined) return required ? errorResult(`${field} is required on the daemon (an absolute path on its host)`, hint) : null;
  return path.isAbsolute(value) ? null : errorResult(`${field} must be an absolute path on the daemon host (got '${value}')`, hint);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------

const PROVIDERS = ['claude', 'codex', 'pi'] as const;

const spawnTool: OrcTool = {
  name: 'spawn',
  title: 'Spawn an agent session',
  scope: 'sessions:write',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description: (cfg) =>
    `Start a coding agent as a durable background session and return at once (never blocks): {id, alias, provider, model, cwd, worktreePath, branch}. The prompt is queued and delivered when the agent is ready; then call wait with the id, and read its answer. Pick provider/model per role (fast and cheap to gather context, strongest to implement, a different model or provider to judge); settings shows the configured defaults, used when you omit them. worktree: true gives the agent its own git worktree and branch (cwd must be inside a git repository): use it for code-writing agents whose slices may touch the same files. alias names the session (e.g. impl-auth); agent (a named agent definition) and system_prompt are mutually exclusive.` +
    (cfg.mode === 'daemon'
      ? ' cwd is required and must be an absolute path on the daemon host.'
      : ' Relative cwd/workspace resolve against this server\'s directory.'),
  schema: (cfg) =>
    z.object({
      provider: z.enum(PROVIDERS).optional().describe('claude | codex | pi (default: settings)'),
      model: z.string().min(1).max(200).optional().describe('model name (default: settings [models], else the provider default)'),
      prompt: z.string().min(1).optional().describe('the task: goal, context, constraints, how to verify, what to deliver'),
      alias: z.string().min(1).max(64).optional().describe('workspace-scoped handle, e.g. impl-auth (then @impl-auth)'),
      agent: z.string().min(1).max(200).optional().describe('named agent definition (exclusive with system_prompt)'),
      system_prompt: z
        .string()
        .min(1)
        .max(MAX_SYSTEM_PROMPT_CHARS)
        .optional()
        .describe('role framing added to the system prompt (put long instructions in prompt)'),
      system_prompt_mode: z.enum(['append', 'replace']).optional().describe('append (default) or replace the provider system prompt'),
      cwd:
        cfg.mode === 'daemon'
          ? z.string().min(1).max(4096).describe('absolute base directory on the daemon host')
          : z.string().min(1).max(4096).optional().describe('base directory (default: this server\'s)'),
      workspace: z.string().min(1).max(4096).optional().describe('workspace key (default: the git toplevel of cwd)'),
      worktree: z.boolean().optional().describe('run in a fresh git worktree on its own branch'),
      branch: z.string().min(1).max(200).optional().describe('worktree branch name (needs worktree: true)'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const cwd = str(a.cwd);
    const bad = needAbsolute(ctx.env, 'cwd', cwd, true) ?? needAbsolute(ctx.env, 'workspace', str(a.workspace));
    if (bad) return bad;
    if (a.branch !== undefined && a.worktree !== true) return errorResult('branch needs worktree: true');
    const args = ['spawn'];
    opt(args, 'provider', str(a.provider));
    opt(args, 'model', str(a.model));
    opt(args, 'agent', str(a.agent));
    opt(args, 'alias', str(a.alias));
    opt(args, 'system-prompt', str(a.system_prompt));
    opt(args, 'system-prompt-mode', str(a.system_prompt_mode));
    if (a.prompt !== undefined) args.push('--prompt=-');
    opt(args, 'cwd', cwd);
    opt(args, 'workspace', str(a.workspace));
    flag(args, 'worktree', a.worktree as boolean | undefined);
    opt(args, 'branch', str(a.branch));
    args.push('--no-wait');
    const r = await orc(ctx, args, {
      host: str(a.host),
      stdin: str(a.prompt),
      cwd: ctx.env.mode === 'daemon' ? cwd : undefined,
    });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc spawn');
    const rec = r.json;
    const id = String(rec.id);
    const parts = [
      `spawned ${id}`,
      rec.alias ? `alias @${String(rec.alias)}` : undefined,
      `provider ${String(rec.provider)}`,
      rec.model ? `model ${String(rec.model)}` : undefined,
      `cwd ${String(rec.cwd)}`,
      rec.branch ? `branch ${String(rec.branch)}` : undefined,
    ].filter(Boolean);
    const next = a.prompt !== undefined ? `next: wait {"ids":["${id}"]}, then read.` : `next: send it the task, then wait.`;
    return okResult(rec, `${parts.join(', ')}\n${next}\n${compactJson(rec)}`);
  },
};

const sendTool: OrcTool = {
  name: 'send',
  title: 'Send a prompt to a session',
  scope: 'sessions:write',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description: () =>
    'Send a follow-up prompt to a session: a correction, the judge\'s findings, the next task. Returns {ok, phase, messageId, replayed}: acknowledged = the agent accepted it; queued = it is delivered when the current turn ends. After send, the state stays running until that turn ends, so call wait next (race-free). A suspended session is woken (wake: false only queues). Pass idempotency_key when you may retry: a repeat with the same key and text is a no-op (replayed: true). An error with phase unknown means delivery is uncertain and is never retried by orc: read the session first, then send again with a NEW key.',
  schema: (cfg) =>
    z.object({
      id: sessionRef(),
      prompt: z.string().min(1).describe('the message, delivered verbatim as one prompt'),
      idempotency_key: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('message id: a repeat with the same key and text is not sent twice'),
      wake: z.boolean().default(true).describe('wake a suspended session (default true); false only queues'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const args = ['send', String(a.id), '-'];
    opt(args, 'idempotency-key', str(a.idempotency_key));
    if (a.wake === false) args.push('--no-wake');
    const r = await orc(ctx, args, { host: str(a.host), stdin: String(a.prompt) });
    const res = r.json;
    if (isRecord(res) && typeof res.phase === 'string' && cliErrorMessage(res) === undefined) {
      if (r.code === 0) {
        const replay = res.replayed === true ? ' (replayed: already sent with this key; nothing re-sent)' : '';
        return okResult(res, `sent to ${String(res.id)}: ${res.phase}${replay}\nnext: wait {"ids":["${String(res.id)}"]}\n${compactJson(res)}`);
      }
      if (res.phase === 'unknown') {
        return errorResult(
          `delivery to ${String(res.id)} is unknown: it was cut before the agent acknowledged it, and orc does not re-send it`,
          'read the session to see whether it landed; if not, send again with a NEW idempotency_key.',
          res,
        );
      }
      return errorResult(`delivery to ${String(res.id)} failed (${res.phase}) before the agent accepted it`, 'check state; resume the session if it is stopped.', res);
    }
    return cliFailure(r, 'orc send');
  },
};

interface WaitEntry {
  id: string;
  state?: string;
  reached: boolean;
  timedOut: boolean;
  elapsedMs?: number;
  error?: string;
  /** The session id a ref (e.g. @alias) resolved to, when it differs. */
  resolvedId?: string;
}

/** One id's outcome from its `orc wait --json` child. */
function waitEntryOf(ref: string, r: CliResult): WaitEntry {
  const j = r.json;
  if (isRecord(j) && typeof j.state === 'string' && cliErrorMessage(j) === undefined) {
    const timedOut = j.timedOut === true;
    const e: WaitEntry = {
      id: ref,
      state: j.state,
      reached: r.code === 0 && !timedOut,
      timedOut,
      ...(typeof j.elapsedMs === 'number' ? { elapsedMs: j.elapsedMs } : {}),
    };
    if (typeof j.id === 'string' && j.id !== ref) e.resolvedId = j.id;
    return e;
  }
  const failed = cliFailure(r, `orc wait ${ref}`);
  return { id: ref, reached: false, timedOut: false, error: String(failed.structuredContent?.error ?? 'wait failed') };
}

const waitTool: OrcTool = {
  name: 'wait',
  title: 'Wait for sessions to settle',
  scope: 'sessions:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: (cfg) =>
    `Block until sessions settle, bounded: returns within timeout_seconds (default ${cfg.waitTimeoutSec}) even if they are still running. That is NOT an error: call wait again with the pending ids. for: settled (default: done, waiting or failed) | done | waiting | failed. Pass several ids to watch a parallel team: mode all (default) returns when every id has settled, mode any as soon as one has (then leave settled ids out of the next call). done means the agent yielded and awaits input, not that it succeeded: read its last turn and verify the evidence. Up to ${MAX_WAIT_IDS} ids.`,
  schema: (cfg) =>
    z.object({
      ids: z.array(sessionRef()).min(1).max(MAX_WAIT_IDS).describe('session ids (or @aliases) to wait for'),
      for: z.enum(['settled', 'done', 'waiting', 'failed']).default('settled').describe('the state(s) to wait for (default settled)'),
      timeout_seconds: z
        .number()
        .min(0)
        .max(MAX_WAIT_TIMEOUT_SEC)
        .default(cfg.waitTimeoutSec)
        .describe(`return after this many seconds at most (default ${cfg.waitTimeoutSec}; clients time out tool calls after ~60 s)`),
      mode: z.enum(['all', 'any']).default('all').describe('with several ids: all (default) or any'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const ids = [...new Set(a.ids as string[])];
    const forArg = String(a.for);
    const timeoutSec = Number(a.timeout_seconds);
    const mode = ids.length > 1 ? String(a.mode) : 'all';
    const host = str(a.host);
    const until = resolveUntil(forArg) ?? [];
    const started = Date.now();
    const children = new AbortController();
    const onAbort = (): void => children.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const entries = new Map<string, WaitEntry>();
    try {
      const waitOne = (id: string): Promise<CliResult> =>
        orc(ctx, ['wait', id, `--for=${forArg}`, `--timeout=${timeoutSec}`], {
          host,
          signal: children.signal,
          timeoutMs: timeoutSec * 1000 + WAIT_GRACE_MS,
        });
      if (mode === 'all') {
        await Promise.all(ids.map(async (id) => entries.set(id, waitEntryOf(id, await waitOne(id)))));
      } else {
        // any: the first id to reach the state ends the call; the others are stopped and
        // reported with a fresh state snapshot.
        let finished = false;
        await new Promise<void>((resolve) => {
          let open = ids.length;
          const finish = (): void => {
            finished = true;
            resolve();
          };
          for (const id of ids) {
            void waitOne(id).then((r) => {
              if (!finished && !r.aborted) {
                const e = waitEntryOf(id, r);
                entries.set(id, e);
                if (e.reached) finish();
              }
              if (--open === 0) finish();
            });
          }
        });
        children.abort();
        const rest = ids.filter((id) => !entries.has(id));
        await Promise.all(
          rest.map(async (id) => {
            const s = await orc(ctx, ['state', id], { host });
            const j = s.json;
            if (succeeded(s) && isRecord(j) && typeof j.state === 'string') {
              entries.set(id, { id, state: j.state, reached: until.includes(j.state as never), timedOut: false });
            } else {
              const failed = cliFailure(s, `orc state ${id}`);
              entries.set(id, { id, reached: false, timedOut: false, error: String(failed.structuredContent?.error ?? 'state failed') });
            }
          }),
        );
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (ctx.signal.aborted) return errorResult('wait was cancelled');

    const list = ids.map((id) => entries.get(id)!);
    const reached = list.filter((e) => e.reached).map((e) => e.id);
    const errored = list.filter((e) => e.error !== undefined);
    const pending = list.filter((e) => !e.reached && e.error === undefined).map((e) => e.id);
    const elapsedMs = Date.now() - started;
    const structured = {
      for: forArg,
      mode,
      timeoutSeconds: timeoutSec,
      elapsedMs,
      reached,
      pending,
      sessions: list,
    };
    if (errored.length === list.length) {
      return errorResult(errored.map((e) => `${e.id}: ${e.error}`).join('\n'), 'check the ids with list.', structured);
    }
    const lines = list.map((e) => {
      const who = e.resolvedId ? `${e.id} (${e.resolvedId})` : e.id;
      if (e.error !== undefined) return `  ${who}  error: ${e.error}`;
      const note = e.reached ? '' : e.timedOut ? '  (still running; timed out)' : '  (not yet)';
      return `  ${who}  ${e.state ?? '?'}${note}`;
    });
    const head = `${reached.length} of ${list.length} reached ${forArg} after ${(elapsedMs / 1000).toFixed(1)}s:`;
    const next: string[] = [];
    if (reached.length > 0) next.push('read the settled sessions (done is not success: verify the evidence)');
    if (pending.length > 0) next.push(`call wait again for ${pending.join(', ')}`);
    return okResult(structured, [head, ...lines, ...(next.length ? [`next: ${next.join('; ')}.`] : [])].join('\n'));
  },
};

/** Render one transcript turn exactly as `orc read` prints it. */
const renderTurn = (t: Turn): string => renderTurns([t]);
const trimTurn = (t: Turn, keep: number): Turn => ({ ...t, text: keepTail(t.text, Math.max(1, keep - 14)) });

/** A truncation note: what was cut and how to page. */
function cutNote(w: { totalChars: number; shownChars: number }, how: string): string {
  return `[cut: showing the last ${w.shownChars} of ${w.totalChars} characters; ${how}]`;
}

/** structuredContent fields of a cut window (it must explain itself: some clients show only it). */
function cutFields(w: { truncated: boolean; totalChars: number; shownChars: number }, how: string): Record<string, unknown> {
  return w.truncated ? { truncated: true, totalChars: w.totalChars, note: cutNote(w, how) } : {};
}

const readTool: OrcTool = {
  name: 'read',
  title: "Read a session's transcript",
  scope: 'sessions:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    `Read a session's transcript, token-efficient (each tool call is summarized on one line). Default: the latest conversation turn, which after wait is the agent's answer. full: true returns the whole transcript; index: N (0-based) one turn; raw: true the session journal (lifecycle and provider events, for debugging). Output beyond max_chars (default ${DEFAULT_MAX_CHARS}) keeps the end and says how much was cut. Before a provider transcript exists, read returns the session journal instead (fallback: true).`,
  schema: (cfg) =>
    z.object({
      id: sessionRef(),
      index: z.number().int().min(0).optional().describe('one conversation turn, 0-based (default: the latest)'),
      full: z.boolean().optional().describe('the whole transcript'),
      raw: z.boolean().optional().describe('the session journal instead of the transcript'),
      max_chars: maxChars(),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const args = ['read', String(a.id)];
    opt(args, 'index', a.index as number | undefined);
    flag(args, 'full', a.full as boolean | undefined);
    flag(args, 'raw', a.raw as boolean | undefined);
    const r = await orc(ctx, args, { host: str(a.host) });
    if (!succeeded(r)) return cliFailure(r, 'orc read');
    const max = Number(a.max_chars);
    const j = r.json;
    const page = a.full === true ? 'read one turn with index, or raise max_chars' : 'raise max_chars to see more';
    if (Array.isArray(j)) {
      const turns = j as Turn[];
      if (turns.length === 0) return okResult({ id: String(a.id), kind: 'transcript', turns: [] }, '(no turns yet)');
      const w = tailWindow(turns, renderTurn, max, trimTurn);
      const text = w.truncated ? `${cutNote(w, page)}\n${w.text}` : w.text;
      return okResult(
        { id: String(a.id), kind: 'transcript', turns: w.items, ...cutFields(w, page) },
        text,
      );
    }
    if (isRecord(j) && Array.isArray(j.journal)) {
      const journal = j.journal as JournalEntry[];
      const raw = a.raw === true;
      const render = raw ? (e: JournalEntry) => JSON.stringify(e) : (e: JournalEntry) => renderJournalEntry(e) ?? '';
      const shown = raw ? journal : journal.filter((e) => renderJournalEntry(e) !== null);
      const w = tailWindow(shown, render, max);
      const kind = raw ? 'journal' : 'fallback';
      const head = raw ? '' : '(no provider transcript yet: the session journal)\n';
      const text = `${w.truncated ? `${cutNote(w, 'raise max_chars to see more')}\n` : ''}${head}${w.text || '(empty)'}`;
      return okResult(
        { id: String(j.id ?? a.id), kind, ...(j.fallback === true ? { fallback: true } : {}), journal: w.items, ...cutFields(w, 'raise max_chars to see more') },
        text,
      );
    }
    if (isRecord(j) && typeof j.pane === 'string') {
      // A pre-actor (v1) daemon over host.
      const text = keepTail(j.pane, max);
      return okResult({ id: String(j.id ?? a.id), kind: 'pane', pane: text }, text);
    }
    return okResult(isRecord(j) ? j : { value: j }, compactJson(j));
  },
};

/** What a state means for the lead (one line). */
function stateAdvice(d: Record<string, unknown>): string {
  switch (d.state) {
    case 'starting':
    case 'running':
      return 'working: wait for it.';
    case 'done':
      return 'yielded and awaiting input (not necessarily success): read its last turn and verify.';
    case 'waiting':
      return 'it asked for a permission, which orc denied: read what it tried and re-instruct it.';
    case 'failed':
      if (d.suspended === true) return 'its process died; it is resumable: send wakes it, or call resume.';
      if (d.stopped === true) return 'killed or taken over: call resume if you still need it.';
      return 'the last turn failed (see lastTurn.error): send a correction or spawn a fresh agent.';
    default:
      return '';
  }
}

const stateTool: OrcTool = {
  name: 'state',
  title: "A session's state",
  scope: 'sessions:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    "A session's state, without waiting: {state, status, stopped, suspended, live, pendingMessages, lastTurn, ...}. state: starting | running | done | waiting | failed. failed + suspended: true = its process died (send or resume wakes it); failed + stopped: true = killed or taken over (resume); failed otherwise = the last turn failed (lastTurn.error). Prefer wait to polling state.",
  schema: (cfg) => z.object({ id: sessionRef(), ...hostField(cfg) }),
  async run(a, ctx) {
    const r = await orc(ctx, ['state', String(a.id)], { host: str(a.host) });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc state');
    const d = r.json;
    return okResult(d, `${String(d.id ?? a.id)}: ${String(d.state)} (${String(d.status ?? '?')}) — ${stateAdvice(d)}\n${compactJson(d)}`);
  },
};

const listTool: OrcTool = {
  name: 'list',
  title: 'List sessions',
  scope: 'sessions:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: (cfg) =>
    'List sessions with their status and state. Default: the running, suspended and spawning sessions of the current workspace; all: true = every workspace, dead ones included; dead: true adds dead ones; workspace filters; run_id lists a workflow run\'s sessions (with lineage). Before finishing, list and kill whatever you spawned that is no longer needed.' +
    (cfg.mode === 'daemon'
      ? ' Daemon: without workspace or run_id it lists every workspace (dead included); workspace must be an absolute path.'
      : ' With host only workspace, all and dead apply.'),
  schema: (cfg) =>
    z.object({
      workspace: z.string().min(1).max(4096).optional().describe('only this workspace (path or key)'),
      all: z.boolean().optional().describe('every workspace, dead sessions included'),
      dead: z.boolean().optional().describe('include dead sessions'),
      run_id: z.string().min(1).max(200).optional().describe("a workflow run's sessions"),
      lineage: z.boolean().optional().describe('show workflow lineage'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const bad = needAbsolute(ctx.env, 'workspace', str(a.workspace));
    if (bad) return bad;
    const host = str(a.host);
    if (host !== undefined && (a.run_id !== undefined || a.lineage === true)) {
      return errorResult('list over host supports workspace, all and dead only');
    }
    const args = ['list'];
    opt(args, 'workspace', str(a.workspace));
    const all = a.all === true || (ctx.env.mode === 'daemon' && a.workspace === undefined && a.run_id === undefined);
    flag(args, 'all', all);
    flag(args, 'dead', a.dead as boolean | undefined);
    opt(args, 'run', str(a.run_id));
    flag(args, 'lineage', a.lineage as boolean | undefined);
    const r = await orc(ctx, args, { host });
    if (!succeeded(r) || !Array.isArray(r.json)) return cliFailure(r, 'orc list');
    const rows = r.json as SessionView[];
    const lineage = a.lineage === true || a.run_id !== undefined;
    const lines = rows.map((v) => renderSessionLine(v, { lineage }));
    const text =
      rows.length === 0
        ? `(no sessions)${all ? '' : ' — all: true includes other workspaces and dead sessions'}`
        : `${rows.length} session(s):\n${lines.join('\n')}`;
    return okResult({ sessions: rows }, text);
  },
};

const killTool: OrcTool = {
  name: 'kill',
  title: 'Stop a session',
  scope: 'admin',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    'Stop a session; sticky: it is never woken again unless you resume it. Messages still queued for it are dropped. Its record and journal are kept (read still works); purge: true deletes them; worktree: true removes its git worktree checkout (the branch and its commits are kept). Kill each session once its slice is accepted or abandoned.',
  schema: (cfg) =>
    z.object({
      id: sessionRef(),
      worktree: z.boolean().optional().describe('also remove its worktree checkout (the branch is kept)'),
      purge: z.boolean().optional().describe('also delete its record and journal'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const args = ['kill', String(a.id)];
    flag(args, 'worktree', a.worktree as boolean | undefined);
    flag(args, 'purge', a.purge as boolean | undefined);
    const r = await orc(ctx, args, { host: str(a.host) });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc kill');
    const d = r.json;
    return okResult(d, `${d.purged === true ? 'purged' : 'killed'} ${String(d.id)}`);
  },
};

const resumeTool: OrcTool = {
  name: 'resume',
  title: 'Resume a stopped or suspended session',
  scope: 'sessions:write',
  modes: ['stdio', 'daemon'],
  remote: false,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: () =>
    'Hand a killed, taken-over or suspended session back to an agent process and wait until it is ready; returns its state. Use it to continue a session you stopped, or to recover one whose process died (send also wakes a suspended session). Purged and legacy sessions cannot be resumed. Runs on this host only.',
  schema: () => z.object({ id: sessionRef() }),
  async run(a, ctx) {
    const r = await orc(ctx, ['resume', String(a.id)]);
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc resume');
    const d = r.json;
    return okResult(d, `resumed ${String(d.id ?? a.id)}: ${String(d.state)} (${String(d.status ?? '?')})`);
  },
};

const pruneTool: OrcTool = {
  name: 'prune',
  title: 'Remove dead sessions',
  scope: 'admin',
  modes: ['stdio', 'daemon'],
  remote: false,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    "Remove the records and journals of every dead session on this host (not only yours). worktree: true also removes their worktree checkouts; suspended: true also stops and removes suspended sessions; taken_over: true includes sessions a human took over. Run it last, after killing your sessions. Runs on this host only.",
  schema: () =>
    z.object({
      worktree: z.boolean().optional().describe('also remove their worktree checkouts'),
      suspended: z.boolean().optional().describe('also stop and remove suspended sessions'),
      taken_over: z.boolean().optional().describe('also remove sessions a human took over'),
    }),
  async run(a, ctx) {
    const args = ['prune'];
    flag(args, 'worktree', a.worktree as boolean | undefined);
    flag(args, 'suspended', a.suspended as boolean | undefined);
    flag(args, 'taken-over', a.taken_over as boolean | undefined);
    const r = await orc(ctx, args);
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc prune');
    const d = r.json;
    const pruned = Array.isArray(d.pruned) ? (d.pruned as unknown[]) : [];
    return okResult(d, `pruned ${pruned.length} record(s)${pruned.length ? `: ${pruned.join(', ')}` : ''}`);
  },
};

const settingsTool: OrcTool = {
  name: 'settings',
  title: 'Effective orc settings',
  scope: 'sessions:read',
  modes: ['stdio', 'daemon'],
  remote: false,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: (cfg) =>
    'This host\'s effective orc settings with their sources: the default provider, the default model per provider ([models]) and the default remote host. spawn uses these defaults when you omit provider/model: call it to choose models per role. cwd: the directory whose project .orc/settings.toml applies' +
    (cfg.mode === 'daemon' ? ' (an absolute path; default: the daemon\'s directory).' : " (default: this server's)."),
  schema: () => z.object({ cwd: z.string().min(1).max(4096).optional().describe('directory whose project settings apply') }),
  async run(a, ctx) {
    const cwdArg = str(a.cwd);
    const bad = needAbsolute(ctx.env, 'cwd', cwdArg);
    if (bad) return bad;
    const cwd = cwdArg !== undefined ? path.resolve(ctx.env.cwd, cwdArg) : undefined;
    const r = await orc(ctx, ['settings'], { cwd });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc settings');
    let rendered: string;
    try {
      rendered = renderSettingsView(r.json as unknown as SettingsView);
    } catch {
      rendered = compactJson(r.json);
    }
    return okResult(r.json, rendered);
  },
};

const guideTool: OrcTool = {
  name: 'guide',
  title: "The lead's playbook",
  scope: null,
  modes: ['stdio', 'daemon'],
  remote: false,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    "The lead's playbook (markdown): the team method in depth (roles, what each prompt must contain, the judge's rubric, the accept/reject loop), slicing work, choosing models, waiting and reading, integrating branches, workflows, failure handling, cleanup, remote hosts and limits. Call it once before your first spawn. topic returns one section (e.g. team, failures, cleanup).",
  schema: () =>
    z.object({
      topic: z.string().min(1).max(64).optional().describe(`one section: ${guideTopics().join(', ')}`),
    }),
  async run(a) {
    // Text only: a client that shows structuredContent instead of the text must still see the playbook.
    const topic = str(a.topic);
    if (topic === undefined) return textResult(guideText());
    const text = guideTopic(topic);
    if (text === null) return errorResult(`no guide section matches '${topic}'`, `topics: ${guideTopics().join(', ')}`);
    return textResult(text);
  },
};

// ---- workflows --------------------------------------------------------------------------

const workflowRunTool: OrcTool = {
  name: 'workflow_run',
  title: 'Run a workflow in the background',
  scope: 'workflows:write',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description: (cfg) =>
    'Start a workflow file in the background (always detached) and return {runId, logPath} at once. A workflow is a TypeScript file default-exporting {name, steps[]}: each step is an agent with a prompt, optional needs (ordering), worktree and a verify check. Use it for repeatable multi-step processes; spawn ad hoc when you must judge between steps. Then poll workflow_status and read each step\'s work with workflow_logs. Steps without their own cwd run in cwd.' +
    (cfg.mode === 'daemon'
      ? ' file and cwd must be absolute paths on the daemon host.'
      : ' Relative paths resolve against this server\'s directory; with host, file is an absolute path on that host and cwd does not apply.'),
  schema: (cfg) =>
    z.object({
      file: filePath('the workflow file (TypeScript, default-exporting {name, steps})'),
      cwd:
        cfg.mode === 'daemon'
          ? z.string().min(1).max(4096).describe('absolute directory the run starts in')
          : z.string().min(1).max(4096).optional().describe("directory the run starts in (default: this server's)"),
      max_concurrency: z.number().int().min(1).max(10_000).optional().describe('steps that may run at once (default: the file\'s, else 1)'),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const host = str(a.host);
    let file = String(a.file);
    let cwd = str(a.cwd);
    const bad = needAbsolute(ctx.env, 'file', file) ?? needAbsolute(ctx.env, 'cwd', cwd, true);
    if (bad) return bad;
    if (host !== undefined) {
      if (cwd !== undefined) return errorResult('cwd cannot be combined with host (the remote daemon decides where the run starts)');
    } else {
      file = path.resolve(ctx.env.cwd, file);
      if (cwd !== undefined) cwd = path.resolve(ctx.env.cwd, cwd);
    }
    const args = ['workflow', 'run', file, '--detach'];
    opt(args, 'max-concurrency', a.max_concurrency as number | undefined);
    const r = await orc(ctx, args, { host, cwd });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc workflow run');
    const d = r.json;
    return okResult(d, `started run ${String(d.runId)}\nnext: workflow_status {"run_id":"${String(d.runId)}"}; workflow_logs for what each step did.\n${compactJson(d)}`);
  },
};

const workflowListTool: OrcTool = {
  name: 'workflow_list',
  title: 'List workflow runs',
  scope: 'workflows:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    'List workflow runs, newest first, with their status (running | done | failed | orphaned | cancelled) and step results. A running run whose runner died is reported orphaned.',
  schema: (cfg) => z.object({ ...hostField(cfg) }),
  async run(a, ctx) {
    const r = await orc(ctx, ['workflow', 'list'], { host: str(a.host) });
    if (!succeeded(r) || !Array.isArray(r.json)) return cliFailure(r, 'orc workflow list');
    const runs = r.json as Record<string, unknown>[];
    const lines = runs.map((run) => {
      const steps = Array.isArray(run.steps) ? (run.steps as Record<string, unknown>[]) : [];
      const ok = steps.filter((s) => s.ok === true).length;
      return `${String(run.id)}  ${String(run.status)}  ${String(run.name)}  steps=${ok}/${steps.length}  ${String(run.startedAt ?? '')}`;
    });
    return okResult({ runs }, runs.length === 0 ? '(no runs)' : `${runs.length} run(s):\n${lines.join('\n')}`);
  },
};

const workflowStatusTool: OrcTool = {
  name: 'workflow_status',
  title: "A workflow run's status",
  scope: 'workflows:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    "A workflow run's record: status (running | done | failed | orphaned | cancelled), each step's result (ok, state, sessionId, worktree, branch, unverified), scheduling and attempts. Poll it after workflow_run; orphaned (the runner died) is recoverable with workflow_resume.",
  schema: (cfg) => z.object({ run_id: runRef(), ...hostField(cfg) }),
  async run(a, ctx) {
    const r = await orc(ctx, ['workflow', 'status', String(a.run_id)], { host: str(a.host) });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc workflow status');
    const d = r.json;
    const steps = Array.isArray(d.steps) ? (d.steps as Record<string, unknown>[]) : [];
    const stepLines = steps.map(
      (s) =>
        `  [${s.ok === true ? 'ok' : s.state === undefined ? '..' : 'FAIL'}] ${String(s.id)} (${String(s.provider)}) state=${String(s.state ?? '-')}${s.sessionId ? ` session=${String(s.sessionId)}` : ''}${s.branch ? ` branch=${String(s.branch)}` : ''}${s.unverified ? ' UNVERIFIED' : ''}`,
    );
    return okResult(d, [`run ${String(d.id)} '${String(d.name)}': ${String(d.status)}`, ...stepLines, compactJson(d)].join('\n'));
  },
};

const workflowLogsTool: OrcTool = {
  name: 'workflow_logs',
  title: "What a workflow run's steps did",
  scope: 'workflows:read',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    `What each step's agent did: per-step parsed transcripts (### step <id>). step limits it to one step; raw: true returns each step session's journal tail instead. Output beyond max_chars (default ${DEFAULT_MAX_CHARS}) keeps the end; read one step at a time for long runs.`,
  schema: (cfg) =>
    z.object({
      run_id: runRef(),
      step: z.string().min(1).max(200).optional().describe('one step id'),
      raw: z.boolean().optional().describe('journal tails instead of transcripts'),
      max_chars: maxChars(),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const args = ['workflow', 'logs', String(a.run_id)];
    opt(args, 'step', str(a.step));
    flag(args, 'raw', a.raw as boolean | undefined);
    const r = await orc(ctx, args, { host: str(a.host) });
    if (!succeeded(r) || !Array.isArray(r.json)) return cliFailure(r, 'orc workflow logs');
    const logs = r.json as Record<string, unknown>[];
    interface StepBlock {
      log: Record<string, unknown>;
      head: string;
      body: string;
      cut?: boolean;
    }
    const blocks: StepBlock[] = logs.map((l) => {
      const head = `### step ${String(l.step)}${l.provider ? ` (${String(l.provider)})` : ''}`;
      if (Array.isArray(l.journal)) {
        const body = (l.journal as JournalEntry[])
          .map((e) => renderJournalEntry(e))
          .filter((x): x is string => x !== null)
          .join('\n');
        return { log: l, head, body: body || '(no journal: session gone)' };
      }
      const turns = Array.isArray(l.turns) ? (l.turns as Turn[]) : [];
      return { log: l, head, body: renderTurns(turns) || '(no transcript on disk yet)' };
    });
    // A step cut to fit keeps its heading and the end of its body.
    const w = tailWindow(
      blocks,
      (b) => `${b.head}\n${b.body}`,
      Number(a.max_chars),
      (b, keep) => ({ ...b, body: keepTail(b.body, Math.max(1, keep - b.head.length - 1)), cut: true }),
    );
    // structuredContent keeps whole steps only.
    const whole = w.items.filter((b) => b.cut !== true).map((b) => b.log);
    const how = 'pass step to read one step at a time, or raise max_chars';
    const text = w.truncated ? `${cutNote(w, how)}\n${w.text}` : w.text;
    return okResult(
      {
        logs: whole,
        ...cutFields(w, how),
        ...(w.truncated ? { omittedSteps: logs.filter((l) => !whole.includes(l)).map((l) => l.step) } : {}),
      },
      text || '(no steps)',
    );
  },
};

/** resume/retry run in the background (`--detach`); over --host the CLI cannot detach them. */
function recoveryTool(action: 'resume' | 'retry'): OrcTool {
  const isRetry = action === 'retry';
  return {
    name: `workflow_${action}`,
    title: isRetry ? "Retry a workflow run's failed steps" : 'Resume a workflow run',
    scope: 'workflows:write',
    modes: ['stdio', 'daemon'],
    remote: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: (cfg) =>
      (isRetry
        ? "Start new attempts for a run's failed or incomplete steps in the background (step: that step and the steps after it); the attempt history is kept."
        : 'Resume an incomplete, failed or orphaned run in the background: steps that succeeded are skipped, in-flight ones are adopted.') +
      ` file is the original workflow file (its plan must still match). Returns {runId, logPath, action} at once; then poll workflow_status. Runs on this host only.${cfg.mode === 'daemon' ? ' file must be an absolute path on the daemon host.' : ''}`,
    schema: () =>
      z.object({
        run_id: runRef(),
        file: filePath('the original workflow file'),
        ...(isRetry ? { step: z.string().min(1).max(200).optional().describe('retry from this step') } : {}),
      }),
    async run(a, ctx) {
      let file = String(a.file);
      const bad = needAbsolute(ctx.env, 'file', file);
      if (bad) return bad;
      file = path.resolve(ctx.env.cwd, file);
      const args = ['workflow', action, String(a.run_id), file];
      if (isRetry) opt(args, 'step', str(a.step));
      args.push('--detach');
      const r = await orc(ctx, args);
      if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, `orc workflow ${action}`);
      const d = r.json;
      return okResult(d, `${action} of run ${String(d.runId)} started in the background\nnext: workflow_status {"run_id":"${String(d.runId)}"}\n${compactJson(d)}`);
    },
  };
}

const workflowCancelTool: OrcTool = {
  name: 'workflow_cancel',
  title: 'Cancel a workflow run',
  scope: 'admin',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    'Cancel a workflow run (idempotent): its runner is stopped and no new step starts. cascade: true also kills the sessions the run provably owns (never others). Returns the run in the workflow_status shape.',
  schema: (cfg) =>
    z.object({ run_id: runRef(), cascade: z.boolean().optional().describe("also kill the run's own sessions"), ...hostField(cfg) }),
  async run(a, ctx) {
    const args = ['workflow', 'cancel', String(a.run_id)];
    flag(args, 'cascade', a.cascade as boolean | undefined);
    const r = await orc(ctx, args, { host: str(a.host) });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc workflow cancel');
    // The public projection, as workflow_status returns it (no plan prompts).
    const view = publicRunView(r.json as unknown as WorkflowRun);
    return okResult(view, `run ${String(view.id)}: ${String(view.status)}${a.cascade === true ? ' (cascade)' : ''}`);
  },
};

const workflowCleanupTool: OrcTool = {
  name: 'workflow_cleanup',
  title: "Remove a workflow run's sessions and worktrees",
  scope: 'admin',
  modes: ['stdio', 'daemon'],
  remote: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  description: () =>
    'Remove what a workflow run owns: sessions: true kills its sessions, worktrees: true removes their worktrees. Only sessions and worktrees the run provably owns are touched.',
  schema: (cfg) =>
    z.object({
      run_id: runRef(),
      sessions: z.boolean().optional().describe("kill the run's sessions"),
      worktrees: z.boolean().optional().describe("remove the run's worktrees"),
      ...hostField(cfg),
    }),
  async run(a, ctx) {
    const args = ['workflow', 'cleanup', String(a.run_id)];
    flag(args, 'sessions', a.sessions as boolean | undefined);
    flag(args, 'worktrees', a.worktrees as boolean | undefined);
    const r = await orc(ctx, args, { host: str(a.host) });
    if (!succeeded(r) || !isRecord(r.json)) return cliFailure(r, 'orc workflow cleanup');
    const d = r.json;
    const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    return okResult(d, `cleaned run ${String(d.runId)}: sessions=${n(d.sessions)} worktrees=${n(d.worktrees)}`);
  },
};

/** Every tool, in the order `tools/list` shows them. */
export const TOOLS: readonly OrcTool[] = [
  guideTool,
  spawnTool,
  sendTool,
  waitTool,
  readTool,
  stateTool,
  listTool,
  killTool,
  resumeTool,
  pruneTool,
  settingsTool,
  workflowRunTool,
  workflowListTool,
  workflowStatusTool,
  workflowLogsTool,
  recoveryTool('resume'),
  recoveryTool('retry'),
  workflowCancelTool,
  workflowCleanupTool,
];

/** The orc commands deliberately NOT exposed as tools (see the guide's `excluded`). */
export const EXCLUDED_COMMANDS: readonly string[] = [
  'attach',
  'workflow attach',
  'takeover',
  'login',
  'logout',
  'daemon',
  'remote',
  'mcp',
  'help',
];

export function toolsForMode(mode: McpMode): OrcTool[] {
  return TOOLS.filter((t) => t.modes.includes(mode));
}
