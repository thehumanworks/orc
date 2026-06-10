/**
 * Token-efficient transcript parsing. Each provider writes a JSONL message log to
 * disk; we normalize it into a flat list of `Turn`s — the conversation text plus
 * ONE-LINE tool-call summaries — dropping raw tool output, reasoning/thinking, and
 * all UI chrome. This is what `orc read` shows by default (the raw tmux pane is the
 * `--raw` escape hatch).
 */
import type { Provider } from './types.ts';

export type TurnRole = 'user' | 'assistant' | 'tool' | 'system';

/** A normalized conversation turn. A `tool` turn's `text` is the one-line summary. */
export interface Turn {
  role: TurnRole;
  text: string;
}

const HINT_MAX = 60;
const PATH_MAX = 48;

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
function claudeToolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') {
    return `Bash: ${hint(input.command)}`;
  }
  // File tools (Read/Write/Edit/NotebookEdit/…): `<Name> <path>`.
  if (typeof input.file_path === 'string') {
    return `${name} ${shortenPath(input.file_path)}`;
  }
  if (typeof input.pattern === 'string') {
    return `${name}: ${hint(input.pattern)}`;
  }
  // Generic single-line hint from the most descriptive string field present.
  for (const key of ['command', 'query', 'url', 'prompt', 'description']) {
    const v = input[key];
    if (typeof v === 'string') return `${name}: ${hint(v)}`;
  }
  return name;
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: string | ClaudeBlock[] };
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
    const o = raw as ClaudeLine;
    if (o.isSidechain === true) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const content = o.message?.content;
    const role: TurnRole = o.type;

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
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        pending += (pending ? '\n' : '') + block.text;
      } else if (
        (block.type === 'tool_use' || block.type === 'server_tool_use') &&
        typeof block.name === 'string'
      ) {
        flush();
        turns.push({ role: 'tool', text: claudeToolSummary(block.name, block.input ?? {}) });
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
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsRaw) as Record<string, unknown>;
  } catch {
    // Non-JSON arg payload — fall through to the bare name.
  }
  let cmd = args.cmd;
  if (cmd == null && args.command != null) {
    cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command;
  }
  if (typeof cmd === 'string') return `${name}: ${hint(cmd)}`;
  for (const v of Object.values(args)) {
    if (typeof v === 'string') return `${name}: ${hint(v)}`;
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

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    name?: string;
    arguments?: string;
    input?: unknown;
    action?: unknown;
  };
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
  for (const raw of parseLines(jsonl)) {
    const o = raw as CodexLine;
    const p = o.payload;
    if (!p) continue;

    if (o.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string') {
        const text = p.message.trim();
        if (text) turns.push({ role: 'user', text });
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        const text = p.message.trim();
        if (text) turns.push({ role: 'assistant', text });
      }
      continue;
    }

    if (o.type === 'response_item' && p.type && CODEX_CALL_TYPES.has(p.type)) {
      const name = typeof p.name === 'string' ? p.name : p.type;
      // arguments (function_call) is a JSON string; custom tools carry `input`;
      // shell calls carry an `action`. Normalize to a JSON string for the summarizer.
      let argsRaw = p.arguments;
      if (typeof argsRaw !== 'string') {
        const fallback = p.input ?? p.action ?? {};
        argsRaw = typeof fallback === 'string' ? fallback : JSON.stringify(fallback);
      }
      turns.push({ role: 'tool', text: codexToolSummary(name, argsRaw) });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

interface PiBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface PiLine {
  type?: string;
  role?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  message?: { role?: string; content?: string | PiBlock[] } | string;
  content?: string | PiBlock[];
}

/**
 * pi `<session-dir>/*_<sid>.jsonl`. UNVERIFIED: no pi transcript was available to
 * inspect, so this is a best-effort tolerant parser shaped like claude's — it reads
 * a role + string/array content and summarizes any tool_use-like block. Refine once
 * a real pi transcript can be inspected; it never throws on an unexpected shape.
 */
export function parsePi(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of parseLines(jsonl)) {
    const o = raw as PiLine;
    const msg = typeof o.message === 'object' && o.message ? o.message : undefined;
    const role = (o.role ?? msg?.role ?? o.type) as string | undefined;

    // A standalone tool-call line.
    if (o.type === 'tool_use' && typeof o.name === 'string') {
      turns.push({ role: 'tool', text: claudeToolSummary(o.name, o.input ?? {}) });
      continue;
    }

    if (role !== 'user' && role !== 'assistant') continue;
    const content = o.content ?? (typeof o.message === 'string' ? o.message : msg?.content) ?? o.text;

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
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        pending += (pending ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        flush();
        turns.push({ role: 'tool', text: claudeToolSummary(block.name, block.input ?? {}) });
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
 * Render turns as compact text: `<user> …` / `<assistant> …` for conversation, and
 * an indented `  [<summary>]` for tool turns.
 */
export function renderTurns(turns: Turn[]): string {
  return turns
    .map((t) => (t.role === 'tool' ? `  [${t.text}]` : `<${t.role}> ${t.text}`))
    .join('\n');
}
