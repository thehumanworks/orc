/**
 * Token-efficient transcript parsing. Each provider writes a JSONL message log to
 * disk; we normalize it into a flat list of `Turn`s — the conversation text plus
 * ONE-LINE tool-call summaries — dropping raw tool output, reasoning/thinking, and
 * all UI chrome. `orc read` selects from this compact view by default (the session
 * journal is the `--raw` escape hatch).
 */
import type { Provider } from './types.ts';

export type TurnRole = 'user' | 'assistant' | 'tool' | 'system';

/** A normalized conversation turn. A `tool` turn's `text` is the one-line summary. */
export interface Turn {
  role: TurnRole;
  text: string;
}

export type TurnSelection =
  | { mode: 'latest' }
  | { mode: 'full' }
  | { mode: 'index'; index: number };

const HINT_MAX = 60;
const PATH_MAX = 48;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function nonEmptyText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  return text.length > 0 ? text : null;
}

/** Collapse all whitespace runs to single spaces. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate to `n` chars, appending an ellipsis when cut. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** A short single-line hint for a tool argument. */
function hint(s: string): string {
  return truncate(oneLine(s), HINT_MAX);
}

/** Shorten a path keeping the (more informative) tail, e.g. `…/src/x.ts`. */
function shortenPath(p: string): string {
  return p.length <= PATH_MAX ? p : `…${p.slice(p.length - (PATH_MAX - 1))}`;
}

/** Split JSONL and parse each line, tolerating a half-written trailing line. */
function parseLines(jsonl: string): unknown[] {
  const out: unknown[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Live reads can hit a partially-flushed last line; skip it rather than throw.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/** One-line summary for a claude tool_use block (name + a short arg hint). */
function claudeToolSummary(name: string, input: unknown): string {
  const args = asRecord(input);
  if (name === 'Bash' && typeof args.command === 'string') {
    return `Bash: ${hint(args.command)}`;
  }
  // File tools (Read/Write/Edit/NotebookEdit/…): `<Name> <path>`.
  if (typeof args.file_path === 'string') {
    return `${name} ${shortenPath(args.file_path)}`;
  }
  if (typeof args.pattern === 'string') {
    return `${name}: ${hint(args.pattern)}`;
  }
  // Generic single-line hint from the most descriptive string field present.
  for (const key of ['command', 'query', 'url', 'prompt', 'description']) {
    const v = args[key];
    if (typeof v === 'string') return `${name}: ${hint(v)}`;
  }
  return name;
}

/**
 * claude `~/.claude/projects/<slug>/<sid>.jsonl`: conversational lines are
 * `type:"user"`/`type:"assistant"`, each with a `message.content` that is either a
 * string or an array of blocks (`text`, `tool_use`, `tool_result`). We keep user/
 * assistant text and tool_use summaries, and drop tool_result output, `thinking`,
 * and non-conversational line types. Subagent (`isSidechain`) turns are skipped —
 * those belong to the subagent's own inspectable session, not the parent thread.
 */
export function parseClaude(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of parseLines(jsonl)) {
    if (!isRecord(raw)) continue;
    if (raw.isSidechain === true) continue;
    if (raw.type !== 'user' && raw.type !== 'assistant') continue;
    const content = asRecord(raw.message).content;
    const role: TurnRole = raw.type;

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) turns.push({ role, text });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // Walk blocks in order so interleaved text/tool_use keep their sequence.
    let pending = '';
    const flush = () => {
      const t = pending.trim();
      if (t) turns.push({ role, text: t });
      pending = '';
    };
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) continue;
      if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') {
        pending += (pending ? '\n' : '') + rawBlock.text;
      } else if (
        (rawBlock.type === 'tool_use' || rawBlock.type === 'server_tool_use') &&
        typeof rawBlock.name === 'string'
      ) {
        flush();
        turns.push({ role: 'tool', text: claudeToolSummary(rawBlock.name, rawBlock.input) });
      }
      // tool_result / thinking / advisor_tool_result / others: dropped.
    }
    flush();
  }
  return turns;
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/** One-line summary for a codex tool call (name + a short arg hint). */
function codexToolSummary(name: string, argsRaw: string): string {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(argsRaw);
  } catch {
    // Non-JSON arg payload — fall through to the bare name.
  }
  const args = asRecord(parsed);
  let cmd = args.cmd;
  if (cmd == null && args.command != null) {
    cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command;
  }
  if (typeof cmd === 'string') return `${name}: ${hint(cmd)}`;
  for (const v of Object.values(args)) {
    if (typeof v === 'string') return `${name}: ${hint(v)}`;
    if (Array.isArray(v) && v.every((item) => typeof item === 'string')) {
      return `${name}: ${hint(v.join(' '))}`;
    }
  }
  return name;
}

/** codex response_item payload types that represent a tool/command call. */
const CODEX_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'tool_search_call',
  'web_search_call',
]);

