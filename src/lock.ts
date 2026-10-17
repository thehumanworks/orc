/**
 * Cross-process filesystem lock under ORC_HOME. Atomic create (open 'wx'), bounded
 * wait, and stale-lock recovery. Prefer this over an in-memory mutex whenever
 * concurrent CLI/daemon/process writers can race.
 *
 * Recovery: a lock whose recorded owner is provably gone — pid dead, an unreaped zombie,
 * or the pid now names another process (start time changed) — is reclaimed on the next
 * poll, not after `staleMs` (a runner SIGKILLed inside `run:<id>` no longer blocks that
 * run for 5 minutes). `staleMs` still governs a lock whose owner was never written
 * (creator died between create and write). Removal always happens under the
 * `<lock>.cleanup` lock after re-reading the owner.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { orcHome } from './paths.ts';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './private-fs.ts';
import { isPidAlive, isSameProcessAlive, processStartTime } from './runtime/process.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 300_000;
const DEFAULT_POLL_MS = 25;
const CLEANUP_SUFFIX = '.cleanup';
/**
 * A `.cleanup` lock whose owner died is reclaimed only once it is this old: cleanup
 * sections last microseconds, so a live cleaner is never preempted.
 */
const CLEANUP_DEAD_OWNER_GRACE_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LockOptions {
  /** Give up after this long waiting for the lock. Default 30s. */
  timeoutMs?: number;
  /**
   * A lock file older than this whose owner was never recorded (or whose pid is dead) is
   * stale. Default 5m. A recorded owner that is provably gone is reclaimed immediately.
   */
  staleMs?: number;
  /** Poll interval while waiting. Default 25ms. */
  pollMs?: number;
  /** Override the locks directory (tests). Default ~/.orc/locks. */
  locksDir?: string;
}

interface LockOwner {
  pid?: number;
  token?: string;
  createdAt?: string;
  /** Owner's process start-time token (pid-reuse guard); absent in older lock files. */
  startTime?: string | null;
  /** Owner's hostname: pids from another host (shared ORC_HOME) are not comparable. */
  host?: string;
}

let selfStartTime: string | null | undefined;

/** The owner JSON written into every lock file (pid + start time + host + token). */
export function lockOwnerRecord(token: string): string {
  if (selfStartTime === undefined) selfStartTime = processStartTime(process.pid);
  return JSON.stringify({
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    ...(selfStartTime ? { startTime: selfStartTime } : {}),
  });
}

/**
 * The lock's recorded owner provably no longer exists: its pid is dead, an unreaped
 * zombie, or now names a different process (start time changed). An owner that is not
 * recorded (empty/unparseable file), or was recorded on another host (shared ORC_HOME,
 * different pid namespace), is NOT provably gone — `staleMs` governs those cases.
 */
export function lockOwnerGone(owner: { pid?: unknown; startTime?: unknown; host?: unknown }): boolean {
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (typeof owner.host === 'string' && owner.host !== os.hostname()) return false;
  return !isSameProcessAlive({ pid: owner.pid, startTime: typeof owner.startTime === 'string' ? owner.startTime : null });
}

/** Sanitize a lock name for use as a single path segment (no traversal). */
export function sanitizeLockName(name: string): string {
  // Drop path separators and `..` segments first so `../evil/name` → `evil-name`.
  const cleaned = name
    .replace(/\.\./g, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  // All-dots (or empty) is not a usable path segment — fall back.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return 'lock';
  return cleaned.slice(0, 128);
}

function locksBase(opts?: LockOptions): string {
  return opts?.locksDir ?? path.join(orcHome(), 'locks');
}

async function readOwner(lockPath: string): Promise<LockOwner> {
  try {
    return JSON.parse(await Bun.file(lockPath).text()) as LockOwner;
  } catch {
    return {};
  }
}

async function acquireCleanupLock(lockPath: string, timeoutMs: number, pollMs: number): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(lockOwnerRecord(token));
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = await readOwner(lockPath);
          if (owner.token === token) await fs.rm(lockPath, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
      // A cleaner that died inside its (microsecond) section would otherwise wedge every
      // future recovery of this lock.
      const st = await fs.stat(lockPath).catch(() => null);
      if (st && Date.now() - st.mtimeMs > CLEANUP_DEAD_OWNER_GRACE_MS) {
        const owner = await readOwner(lockPath);
        if (lockOwnerGone(owner) && (await readOwner(lockPath)).token === owner.token) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock cleanup: ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }
}

async function tryRemoveStaleLock(
  lockPath: string,
  staleMs: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const releaseCleanup = await acquireCleanupLock(`${lockPath}${CLEANUP_SUFFIX}`, timeoutMs, pollMs);
  try {
    const st = await fs.stat(lockPath).catch(() => null);
    if (!st) return true;
    // Re-read under the cleanup lock: a fresh acquirer may have replaced it meanwhile.
    const owner = await readOwner(lockPath);
    if (!lockOwnerGone(owner)) {
      if (Date.now() - st.mtimeMs <= staleMs) return false;
      if (owner.pid && isPidAlive(owner.pid)) return false; // a live owner is never robbed
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await releaseCleanup();
  }
}

/**
 * Acquire an exclusive lock named `name` under ORC_HOME/locks/. Returns a release
 * function that is idempotent. Always call release in a finally block (or use
 * `withLock`).
 */
export async function acquireLock(name: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const dir = locksBase(opts);
  ensurePrivateDir(dir);
  const lockPath = path.join(dir, `${sanitizeLockName(name)}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(lockOwnerRecord(token));
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = await readOwner(lockPath);
          if (owner.token === token) await fs.rm(lockPath, { force: true });
        } catch {
          /* already released or stolen */
        }
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;

      let st: Stats;
      try {
        st = await fs.stat(lockPath);
      } catch (statError) {
        if ((statError as { code?: string }).code === 'ENOENT') continue;
        throw statError;
      }

      if (Date.now() - st.mtimeMs > staleMs || lockOwnerGone(await readOwner(lockPath))) {
        if (await tryRemoveStaleLock(lockPath, staleMs, timeoutMs, pollMs)) continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock '${name}': ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }
}

/** Run `fn` while holding the named lock; always releases, including on throw. */
export async function withLock<T>(name: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const release = await acquireLock(name, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}
