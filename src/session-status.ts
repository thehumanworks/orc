/**
 * Session lifecycle status from the actor kernel (decision D1). Synchronous and cheap:
 * reads spawn.json + state.json only (never the journal).
 *
 *   running    actor lease live
 *   suspended  not live, not stopped, spawn.json present → resumable
 *   spawning   young reservation whose spawn.json is not written yet (spawn in progress)
 *   dead       stopped (kill/takeover), legacy tmux record, record marked dead, no
 *              spawn.json (past the spawn grace), or a session from the removed Codex integration that is not running
 */
import { readSpawnSpec } from './runtime/spec.ts';
import { readActorState } from './runtime/actor-state.ts';
import { leaseLive } from './runtime/client.ts';
import type { SessionRecord, SessionStatus } from './types.ts';

/** How liveness is observed. Injectable (tests); default = the kernel. */
export type LivenessProbe = (rec: SessionRecord) => SessionStatus;

/** A reservation younger than this without spawn.json is a spawn in progress. */
export const SPAWN_PENDING_GRACE_MS = 600_000;

export function sessionStatusOf(
  rec: Pick<SessionRecord, 'sessionId' | 'status' | 'legacy'> & { createdAt?: string; provider?: SessionRecord['provider'] },
): SessionStatus {
  if (rec.legacy) return 'dead';
  try {
    const spec = readSpawnSpec(rec.sessionId);
    if (!spec) return isSpawnPending(rec) ? 'spawning' : 'dead';
    const st = readActorState(rec.sessionId);
    if (leaseLive(st)) return 'running';
    if (spec.provider === 'codex') return 'dead';
    if (rec.status === 'dead' || st?.phase === 'stopped') return 'dead';
    return 'suspended';
  } catch {
    // Invalid session id / unreadable state: nothing the kernel can control.
    return 'dead';
  }
}

export const kernelLiveness: LivenessProbe = (rec) => sessionStatusOf(rec);

/**
 * A record reserved by agent() whose kernel session does not exist yet (spawn in
 * progress). Counted against maxConcurrentSessions and never pruned while young.
 */
export function isSpawnPending(
  rec: Pick<SessionRecord, 'sessionId' | 'status' | 'legacy'> & { createdAt?: string; provider?: SessionRecord['provider'] },
  now: number = Date.now(),
): boolean {
  if (rec.legacy || rec.provider === 'codex' || rec.status === 'dead' || !rec.createdAt) return false;
  try {
    if (readSpawnSpec(rec.sessionId)) return false;
  } catch {
    return false;
  }
  const t = Date.parse(rec.createdAt);
  return Number.isFinite(t) && now - t < SPAWN_PENDING_GRACE_MS;
}

/** Sessions that hold (or are about to hold) a live actor: the concurrency budget. */
export function countLiveSessions(records: SessionRecord[], probe: LivenessProbe = kernelLiveness): number {
  return records.filter((r) => {
    const s = probe(r);
    return s === 'running' || s === 'spawning' || isSpawnPending(r);
  }).length;
}
