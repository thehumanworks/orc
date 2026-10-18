/**
 * pi `--mode rpc` wire protocol (verified against pi 1.2.0): launch argv, JSONL framing,
 * and the PURE record → ProviderEvent mapper used by the pi runtime (./pi.ts). No I/O here,
 * so the mapping is unit-testable against recorded protocol lines.
 *
 * Wire facts this file relies on (see the S4 brief):
 *   - Strict LF-delimited JSON both ways. Split on "\n" only (strip a trailing "\r"); never
 *     on U+2028/U+2029.
 *   - A `prompt` response is an ACK (arrives before the run's `agent_start`), not a
 *     completion. A failed prompt (`success:false`) starts no run.
 *   - A turn ends ONLY at `agent_settled` (`aborted` flag). `turn_end` fires per assistant
 *     message and `agent_end{willRetry:true}` is followed by an automatic retry.
 *   - Provider errors are not events: they land in the assistant `message_end` as
 *     `stopReason:"error"` + `errorMessage`; a failed retry cycle ends with
 *     `auto_retry_end{success:false, finalError}`.
 *   - `abort` is answered only after the run settles (`agent_settled{aborted:true}` first).
 *     An abort that reaches pi before the prompt's preflight finished is a silent no-op, so
 *     an interrupt requested before the ack is deferred until the run exists.
 *   - `extension_ui_request` dialog methods block pi until an `extension_ui_response`.
 *   - `role:"system"` messages are echoed on every run start: ignored here.
 *
 * Mapping (pi record → ProviderEvent, one open turn `mid` at a time):
 *   response(prompt, id=mid) success started   → turn.started
 *   response(prompt, id=mid) success handled   → turn.started, turn.completed (no run exists)
 *   response(prompt, id=mid) success queued    → turn.failed (protocol bug: orc never queues)
 *   response(prompt, id=mid) success:false     → turn.failed{error}
 *   message_end role=assistant                  → assistant.text per non-empty text block
 *   auto_retry_end success:false                → remembers finalError
 *   agent_settled aborted:true                  → turn.interrupted
 *   agent_settled, last stopReason "aborted"    → turn.interrupted (defensive)
 *   agent_settled, last stopReason "error"      → turn.interrupted if an interrupt was
 *                                                 requested, else turn.failed{finalError ??
 *                                                 errorMessage}
 *   agent_settled otherwise (incl. "length")    → turn.completed{result, usage, costUsd}
 *   response(abort, id=ours)                    → interrupt.acked (one per abort written)
 *   extension_ui_request (dialog method)        → permission.requested + auto-cancel reply
 *   process exit with a turn open               → turn.interrupted (pi emits nothing)
 */
import type { ProviderEvent, SpawnSpec, TurnUsage } from '../types.ts';
import { parsePiModel, validateModel } from '../../providers.ts';

/** pi version the protocol mapping was verified against (contract-test pin). */
export const PI_VERIFIED_VERSION = '1.2.0';

/** pi's accepted `--session-id` syntax (pi 1.2.0 `main.js`). */
export const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Prefix of request ids orc generates itself (boot get_state, aborts). */
export const PI_INTERNAL_ID_PREFIX = '__orc:';

/** Request id of the boot-time `get_state`. */
export const PI_BOOT_ID = `${PI_INTERNAL_ID_PREFIX}boot`;

/**
 * A repeated interrupt() re-sends `abort` only when the previous one is still unanswered
 * after this long (pi may drop an abort, e.g. one racing a run boundary).
 */
export const PI_REABORT_AFTER_MS = 3_000;

/** Extension UI methods that do NOT wait for a response (pi docs `rpc-extension-ui.md`). */
const FIRE_AND_FORGET_UI = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

// ---------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------

/** The `--session-id` a launch uses: fresh → spec.sessionId; resume → providerSessionId ?? sessionId. */
export function piSessionIdFor(spec: SpawnSpec, resume: boolean): string {
  return resume ? (spec.providerSessionId ?? spec.sessionId) : spec.sessionId;
}

/**
 * pi arguments (without the executable) for a launch. Fresh and resume use IDENTICAL flags:
 * `--session-id` + `--session-dir` is open-or-create, and resume must repeat the same system
 * prompt flag (omitting it drops the addendum from that run on). The prompt is passed as a
 * FILE PATH (pi reads an existing file's contents), never as text.
 */
