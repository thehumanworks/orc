/**
 * Pure folds over the journal: per-turn records, a session summary, the public AgentState
 * (design §4.4) and per-message delivery verdicts (brief decision 1). No I/O here.
 */
import type { AgentState } from '../types.ts';
import type {
  ActorPhase,
  ActorStateFile,
  JournalEntry,
  SpawnSpec,
  TurnInterruptReason,
} from './types.ts';

export type TurnOutcome = 'completed' | 'failed' | 'interrupted';

export interface TurnRecord {
  messageId: string;
  ulid: string;
  intentSeq: number;
  intentAt: string;
  startedSeq?: number;
  startedAt?: string;
  outcome?: TurnOutcome;
  outcomeSeq?: number;
  outcomeAt?: string;
  /** turn.failed error. */
  error?: string;
  /** turn.interrupted reason. */
  reason?: TurnInterruptReason;
  /** turn.completed result text. */
  result?: string;
}

export interface PermissionRecord {
  seq: number;
  at: string;
  messageId?: string;
  detail: unknown;
}

/** Incremental fold of journal entries into turn bookkeeping. */
export class TurnLedger {
  readonly byMessageId = new Map<string, TurnRecord>();
  readonly intentUlids = new Set<string>();
  readonly acceptedUlids = new Set<string>();
  private readonly openIds = new Set<string>();
  completedTurns = 0;
  startedTurns = 0;
  lastSeq = 0;
  lastOutcomeSeq = 0;
  lastTurn?: TurnRecord;
  lastPermission?: PermissionRecord;
  lastActorStarted?: { seq: number; at: string; pid: number; mode: 'fresh' | 'resume' };
  lastActorStopped?: { seq: number; at: string; reason: string; error?: string };
  providerSessionId?: string;
  transcriptPath?: string;

  static from(entries: Iterable<JournalEntry>): TurnLedger {
    const l = new TurnLedger();
    for (const e of entries) l.apply(e);
    return l;
  }

  apply(e: JournalEntry): void {
    if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    switch (e.type) {
      case 'inbox.accepted':
        this.acceptedUlids.add(e.ulid);
        break;
      case 'turn.intent':
        this.intentUlids.add(e.ulid);
        if (!this.byMessageId.has(e.messageId)) {
          this.byMessageId.set(e.messageId, {
            messageId: e.messageId,
            ulid: e.ulid,
            intentSeq: e.seq,
            intentAt: e.ts,
          });
          this.openIds.add(e.messageId);
        }
        break;
      case 'turn.started': {
        const r = this.byMessageId.get(e.messageId);
        if (r && r.startedSeq === undefined && r.outcome === undefined) {
          r.startedSeq = e.seq;
          r.startedAt = e.ts;
          this.startedTurns++;
        }
        break;
      }
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted': {
        const r = this.byMessageId.get(e.messageId);
        if (!r || r.outcome !== undefined) break;
        r.outcomeSeq = e.seq;
        r.outcomeAt = e.ts;
        if (e.type === 'turn.completed') {
          r.outcome = 'completed';
          if (e.result !== undefined) r.result = e.result;
          this.completedTurns++;
        } else if (e.type === 'turn.failed') {
          r.outcome = 'failed';
          r.error = e.error;
        } else {
          r.outcome = 'interrupted';
          r.reason = e.reason;
        }
        this.openIds.delete(e.messageId);
        this.lastOutcomeSeq = e.seq;
        this.lastTurn = r;
        break;
      }
      case 'permission.requested':
        this.lastPermission = { seq: e.seq, at: e.ts, messageId: e.messageId, detail: e.detail };
        break;
      case 'actor.started':
        this.lastActorStarted = { seq: e.seq, at: e.ts, pid: e.pid, mode: e.mode };
        break;
      case 'actor.stopped':
        this.lastActorStopped = { seq: e.seq, at: e.ts, reason: e.reason, ...(e.error ? { error: e.error } : {}) };
        break;
      case 'provider.ready':
        this.providerSessionId = e.providerSessionId;
        if (e.transcriptPath) this.transcriptPath = e.transcriptPath;
        break;
      default:
        break;
    }
  }

  /** Intents with no outcome, in intent order. */
  openTurns(): TurnRecord[] {
    return [...this.openIds]
      .map((id) => this.byMessageId.get(id))
      .filter((r): r is TurnRecord => !!r)
      .sort((a, b) => a.intentSeq - b.intentSeq);
  }

  get openTurn(): TurnRecord | undefined {
    const open = this.openTurns();
    return open[open.length - 1];
  }

  /** A permission request newer than the last turn outcome and the last actor start. */
  get pendingPermission(): PermissionRecord | undefined {
    const p = this.lastPermission;
    if (!p) return undefined;
    const after = Math.max(this.lastOutcomeSeq, this.lastActorStarted?.seq ?? 0);
    return p.seq > after ? p : undefined;
  }
}

// ---------------------------------------------------------------------------------
// Session summary / view / derived state
// ---------------------------------------------------------------------------------

export interface JournalSummary {
  lastSeq: number;
  completedTurns: number;
  startedTurns: number;
  openTurn?: TurnRecord;
  lastTurn?: TurnRecord;
  pendingPermission?: PermissionRecord;
  lastActorStarted?: { seq: number; at: string; pid: number; mode: 'fresh' | 'resume' };
  lastActorStopped?: { seq: number; at: string; reason: string; error?: string };
  providerSessionId?: string;
  transcriptPath?: string;
}

