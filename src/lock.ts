/**
 * Cross-process filesystem lock under ORC_HOME. Atomic create (open 'wx'), bounded
 * wait, and stale-lock recovery. Prefer this over an in-memory mutex whenever
 * concurrent CLI/daemon/process writers can race.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { orcHome } from './paths.ts';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './private-fs.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 300_000;
const DEFAULT_POLL_MS = 25;
const CLEANUP_SUFFIX = '.cleanup';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LockOptions {
  /** Give up after this long waiting for the lock. Default 30s. */
  timeoutMs?: number;
  /** Treat a lock file older than this as stale (then reclaim if owner pid is dead). Default 5m. */
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
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
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        );
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
    if (Date.now() - st.mtimeMs <= staleMs) return false;

    const owner = await readOwner(lockPath);
    if (owner.pid && processIsAlive(owner.pid)) return false;

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
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        );
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

      if (Date.now() - st.mtimeMs > staleMs) {
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
