/**
 * Actor state file (state.json), the lease, and zombie-aware process liveness.
 *
 * state.json is written tmp+rename under the brief `actor-<sid>` lock. The lease
 * (pid + startTime + token + expiresAt) is the single-writer truth: a session is live iff
 * its phase is active, the lease has not expired, and the lease process is still the same
 * (non-zombie) process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, sanitizeLockName } from '../lock.ts';
import type { LockOptions } from '../lock.ts';
import { locksDir } from '../paths.ts';
import { isPidAlive, isSameProcessAlive, signalProcessGroup } from './process.ts';
import { RUNTIME_SCHEMA_VERSION } from './types.ts';
import type { ActorPhase, ActorStateFile, ProcessIdentity } from './types.ts';
import { sessionPaths } from './layout.ts';
import { readJsonFile, writeFileAtomic } from './fsutil.ts';

// ---------------------------------------------------------------------------------
// Liveness (zombie-aware)
// ---------------------------------------------------------------------------------

/**
 * Process state letter (`R`, `S`, `Z`, …) or null when the process is gone/unknown.
 * Linux: /proc/<pid>/stat field 3. Elsewhere: `ps -o stat=`.
 */
export function processStateLetter(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? null;
  } catch {
    if (process.platform === 'linux') return null;
  }
  try {
    const r = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0 && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * A dead-but-unreaped process. kill(pid, 0) succeeds on zombies, and orphans are not
 * reaped when PID 1 is not a real init (common in containers), so liveness must check.
 */
export function isZombie(pid: number): boolean {
  const s = processStateLetter(pid);
  return s !== null && (s.startsWith('Z') || s.startsWith('X'));
}

/** Same process (pid + start time) and not a zombie. */
export function isLiveProcess(id: ProcessIdentity | undefined | null): boolean {
  return !!id && isSameProcessAlive(id) && !isZombie(id.pid);
}

function trySignalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    signalProcessGroup(pgid, signal);
  } catch {
    /* EPERM / invalid: nothing we can do */
  }
}

/**
 * Terminate the process group led by `id` iff it is still the same live process:
 * SIGTERM, wait up to graceMs, then SIGKILL. Stragglers in the group are SIGKILLed once
 * the leader is gone. Zombie-aware (unlike process.ts terminateProcessGroup, which waits
 * out the full grace on an unreaped zombie). Returns true when something was signalled.
 */
export async function terminateGroup(
  id: ProcessIdentity | undefined | null,
  graceMs = 2_000,
): Promise<boolean> {
  if (!id || !isLiveProcess(id)) return false;
  trySignalGroup(id.pid, 'SIGTERM');
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline && isLiveProcess(id)) await Bun.sleep(25);
  if (isLiveProcess(id)) {
    trySignalGroup(id.pid, 'SIGKILL');
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && isLiveProcess(id)) await Bun.sleep(25);
  }
  // Leader gone (or zombie): the pgid stays valid (and its id unreusable) while members
  // remain — sweep them. ESRCH (no members) is ignored.
  trySignalGroup(id.pid, 'SIGKILL');
  return true;
}

// ---------------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------------

export const ACTOR_LOCK_OPTIONS: LockOptions = { staleMs: 10_000, timeoutMs: 15_000 };

export function actorLockName(sessionId: string): string {
  return `actor-${sessionId}`;
}

/**
 * Remove `name`'s lock file iff its recorded owner pid is dead or a zombie. Uses lock.ts's
 * own `<lock>.cleanup` protocol (O_EXCL + owner-token recheck), so it never races lock.ts
 * stale recovery or a fresh acquirer. lock.ts alone waits `staleMs` before reclaiming a
 * dead owner's lock and never reclaims one held by an unreaped zombie.
 */
export function reclaimDeadOwnerLock(name: string): boolean {
  const lockPath = path.join(locksDir(), `${sanitizeLockName(name)}.lock`);
  const readOwner = (): { pid?: number; token?: string } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; token?: string };
    } catch {
      return undefined;
    }
  };
  const owner = readOwner();
  if (!owner?.pid || !owner.token) return false;
  if (isPidAlive(owner.pid) && !isZombie(owner.pid)) return false;
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
 * Run `fn` holding the named lock (lock.ts, ACTOR_LOCK_OPTIONS), reclaiming it promptly
 * when its owner died while holding it (e.g. an actor SIGKILLed mid state-write).
 */
export async function withSessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + (ACTOR_LOCK_OPTIONS.timeoutMs ?? 15_000);
  let release: () => Promise<void>;
  while (true) {
    try {
      release = await acquireLock(name, {
        ...ACTOR_LOCK_OPTIONS,
        timeoutMs: Math.max(1, Math.min(250, deadline - Date.now())),
      });
      break;
    } catch (e) {
      if (!/timed out waiting for lock/.test((e as Error).message) || Date.now() >= deadline) throw e;
      reclaimDeadOwnerLock(name);
    }
  }
  try {
    return await fn();
  } finally {
    await release();
  }
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