export function buildPiArgs(spec: SpawnSpec, resume: boolean): string[] {
  const args = ['--mode', 'rpc', '-a'];
  validateModel('pi', spec.model);
  if (spec.model) {
    const selected = parsePiModel(spec.model);
    // An explicit --provider prevents Pi's provider inference from falling back to a
    // similarly named raw model id on another authenticated provider.
    if (selected.provider) args.push('--provider', selected.provider);
    args.push('--model', selected.model);
  }
  if (spec.systemPrompt) {
    args.push(
      spec.systemPrompt.mode === 'replace' ? '--system-prompt' : '--append-system-prompt',
      spec.systemPrompt.path,
    );
  }
  args.push('--session-id', piSessionIdFor(spec, resume));
  if (spec.sessionDir) args.push('--session-dir', spec.sessionDir);
  return args;
}

// ---------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------

// Built from escapes: a literal U+2028/U+2029 inside a regex literal is a line terminator.
const LS_RE = new RegExp('\\u2028', 'g');
const PS_RE = new RegExp('\\u2029', 'g');

/**
 * One command line (no trailing newline). U+2028/U+2029 are escaped too: still valid JSON
 * and round-trips exactly, but immune to any line reader that treats them as breaks.
 */
export function encodePiCommand(cmd: Record<string, unknown>): string {
  return JSON.stringify(cmd).replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
}

/** Incremental LF splitter for pi's stdout (decoded text in, complete lines out). */
export class JsonlSplitter {
  private buf = '';

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      out.push(line);
    }
    return out;
  }

  /** Remaining unterminated text (a partial line at EOF is a protocol error). */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }
}

export type PiRecord = Record<string, unknown>;

