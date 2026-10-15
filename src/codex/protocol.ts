/**
 * The JSONL stdio protocol between orc's codex runtime (src/runtime/providers/codex.ts, in
 * the actor) and the codex harness child (`orc __codex-harness <sid>`, src/codex/harness.ts).
 * One JSON object per LF-terminated line in both directions (U+2028/U+2029 escaped).
 *
 * runtime → harness (stdin)
 *   {"type":"init","spec":SpawnSpec,"resume":bool,"sessionFile":path}   first line, once
 *   {"type":"prompt","id":<messageId>,"text":<user text>}               start a turn
 *   {"type":"abort","id":<abort id>}                                     interrupt the open turn
 *   EOF                                                                  graceful shutdown: an
 *       open turn is aborted (its partial reply persisted), bash commands are killed, exit 0
 *
 * harness → runtime (stdout)
 *   {"type":"ready","providerSessionId","transcriptPath","info"}        once, after init
 *   {"type":"fatal","error"}                                            startup failed (then exit 1)
 *   {"type":"turn.started","messageId"}                                 prompt accepted (the ack)
 *   {"type":"assistant.text","messageId","text"}                        one per non-empty text block
 *   {"type":"turn.completed","messageId","result"?,"usage"?,"costUsd"?}
 *   {"type":"turn.failed","messageId","error"}
 *   {"type":"turn.interrupted","messageId"}
 *   {"type":"interrupt.acked","id"}                                     one per abort received
 *   {"type":"log","event",…}                                            diagnostics (raw log only)
 */
import type { ProviderEvent, SpawnSpec, TurnUsage } from '../runtime/types.ts';

export const HARNESS_SUBCOMMAND = '__codex-harness';

export type HarnessCommand =
  | { type: 'init'; spec: SpawnSpec; resume: boolean; sessionFile: string }
  | { type: 'prompt'; id: string; text: string }
  | { type: 'abort'; id: string };

export type HarnessEvent =
  | Extract<ProviderEvent, { type: 'ready' }>
  | { type: 'fatal'; error: string }
  | { type: 'turn.started'; messageId: string }
  | { type: 'assistant.text'; messageId: string; text: string }
  | { type: 'turn.completed'; messageId: string; result?: string; usage?: TurnUsage; costUsd?: number }
  | { type: 'turn.failed'; messageId: string; error: string }
  | { type: 'turn.interrupted'; messageId: string }
  | { type: 'interrupt.acked'; id: string }
  | { type: 'log'; event: string; [k: string]: unknown };

const LS_RE = new RegExp('\\u2028', 'g');
const PS_RE = new RegExp('\\u2029', 'g');

/** One protocol line (no trailing newline). */
export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj).replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse + validate a harness → runtime line; null when malformed. */
export function parseHarnessEvent(line: string): HarnessEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.type !== 'string') return null;
  const str = (k: string) => typeof v[k] === 'string';
  switch (v.type) {
    case 'ready':
      return str('providerSessionId') ? (v as HarnessEvent) : null;
    case 'fatal':
      return str('error') ? (v as HarnessEvent) : null;
    case 'turn.started':
    case 'turn.interrupted':
      return str('messageId') ? (v as HarnessEvent) : null;
    case 'assistant.text':
      return str('messageId') && str('text') ? (v as HarnessEvent) : null;
    case 'turn.completed':
      return str('messageId') ? (v as HarnessEvent) : null;
    case 'turn.failed':
      return str('messageId') && str('error') ? (v as HarnessEvent) : null;
    case 'interrupt.acked':
      return str('id') ? (v as HarnessEvent) : null;
    case 'log':
      return str('event') ? (v as HarnessEvent) : null;
    default:
      return null;
  }
}

/** Parse + validate a runtime → harness line; null when malformed. */
export function parseHarnessCommand(line: string): HarnessCommand | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  if (v.type === 'init' && isRecord(v.spec) && typeof v.resume === 'boolean' && typeof v.sessionFile === 'string') {
    return v as HarnessCommand;
  }
  if (v.type === 'prompt' && typeof v.id === 'string' && typeof v.text === 'string') return v as HarnessCommand;
  if (v.type === 'abort' && typeof v.id === 'string') return v as HarnessCommand;
  return null;
}