function codexMessageText(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyText(payload.message);
  if (direct) return direct;

  const content = payload.content;
  if (typeof content === 'string') return nonEmptyText(content);
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue;
    const text = nonEmptyText(rawBlock.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function codexEventTurn(payload: Record<string, unknown>): Turn | null {
  if (payload.type === 'user_message') {
    const text = nonEmptyText(payload.message);
    return text ? { role: 'user', text } : null;
  }
  if (payload.type === 'agent_message') {
    const text = nonEmptyText(payload.message);
    return text ? { role: 'assistant', text } : null;
  }
  return null;
}

function turnKey(turn: Turn): string {
  return `${turn.role}\0${turn.text}`;
}

/**
 * codex `~/.codex/sessions/Y/M/D/rollout-*.jsonl`: clean conversational turns are
 * `event_msg` lines with `payload.type` of `user_message`/`agent_message` (text in
 * `payload.message`). Tool/command activity is in `response_item` `function_call`
 * (and sibling call types) lines. We take TEXT only from `event_msg` to avoid the
 * duplicate assistant text in `response_item` `message`, and tool summaries only
 * from `response_item` calls. session_meta/turn_context/token_count/reasoning and
 * all `*_output` (result) lines are dropped.
 */
export function parseCodex(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  const lines = parseLines(jsonl);
  const eventText = new Set<string>();

  for (const raw of lines) {
    if (!isRecord(raw) || raw.type !== 'event_msg') continue;
    const event = codexEventTurn(asRecord(raw.payload));
    if (event) eventText.add(turnKey(event));
  }

  for (const raw of lines) {
    if (!isRecord(raw)) continue;
    const p = asRecord(raw.payload);
    if (Object.keys(p).length === 0) continue;

    if (raw.type === 'event_msg') {
      const event = codexEventTurn(p);
      if (event) turns.push(event);
      continue;
    }

    if (raw.type !== 'response_item' || typeof p.type !== 'string') continue;

    if (p.type === 'message') {
      const role = p.role === 'assistant' || p.role === 'user' ? p.role : undefined;
      const text = codexMessageText(p);
      if (role && text) {
        const turn = { role, text } satisfies Turn;
        if (!eventText.has(turnKey(turn))) turns.push(turn);
      }
      continue;
    }

    if (CODEX_CALL_TYPES.has(p.type)) {
      const name = typeof p.name === 'string' ? p.name : p.type;
      // arguments (function_call) is a JSON string; custom tools carry `input`;
      // shell calls carry an `action`. Normalize to a JSON string for the summarizer.
      let argsRaw = typeof p.arguments === 'string' ? p.arguments : undefined;
      if (typeof argsRaw !== 'string') {
        const fallback = p.input ?? p.action ?? {};
        argsRaw = typeof fallback === 'string' ? fallback : JSON.stringify(fallback ?? {});
      }
      turns.push({ role: 'tool', text: codexToolSummary(name, argsRaw ?? '') });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

/**
 * pi `<session-dir>/*_<sid>.jsonl`. UNVERIFIED: no pi transcript was available to
 * inspect, so this is a best-effort tolerant parser shaped like claude's — it reads
 * a role + string/array content and summarizes any tool_use-like block. Refine once
 * a real pi transcript can be inspected; it never throws on an unexpected shape.
 */
export function parsePi(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of parseLines(jsonl)) {
    if (!isRecord(raw)) continue;
    const msg = isRecord(raw.message) ? raw.message : undefined;
    const role = (raw.role ?? msg?.role ?? raw.type) as string | undefined;

    // A standalone tool-call line.
    if (raw.type === 'tool_use' && typeof raw.name === 'string') {
      turns.push({ role: 'tool', text: claudeToolSummary(raw.name, raw.input) });
      continue;
    }

    if (role !== 'user' && role !== 'assistant') continue;
    const content =
      raw.content ?? (typeof raw.message === 'string' ? raw.message : msg?.content) ?? raw.text;

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) turns.push({ role, text });
      continue;
    }
    if (!Array.isArray(content)) continue;
    let pending = '';
    const flush = () => {
      const t = pending.trim();
      if (t) turns.push({ role, text: t });
      pending = '';
    };
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) continue;
      if (rawBlock.type === 'text' && typeof rawBlock.text === 'string') {
        pending += (pending ? '\n' : '') + rawBlock.text;
      } else if (rawBlock.type === 'tool_use' && typeof rawBlock.name === 'string') {
        flush();
        turns.push({ role: 'tool', text: claudeToolSummary(rawBlock.name, rawBlock.input) });
      }
    }
    flush();
  }
  return turns;
}

// ---------------------------------------------------------------------------
// dispatch + render
// ---------------------------------------------------------------------------

/** Parse a provider's on-disk JSONL transcript into normalized turns. */
export function parseTranscript(provider: Provider, jsonl: string): Turn[] {
  switch (provider) {
    case 'claude':
      return parseClaude(jsonl);
    case 'codex':
      return parseCodex(jsonl);
    case 'pi':
      return parsePi(jsonl);
  }
}

/**
 * Split the flat parsed transcript into conversation turns. A new user message starts
 * a new group; tool summaries and assistant text stay attached to the surrounding
 * user turn so `orc read` can show useful context instead of a lone trailing tool.
 */
export function conversationTurns(turns: readonly Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  let current: Turn[] = [];
  for (const turn of turns) {
    if (turn.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(turn);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Select the full transcript, the latest conversation turn, or a zero-based turn. */
export function selectTurns(
  turns: readonly Turn[],
  selection: TurnSelection = { mode: 'latest' },
): Turn[] {
  if (selection.mode === 'full') return turns.slice();
  const groups = conversationTurns(turns);
  if (groups.length === 0) {
    if (selection.mode === 'index') {
      throw new Error(`turn index ${selection.index} out of range (no parsed turns)`);
    }
    return [];
  }

  const index = selection.mode === 'index' ? selection.index : groups.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= groups.length) {
    const range = groups.length === 0 ? 'no parsed turns' : `available: 0..${groups.length - 1}`;
    throw new Error(`turn index ${index} out of range (${range})`);
  }
  return groups[index]!.slice();
}

/**
 * Render turns as compact text: `<user> …` / `<assistant> …` for conversation, and
 * an indented `  [<summary>]` for tool turns.
 */
export function renderTurns(turns: Turn[]): string {
  return turns
    .map((t) => (t.role === 'tool' ? `  [${t.text}]` : `<${t.role}> ${t.text}`))
    .join('\n');
}