export function summarizeLedger(l: TurnLedger): JournalSummary {
  const s: JournalSummary = {
    lastSeq: l.lastSeq,
    completedTurns: l.completedTurns,
    startedTurns: l.startedTurns,
  };
  const open = l.openTurn;
  if (open) s.openTurn = { ...open };
  if (l.lastTurn) s.lastTurn = { ...l.lastTurn };
  const perm = l.pendingPermission;
  if (perm) s.pendingPermission = perm;
  if (l.lastActorStarted) s.lastActorStarted = l.lastActorStarted;
  if (l.lastActorStopped) s.lastActorStopped = l.lastActorStopped;
  if (l.providerSessionId) s.providerSessionId = l.providerSessionId;
  if (l.transcriptPath) s.transcriptPath = l.transcriptPath;
  return s;
}

export function summarizeJournal(entries: Iterable<JournalEntry>): JournalSummary {
  return summarizeLedger(TurnLedger.from(entries));
}

/** Everything `deriveState` needs, gathered by client.inspect(). JSON-serialisable. */
export interface SessionView {
  sessionId: string;
  /** spawn.json exists. */
  exists: boolean;
  spec?: SpawnSpec;
  actor?: ActorStateFile;
  /** leaseLive(actor) at observation time. */
  live: boolean;
  pending: {
    /** Message items not yet turned into an intent. */
    messages: number;
    interrupts: number;
    stops: number;
    messageIds: string[];
  };
  summary: JournalSummary;
  /** Last few journal entries (display only; derivation uses `summary`). */
  tail: JournalEntry[];
  observedAt: string;
}

export interface DerivedState {
  state: AgentState;
  phase: ActorPhase | 'missing';
  live: boolean;
  /** Explicitly stopped (sticky; never wakes). */
  stopped: boolean;
  /** Not live, not stopped: resumable by a send/ensureAwake. */
  suspended: boolean;
  openTurn?: { messageId: string; intentAt: string; startedAt?: string };
  lastTurn?: {
    messageId: string;
    outcome: TurnOutcome;
    at?: string;
    error?: string;
    reason?: TurnInterruptReason;
    result?: string;
  };
  pendingPermission?: PermissionRecord;
  pendingMessages: number;
  providerSessionId?: string;
  transcriptPath?: string;
  stopReason?: string;
}

/**
 * Design §4.4 + brief decision 3:
 * - missing session            → failed
 * - phase stopped              → failed {stopped:true, suspended:false}
 * - not live                   → failed {suspended:true}
 * - live, phase starting       → starting (provider not initialised yet)
 * - pending permission request → waiting
 * - open turn or queued msgs   → running
 * - last turn failed           → failed (live)
 * - otherwise                  → done
 */
export function deriveState(view: SessionView): DerivedState {
  const s = view.summary;
  const out: DerivedState = {
    state: 'failed',
    phase: view.actor?.phase ?? 'missing',
    live: view.live,
    stopped: false,
    suspended: false,
    pendingMessages: view.pending.messages,
  };
  if (s.openTurn) {
    out.openTurn = { messageId: s.openTurn.messageId, intentAt: s.openTurn.intentAt };
    if (s.openTurn.startedAt) out.openTurn.startedAt = s.openTurn.startedAt;
  }
  if (s.lastTurn?.outcome) {
    const t = s.lastTurn;
    out.lastTurn = { messageId: t.messageId, outcome: t.outcome! };
    if (t.outcomeAt) out.lastTurn.at = t.outcomeAt;
    if (t.error !== undefined) out.lastTurn.error = t.error;
    if (t.reason !== undefined) out.lastTurn.reason = t.reason;
    if (t.result !== undefined) out.lastTurn.result = t.result;
  }
  if (s.pendingPermission) out.pendingPermission = s.pendingPermission;
  const psid = view.spec?.providerSessionId ?? view.actor?.providerSessionId ?? s.providerSessionId;
  if (psid) out.providerSessionId = psid;
  const tpath = view.spec?.transcriptPath ?? s.transcriptPath;
  if (tpath) out.transcriptPath = tpath;
  if (view.actor?.stopReason) out.stopReason = view.actor.stopReason;

  if (!view.exists || !view.actor) return out;
  if (view.actor.phase === 'stopped') {
    out.stopped = true;
    return out;
  }
  if (!view.live) {
    out.suspended = true;
    return out;
  }
  if (view.actor.phase === 'starting') out.state = 'starting';
  else if (s.pendingPermission) out.state = 'waiting';
  else if (s.openTurn || view.pending.messages > 0) out.state = 'running';
  else if (s.lastTurn?.outcome === 'failed') out.state = 'failed';
  else out.state = 'done';
  return out;
}

// ---------------------------------------------------------------------------------
// Delivery verdicts
// ---------------------------------------------------------------------------------

/**
 * - queued        in the inbox, or intent written by a live actor but not yet acked
 * - acknowledged  the provider accepted it (turn.started) and the turn has no outcome yet,
 *                 or it was cut by a crash (turn.interrupted{recovered}) AFTER the ack
 * - unknown       intent written but no ack before the turn was cut (crash, provider exit,
 *                 stop) or before the actor died: may or may not have reached the provider.
 *                 Never auto-resubmitted.
 * - completed / failed / interrupted  turn outcome (interrupted = after the ack)
 * - absent        never seen
 */
export type DeliveryVerdict =
  | 'queued'
  | 'acknowledged'
  | 'unknown'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'absent';

export function verdictFor(turn: TurnRecord | undefined, inInbox: boolean, live: boolean): DeliveryVerdict {
  if (turn) {
    const started = turn.startedSeq !== undefined;
    switch (turn.outcome) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'interrupted':
        if (!started) return 'unknown';
        return turn.reason === 'recovered' ? 'acknowledged' : 'interrupted';
      default:
        if (started) return 'acknowledged';
        return live ? 'queued' : 'unknown';
    }
  }
  return inInbox ? 'queued' : 'absent';
}
