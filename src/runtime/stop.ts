/**
 * Finalizing a sticky stop without a live actor — shared by the client (stop(),
 * ensureAwake, reopen) and the actor's lease acquisition.
 *
 * A session can be left `stopping` with a dead lease: the actor accepted a stop (phase
 * `stopping` + stopReason persisted) and died before writing `stopped`. That is a stop
 * in progress, never a resumable crash: whoever next holds the actor lock finishes it.
 */
import { isLiveProcess, terminateGroup } from './process.ts';
import type { ActorStateFile } from './types.ts';
import { JournalWriter, readJournal } from './journal.ts';
import { listPending, removeInboxItem } from './inbox.ts';
import { writeActorState } from './actor-state.ts';
import { TurnLedger, staleProviders } from './derive.ts';

/** `stopping` whose actor is gone (the caller has already checked the lease is not live). */
export function isAbandonedStop(st: ActorStateFile | undefined): boolean {
  return st?.phase === 'stopping';
}

/**
 * The reason of a stop that is being finished: the one the actor persisted with
 * `stopping`, else a still-queued stop item's, else `fallback`.
 */
export function abandonedStopReason(sessionId: string, st: ActorStateFile, fallback = 'stop'): string {
  if (st.stopReason) return st.stopReason;
  const item = listPending(sessionId).find((i) => i.kind === 'stop');
  return (item?.kind === 'stop' ? item.reason : undefined) ?? fallback;
}

/**
 * Make the session `stopped` (sticky) with `reason`. Caller holds the actor lock and no
 * actor is live (the lease may name this very process — it is never signalled). Kills a
 * still-running lease holder and every stale provider, closes open intents as recovered,
 * drops queued messages (inbox.dropped), journals actor.stopped, writes the state, and
 * clears leftover control items.
 */
export async function finalizeStopLocked(sessionId: string, st: ActorStateFile, reason: string): Promise<void> {
  if (st.lease && st.lease.pid !== process.pid && isLiveProcess(st.lease)) await terminateGroup(st.lease, 1_000);
  const ledger = TurnLedger.from(readJournal(sessionId));
  for (const id of staleProviders(st, ledger)) await terminateGroup(id, 1_000);
  // No live actor and the lock is held: this process is the only journal writer.
  const j = JournalWriter.forSession(sessionId);
  try {
    for (const t of ledger.openTurns()) {
      j.append({ type: 'turn.interrupted', messageId: t.messageId, reason: 'recovered' });
      removeInboxItem(sessionId, t.ulid);
    }
    for (const it of listPending(sessionId)) {
      if (it.kind !== 'message' || ledger.intentUlids.has(it.ulid)) continue;
      j.append({ type: 'inbox.dropped', ulid: it.ulid, messageId: it.messageId, reason: 'stopped' });
      removeInboxItem(sessionId, it.ulid);
    }
    j.append({ type: 'actor.stopped', reason: 'stop', ...(reason !== 'stop' ? { error: reason } : {}) });
    st.lastSeq = Math.max(st.lastSeq, j.lastSeq);
  } finally {
    j.close();
  }
  st.phase = 'stopped';
  st.stopReason = reason;
  delete st.lease;
  if (!st.provider || !isLiveProcess(st.provider)) delete st.provider;
  st.updatedAt = new Date().toISOString();
  writeActorState(st, { fsync: true });
  for (const it of listPending(sessionId)) {
    if (it.kind !== 'message') removeInboxItem(sessionId, it.ulid);
  }
}