/** Parse one stdout line; null for blank or non-JSON-object lines. */
export function parsePiLine(line: string): PiRecord | null {
  const s = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (s.trim().length === 0) return null;
  try {
    const v: unknown = JSON.parse(s);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------------

export interface PiMapResult {
  events: ProviderEvent[];
  /** Commands the runtime must write to pi's stdin, in order. */
  writes: PiRecord[];
}

interface AssistantSummary {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

interface OpenTurn {
  messageId: string;
  /** prompt response received. */
  acked: boolean;
  interruptRequested: boolean;
  /** interrupt() came before the ack: the abort is written once the run exists. */
  abortDeferred: boolean;
  /** Aborts written for this turn and not yet answered. */
  unansweredAborts: Set<string>;
  /** When the latest abort for this turn was written (ms). */
  lastAbortAt?: number;
  last?: AssistantSummary;
  usage: Required<TurnUsage>;
  sawUsage: boolean;
  costUsd: number;
  sawCost: boolean;
  retryFinalError?: string;
}

const empty = (): PiMapResult => ({ events: [], writes: [] });

/**
 * Pure state machine: feed it every parsed stdout record (in order) plus the runtime's own
 * actions (beginTurn / requestInterrupt / finishOnExit); it returns the normalized events
 * and any protocol replies. At most one turn is open.
 */
export class PiTurnMapper {
  private turn: OpenTurn | null = null;
  private abortSeq = 0;
  private readonly pendingAborts = new Set<string>();
  private readonly reabortAfterMs: number;
  /** stdout lines that were not JSON objects (logged, otherwise ignored). */
  nonJsonLines = 0;

  constructor(opts: { reabortAfterMs?: number } = {}) {
    this.reabortAfterMs = opts.reabortAfterMs ?? PI_REABORT_AFTER_MS;
  }

  /** Ids of the aborts written for the open turn and not yet answered. */
  openTurnAbortIds(): string[] {
    return this.turn ? [...this.turn.unansweredAborts] : [];
  }

  /** True while an abort with this id is still unanswered. */
  isAbortPending(id: string): boolean {
    return this.pendingAborts.has(id);
  }

  /** messageId of the open turn, or null. */
  get openMessageId(): string | null {
    return this.turn?.messageId ?? null;
  }

  /** Open a turn and return the `prompt` command to write (its id IS the messageId). */
  beginTurn(messageId: string, text: string): PiRecord {
    if (this.turn) throw new Error(`pi: turn ${this.turn.messageId} is still open`);
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new Error('pi: messageId must be a non-empty string');
    }
    if (messageId.startsWith(PI_INTERNAL_ID_PREFIX)) {
      throw new Error(`pi: messageId must not start with ${PI_INTERNAL_ID_PREFIX}`);
    }
    if (typeof text !== 'string') throw new Error('pi: message text must be a string');
    this.turn = {
      messageId,
      acked: false,
      interruptRequested: false,
      abortDeferred: false,
      unansweredAborts: new Set(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sawUsage: false,
      costUsd: 0,
      sawCost: false,
    };
    return { id: messageId, type: 'prompt', message: text };
  }

  /**
   * Interrupt the open turn: returns the `abort` to write now, or nothing when deferred
   * (prompt not yet acked) or already in flight. A repeat request re-sends `abort` only
   * once the previous one has gone unanswered for `reabortAfterMs` (pi may drop one).
   * No open turn → no-op (no events). Each abort written yields one `interrupt.acked`.
   */
  requestInterrupt(now: number = Date.now()): PiMapResult {
    const t = this.turn;
    if (!t) return empty();
    if (!t.interruptRequested) {
      t.interruptRequested = true;
      if (!t.acked) {
        t.abortDeferred = true;
        return empty();
      }
      return { events: [], writes: [this.abortCommand(t, now)] };
    }
    if (t.abortDeferred) return empty();
    const lastAt = t.lastAbortAt ?? Number.NEGATIVE_INFINITY;
    if (t.unansweredAborts.size > 0 && now - lastAt < this.reabortAfterMs) return empty();
    return { events: [], writes: [this.abortCommand(t, now)] };
  }

  /** Process exit: close an open turn ourselves (pi emits nothing after stdin close / crash). */
  finishOnExit(): ProviderEvent[] {
    this.pendingAborts.clear();
    const t = this.turn;
    this.turn = null;
    return t ? [{ type: 'turn.interrupted', messageId: t.messageId }] : [];
  }

  /** Convenience for tests: parse + handle one raw stdout line. */
  handleLine(line: string): PiMapResult {
    const rec = parsePiLine(line);
    if (!rec) {
      if (line.trim().length > 0) this.nonJsonLines++;
      return empty();
    }
    return this.handleRecord(rec);
  }

  handleRecord(rec: PiRecord, now: number = Date.now()): PiMapResult {
    switch (rec.type) {
      case 'response':
        return this.onResponse(rec, now);
      case 'message_end':
        return this.onMessageEnd(rec);
      case 'auto_retry_end':
        if (this.turn) {
          this.turn.retryFinalError =
            rec.success === false ? str(rec.finalError) ?? 'pi auto-retry failed' : undefined;
        }
        return empty();
      case 'agent_settled':
        return this.onSettled(rec);
      case 'extension_ui_request':
        return this.onExtensionUi(rec);
      default:
        // agent_start/end, turn_start/end, message_start/update, queue_update, entry_appended,
        // auto_retry_start, compaction_*, tool_execution_*, extension_error, … → raw log only.
        return empty();
    }
  }

  private abortCommand(t: OpenTurn, now: number): PiRecord {
    const id = `${PI_INTERNAL_ID_PREFIX}abort:${++this.abortSeq}`;
    this.pendingAborts.add(id);
    t.unansweredAborts.add(id);
    t.lastAbortAt = now;
    return { id, type: 'abort' };
  }

  private onResponse(rec: PiRecord, now: number): PiMapResult {
    const id = rec.id;
    if (typeof id === 'string' && this.pendingAborts.has(id)) {
      this.pendingAborts.delete(id);
      this.turn?.unansweredAborts.delete(id);
      return { events: [{ type: 'interrupt.acked' }], writes: [] };
    }
    const t = this.turn;
    if (!t || id !== t.messageId || rec.command !== 'prompt' || t.acked) return empty();

    const out = empty();
    if (rec.success === true) {
      const disposition = isRecord(rec.data) ? rec.data.disposition : undefined;
      if (disposition === 'started') {
        t.acked = true;
        out.events.push({ type: 'turn.started', messageId: t.messageId });
        if (t.abortDeferred) {
          t.abortDeferred = false;
          out.writes.push(this.abortCommand(t, now));
        }
        return out;
      }
      if (disposition === 'handled') {
        // An extension command / input handler consumed it: no run, no agent_settled.
        out.events.push({ type: 'turn.started', messageId: t.messageId });
        out.events.push({ type: 'turn.completed', messageId: t.messageId });
      } else {
        out.events.push({
          type: 'turn.failed',
          messageId: t.messageId,
          error: `pi did not start a run (unexpected prompt disposition ${JSON.stringify(disposition)})`,
        });
      }
    } else {
      out.events.push({
        type: 'turn.failed',
        messageId: t.messageId,
        error: str(rec.error) ?? 'pi rejected the prompt',
      });
    }
    // The turn closed without a run. A deferred interrupt is resolved with nothing to abort.
    if (t.abortDeferred) out.events.push({ type: 'interrupt.acked' });
    this.turn = null;
    return out;
  }

  private onMessageEnd(rec: PiRecord): PiMapResult {
    const t = this.turn;
    const msg = rec.message;
    if (!t || !isRecord(msg) || msg.role !== 'assistant') return empty();

    const blocks: string[] = [];
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') blocks.push(b.text);
      }
    } else if (typeof msg.content === 'string') {
      blocks.push(msg.content);
    }
    t.last = {
      text: blocks.join(''),
      stopReason: str(msg.stopReason),
      errorMessage: str(msg.errorMessage),
    };
    const usage = msg.usage;
    if (isRecord(usage)) {
      t.sawUsage = true;
      t.usage.inputTokens += num(usage.input);
      t.usage.outputTokens += num(usage.output);
      t.usage.cacheReadTokens += num(usage.cacheRead);
      t.usage.cacheWriteTokens += num(usage.cacheWrite);
      if (isRecord(usage.cost) && typeof usage.cost.total === 'number') {
        t.sawCost = true;
        t.costUsd += usage.cost.total;
      }
    }
    const events: ProviderEvent[] = blocks
      .filter((text) => text.trim().length > 0)
      .map((text): ProviderEvent => ({ type: 'assistant.text', messageId: t.messageId, text }));
    return { events, writes: [] };
  }

  private onSettled(rec: PiRecord): PiMapResult {
    const t = this.turn;
    if (!t) return empty();
    this.turn = null;
    const stop = t.last?.stopReason;
    const messageId = t.messageId;

    if (rec.aborted === true || stop === 'aborted' || (t.interruptRequested && stop === 'error')) {
      return { events: [{ type: 'turn.interrupted', messageId }], writes: [] };
    }
    if (stop === 'error') {
      const error = t.retryFinalError ?? t.last?.errorMessage ?? 'pi run ended with stopReason "error"';
      return { events: [{ type: 'turn.failed', messageId, error }], writes: [] };
    }
    // "stop", "toolUse", "length" (binding decision: completed, stopReason in raw log only), none.
    const ev: Extract<ProviderEvent, { type: 'turn.completed' }> = { type: 'turn.completed', messageId };
    if (t.last && t.last.text.length > 0) ev.result = t.last.text;
    if (t.sawUsage) ev.usage = { ...t.usage };
    if (t.sawCost) ev.costUsd = t.costUsd;
    return { events: [ev], writes: [] };
  }

  private onExtensionUi(rec: PiRecord): PiMapResult {
    const method = str(rec.method);
    if (method !== undefined && FIRE_AND_FORGET_UI.has(method)) return empty();
    // A dialog (select/confirm/input/editor, or an unknown method that may block): journal
    // it and cancel at once so the turn can end — orc sessions have no interactive UI.
    const ev: Extract<ProviderEvent, { type: 'permission.requested' }> = { type: 'permission.requested', detail: rec };
    if (this.turn) ev.messageId = this.turn.messageId;
    const out: PiMapResult = { events: [ev], writes: [] };
    if (typeof rec.id === 'string') out.writes.push({ type: 'extension_ui_response', id: rec.id, cancelled: true });
    return out;
  }
}

function isRecord(v: unknown): v is PiRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
