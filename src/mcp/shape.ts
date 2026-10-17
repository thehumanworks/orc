/**
 * Shaping CLI results into MCP tool results: the success/error envelopes, error hints, and
 * the bounded (tail-windowed) rendering of transcripts and journals. Pure.
 */
import type { CliResult } from './exec.ts';

/** A tool result (structurally an MCP `CallToolResult`). */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Compact JSON in `content` is cut beyond this (structuredContent keeps everything). */
export const MAX_JSON_TEXT_CHARS = 24_000;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A successful result: `text` for the model, `structured` for programs. Some clients (Codex
 * CLI, VS Code) show the model `structuredContent` INSTEAD of the text when it is present,
 * so `structured` must stand on its own; a result whose substance is prose (the guide)
 * uses textResult.
 */
export function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** A successful text-only result (no structuredContent: every client shows the text). */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** An error result (`isError: true`): the message, then an optional hint. */
export function errorResult(message: string, hint?: string, structured?: Record<string, unknown>): ToolResult {
  const text = hint ? `${message}\nhint: ${hint}` : message;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { error: message, ...(hint ? { hint } : {}), ...(structured ?? {}) },
    isError: true,
  };
}

/** `value` as one-line JSON, cut (with a note) beyond `max` characters. */
export function compactJson(value: unknown, max = MAX_JSON_TEXT_CHARS): string {
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [cut: ${text.length - max} more characters; structuredContent has all of it]`;
}

/** A remote daemon refused the caller's identity/credentials. */
const UNAUTHORIZED = /unauthorized: (authentication required|invalid credentials)/;

/** Known CLI error messages → what the lead should do next. */
const HINTS: ReadonlyArray<[RegExp, string]> = [
  [
    /no session found/,
    'list the sessions (all: true includes dead ones and other workspaces). An @alias resolves only in its own workspace: prefer the id that spawn returned.',
  ],
  [/provider is required/, 'pass provider (claude|codex|pi), or configure a default provider (the settings tool shows it).'],
  [/orc resume|is stopped|was stopped/, 'the session was killed or taken over: call resume first.'],
  [/different prompt/, 'that idempotency_key was already used with different text: use a new key.'],
  [
    UNAUTHORIZED,
    'the daemon on that host refused this caller: it must trust this machine (orc remote add on that host), or accept the bearer token in ORC_DAEMON_TOKEN. Never change trust settings yourself: report it.',
  ],
  [/lacks required scope/, 'that daemon accepts this caller but not this action; ask the user for a token with that scope.'],
  [/no run found/, 'check the run id with workflow_list.'],
  [/requires the original workflow file/, 'pass file: the path of the workflow file the run was started from.'],
  [/still has a live owner/, 'the run is still running (workflow_status shows it); cancel it first to resume or retry.'],
  [/agentName .* not found/, 'define the agent (.claude/agents/<name>.md, or .codex/agents/ for codex) or pass system_prompt instead.'],
  [/not a git repo|inside a git repo|git repository/, 'worktree: true needs cwd inside a git repository.'],
  [/out of range/, 'read without index returns the latest turn; full: true returns every turn.'],
  [/not supported over --host/, 'call it without host (it runs on this machine only).'],
];

/** A call without `host` that orc routed to a default host (ORC_HOST / settings.toml `host`). */
export interface DefaultHostRoute {
  host: string;
  /** ORC_HOST, or the settings file that set it. */
  from: string;
}

/** The notice `orc: → <host> (from <source>)` the CLI prints on stderr when it follows a default host. */
export function defaultHostRoute(stderr: string): DefaultHostRoute | undefined {
  const m = /^orc: → (\S+) \(from (.+)\)$/m.exec(stderr);
  return m ? { host: m[1]!, from: m[2]! } : undefined;
}

export function hintFor(message: string, ctx: { route?: DefaultHostRoute } = {}): string | undefined {
  if (ctx.route && UNAUTHORIZED.test(message)) {
    // Calls without host never carry daemon credentials (by design), so a peer that needs a
    // token refuses them even when ORC_DAEMON_TOKEN is set.
    return (
      `this call had no host, so orc followed the default host ${ctx.route.host} (from ${ctx.route.from}), and a call without host carries no daemon credentials: ` +
      `pass host: "${ctx.route.host}" explicitly so ORC_DAEMON_TOKEN / ORC_DAEMON_SECRET are sent, or have that peer trust this machine (orc remote add on it). Never change trust settings yourself: report it.`
    );
  }
  for (const [re, hint] of HINTS) if (re.test(message)) return hint;
  return undefined;
}

/** The CLI's `{"error": "..."}` message, if `json` is one. */
export function cliErrorMessage(json: unknown): string | undefined {
  return isRecord(json) && typeof json.error === 'string' ? json.error : undefined;
}

/** Last non-empty lines of `text` (for an unexpected failure report). */
function tailLines(text: string, n = 5): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join('\n');
}

/** An error result for a failed CLI call (`what` names the command, e.g. `orc spawn`). */
export function cliFailure(r: CliResult, what: string): ToolResult {
  if (r.spawnError !== undefined) return errorResult(`could not run ${what}: ${r.spawnError}`);
  if (r.aborted) return errorResult(`${what} was cancelled`);
  if (r.timedOut) return errorResult(`${what} did not finish in time and was stopped`);
  if (r.overflow) return errorResult(`${what} produced more output than the MCP server keeps`, 'narrow the request (e.g. read one turn with index).');
  const route = defaultHostRoute(r.stderr);
  const message = cliErrorMessage(r.json);
  if (message !== undefined) return errorResult(message, hintFor(message, { route }));
  const detail = tailLines(r.stderr) || tailLines(r.stdout);
  const how = r.code !== null ? `exit code ${r.code}` : `signal ${r.signal ?? 'unknown'}`;
  return errorResult(`${what} failed (${how})${detail ? `: ${detail}` : ''}`, detail ? hintFor(detail, { route }) : undefined);
}

export interface TailWindow<T> {
  items: T[];
  text: string;
  truncated: boolean;
  totalChars: number;
  shownChars: number;
}

/**
 * Keep the END of a rendered sequence within `max` characters: whole items from the end,
 * then — when room is left (or nothing fits) — the tail of the item before them. `trim`
 * cuts an item to (about) its last `keep` characters and the cut item is kept in `items`;
 * without `trim` the partial item appears (cut) in `text` only.
 */
export function tailWindow<T>(
  items: readonly T[],
  render: (item: T) => string,
  max: number,
  trim?: (item: T, keep: number) => T,
): TailWindow<T> {
  const blocks = items.map(render);
  const totalChars = blocks.reduce((n, b) => n + b.length, 0) + Math.max(0, blocks.length - 1);
  if (totalChars <= max) {
    return { items: items.slice(), text: blocks.join('\n'), truncated: false, totalChars, shownChars: totalChars };
  }
  const kept: T[] = [];
  const keptBlocks: string[] = [];
  let used = 0;
  let i = blocks.length - 1;
  for (; i >= 0; i--) {
    const need = blocks[i]!.length + (keptBlocks.length > 0 ? 1 : 0);
    if (used + need > max) break;
    kept.unshift(items[i]!);
    keptBlocks.unshift(blocks[i]!);
    used += need;
  }
  const room = max - used - (keptBlocks.length > 0 ? 1 : 0);
  if (i >= 0 && room > 0 && (room >= 200 || keptBlocks.length === 0)) {
    let block = trim ? render(trim(items[i]!, room)) : blocks[i]!;
    if (block.length > room) block = keepTail(block, room);
    if (trim) kept.unshift(trim(items[i]!, room));
    keptBlocks.unshift(block);
  }
  const text = keptBlocks.join('\n');
  return { items: kept, text, truncated: true, totalChars, shownChars: text.length };
}

/** `text` cut to its last `keep` characters, marked with a leading ellipsis. */
export function keepTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  return `…${text.slice(text.length - Math.max(0, keep - 1))}`;
}
