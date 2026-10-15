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
// pi
// ---------------------------------------------------------------------------

/**
 * pi session JSONL (format v3): pi's own `<session-dir>/*_<sid>.jsonl` AND the codex
 * harness's `~/.orc/sessions/<sid>/codex-session.jsonl` (src/codex/session-file.ts).
 * Conversation lines are `{"type":"message","message":{role,content}}`; `content` is a
 * string or blocks (`text`, `thinking`, pi-ai `toolCall {name, arguments}`, or a
 * claude-style `tool_use {name, input}`). user/assistant text and one-line tool summaries
 * are kept; system messages, tool results, thinking and non-message entries are dropped.
 * Never throws on an unexpected shape.
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
      } else if (rawBlock.type === 'toolCall' && typeof rawBlock.name === 'string') {
        flush();
        turns.push({ role: 'tool', text: piToolSummary(rawBlock.name, rawBlock.arguments) });
      }
    }
    flush();
  }
  return turns;
}

/** One-line summary for a pi-ai toolCall (pi tool names: bash/read/edit/write/ls/…). */
function piToolSummary(name: string, input: unknown): string {
  const args = asRecord(input);
  if (typeof args.command === 'string') return `${name}: ${hint(args.command)}`;
  if (typeof args.path === 'string') return `${name} ${shortenPath(args.path)}`;
  return claudeToolSummary(name, input);
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
