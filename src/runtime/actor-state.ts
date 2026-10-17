/**
 * Actor state file (state.json), the lease, and the per-session locks.
 *
 * state.json is written tmp+rename under the brief `actor-<sid>` lock. The lease
 * (pid + startTime + token + expiresAt) is the single-writer truth: a session is live iff
 * its phase is active, the lease has not expired, and the lease process is still the same
 * (non-zombie) process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockOwnerGone, sanitizeLockName, withLock } from '../lock.ts';
import type { LockOptions } from '../lock.ts';
import { locksDir } from '../paths.ts';
import { isLiveProcess } from './process.ts';
import { RUNTIME_SCHEMA_VERSION } from './types.ts';
import type { ActorPhase, ActorStateFile } from './types.ts';
import { sessionPaths } from './layout.ts';
import { readJsonFile, writeFileAtomic } from './fsutil.ts';

// Liveness lives in ./process.ts (zombie-aware); re-exported here for kernel callers.
export { isLiveProcess, isZombie, probeProcess, terminateGroup } from './process.ts';

// ---------------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------------

export const ACTOR_LOCK_OPTIONS: LockOptions = { staleMs: 10_000, timeoutMs: 15_000 };

/** Provider close grace for stop when the caller does not say (client + actor). */
export const DEFAULT_STOP_GRACE_MS = 5_000;

export function actorLockName(sessionId: string): string {
  return `actor-${sessionId}`;
}

/**
 * Remove `name`'s lock file now iff its recorded owner is provably gone (dead, zombie or
 * pid reused — lockOwnerGone). Uses lock.ts's `<lock>.cleanup` protocol (O_EXCL +
 * owner-token recheck), so it never races lock.ts recovery or a fresh acquirer. (lock.ts
 * performs the same reclaim itself on its next poll; this is the synchronous form.)
 */
export function reclaimDeadOwnerLock(name: string): boolean {
  const lockPath = path.join(locksDir(), `${sanitizeLockName(name)}.lock`);
  const readOwner = (): { pid?: number; token?: string; startTime?: string | null } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; token?: string; startTime?: string | null };
    } catch {
      return undefined;
    }
  };
  const owner = readOwner();
  if (!owner?.pid || !owner.token) return false;
  if (!lockOwnerGone(owner)) return false; // dead / zombie / pid reused only
  const cleanup = `${lockPath}.cleanup`;
  let fd: number;
  try {
    fd = fs.openSync(cleanup, 'wx', 0o600);
  } catch {
    return false; // someone else is cleaning up
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
    if (readOwner()?.token !== owner.token) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(cleanup, { force: true });
  }
}

/**
 * Run `fn` holding the named lock (lock.ts, ACTOR_LOCK_OPTIONS). A lock left by an owner
 * that died while holding it (e.g. an actor SIGKILLed mid state-write) is reclaimed by
 * lock.ts on its next poll.
 */
export function withSessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  // lock.ts itself reclaims a lock whose owner is provably gone on its next poll.
  return withLock(name, fn, ACTOR_LOCK_OPTIONS);
}

/** Run `fn` under the brief per-session actor lock (lease acquire/renew, wake, stop). */
export function withActorLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return withSessionLock(actorLockName(sessionId), fn);
}

export function initialActorState(sessionId: string, phase: ActorPhase = 'starting'): ActorStateFile {
  return {
    version: RUNTIME_SCHEMA_VERSION,
    sessionId,
    phase,
    lastSeq: 0,
    completedTurns: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function readActorState(sessionId: string): ActorStateFile | undefined {
  return readJsonFile<ActorStateFile>(sessionPaths(sessionId).state);
}

/** Atomic replace (0600). Heartbeats skip fsync; phase transitions may request it. */
export function writeActorState(state: ActorStateFile, opts: { fsync?: boolean } = {}): void {
  writeFileAtomic(sessionPaths(state.sessionId).state, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    fsync: opts.fsync ?? false,
  });
}

const ACTIVE_PHASES: ReadonlySet<ActorPhase> = new Set(['starting', 'running', 'stopping']);

/** phase ∈ {starting, running, stopping} ∧ lease unexpired ∧ lease process is the same live process. */
export function leaseLive(state: ActorStateFile | undefined, now: number = Date.now()): boolean {
  if (!state || !ACTIVE_PHASES.has(state.phase) || !state.lease) return false;
  const exp = Date.parse(state.lease.expiresAt);
  if (!Number.isFinite(exp) || exp <= now) return false;
  return isLiveProcess(state.lease);
}
