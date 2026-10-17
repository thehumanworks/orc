/**
 * Human renderings of a session journal (src/runtime/journal.ts): `orc attach`, the
 * `orc read` fallback (no provider transcript yet) and workflow `StepDoneCtx.capture`.
 * Pure: entries in, text out.
 */
import type { JournalEntry } from './runtime/types.ts';

function indent(text: string, prefix: string): string {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${prefix}${l}`))
    .join('\n');
}

/** One journal entry as readable text, or null for bookkeeping entries. */
export function renderJournalEntry(e: JournalEntry): string | null {
  switch (e.type) {
    case 'actor.started':
      return `· actor started (pid ${e.pid}, ${e.mode})`;
    case 'provider.ready':
      return `· provider ready (session ${e.providerSessionId})`;
    case 'turn.intent':
      return `> ${indent(e.text, '  ')}`;
    case 'assistant.text':
      return indent(e.text, '');
    case 'turn.completed': {
      const cost = e.costUsd !== undefined ? ` $${e.costUsd.toFixed(4)}` : '';
      return `· turn completed${cost}`;
    }
    case 'turn.failed':
      return `! turn failed: ${e.error}`;
    case 'turn.interrupted':
      return `! turn interrupted (${e.reason})`;
    case 'interrupt.requested':
      return '· interrupt requested';
    case 'permission.requested':
      return '? permission requested (denied: orc runs providers without approvals)';
    case 'provider.exited':
      return `· provider exited (code=${e.code} signal=${e.signal})`;
    case 'actor.stopped':
      return `· actor stopped (${e.reason}${e.error ? `: ${e.error}` : ''})`;
    case 'actor.reopened':
      return '· session reopened';
    default:
      return null;
  }
}

/** Render a run of entries (bookkeeping skipped), one block per line. */
export function renderJournal(entries: JournalEntry[]): string {
  return entries
    .map(renderJournalEntry)
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
