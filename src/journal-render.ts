/**
 * Human renderings of a session journal (src/runtime/journal.ts): `orc attach`, the
 * `orc read` fallback (no provider transcript yet) and workflow `StepDoneCtx.capture`.
 * Pure: entries in, text out. The optional Style (default PLAIN = plain text) colours the
 * markers by meaning: `·` lifecycle dim, `>` prompt cyan, `!` failure red / interrupt
 * yellow, `?` permission yellow, a completed turn green.
 */
import type { JournalEntry } from './runtime/types.ts';
import { resolveStyle } from './style.ts';
import type { Style } from './style.ts';

function indent(text: string, prefix: string): string {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${prefix}${l}`))
    .join('\n');
}

/** One journal entry as readable text, or null for bookkeeping entries. */
export function renderJournalEntry(e: JournalEntry, style?: Style): string | null {
  const st = resolveStyle(style);
  switch (e.type) {
    case 'actor.started':
      return st.muted(`· actor started (pid ${e.pid}, ${e.mode})`);
    case 'provider.ready':
      return st.muted(`· provider ready (session ${e.providerSessionId})`);
    case 'turn.intent':
      return `${st.paint('>', 'bold', 'cyan')} ${indent(st.text(e.text), '  ')}`;
    case 'assistant.text':
      return indent(st.text(e.text), '');
    case 'turn.completed': {
      const cost = e.costUsd !== undefined ? ` $${e.costUsd.toFixed(4)}` : '';
      return st.success(`· turn completed${cost}`);
    }
    case 'turn.failed':
      return `${st.paint('! turn failed:', 'red')} ${st.text(e.error)}`;
    case 'turn.interrupted':
      return st.warning(`! turn interrupted (${e.reason})`);
    case 'interrupt.requested':
      return st.muted('· interrupt requested');
    case 'permission.requested':
      return `${st.warning('? permission requested')} ${st.muted('(denied: orc runs providers without approvals)')}`;
    case 'provider.exited':
      return st.muted(`· provider exited (code=${e.code} signal=${e.signal})`);
    case 'actor.stopped': {
      const text = `· actor stopped (${e.reason}${e.error ? `: ${e.error}` : ''})`;
      return e.error ? st.danger(text) : st.muted(text);
    }
    case 'actor.reopened':
      return st.muted('· session reopened');
    default:
      return null;
  }
}

/** Render a run of entries (bookkeeping skipped), one block per line. */
export function renderJournal(entries: JournalEntry[], style?: Style): string {
  const st = resolveStyle(style);
  return entries
    .map((e) => renderJournalEntry(e, st))
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Entries from the last `turn.intent` onwards (the final turn), or [] when none. */
export function finalTurnEntries(entries: JournalEntry[]): JournalEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'turn.intent') return entries.slice(i);
  }
  return [];
}

/**
 * The last assistant message: the newest `assistant.text`, else the newest
 * `turn.completed.result`. Undefined when the agent has said nothing yet.
 */
export function lastAssistantText(entries: JournalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'assistant.text' && e.text.trim().length > 0) return e.text;
    if (e.type === 'turn.completed' && e.result && e.result.trim().length > 0) return e.result;
  }
  return undefined;
}

/** Bound for the final-turn rendering inside a capture. */
export const CAPTURE_MAX_CHARS = 8_000;

/**
 * Workflow `StepDoneCtx.capture`: the last assistant message, then a short rendering of
 * the final turn (prompt, replies, outcome/error). Bounded to CAPTURE_MAX_CHARS (the
 * tail is kept).
 */
export function renderCapture(entries: JournalEntry[]): string {
  const last = lastAssistantText(entries);
  const turn = renderJournal(finalTurnEntries(entries));
  const parts: string[] = [];
  if (last !== undefined) parts.push(last.replace(/\n$/, ''));
  if (turn.length > 0) parts.push(`--- final turn ---\n${turn}`);
  const out = parts.join('\n\n');
  return out.length > CAPTURE_MAX_CHARS ? out.slice(out.length - CAPTURE_MAX_CHARS) : out;
}
