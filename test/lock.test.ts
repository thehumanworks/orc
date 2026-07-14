import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, sanitizeLockName, withLock } from '../src/lock.ts';

const tmpDirs: string[] = [];
async function freshLocksDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-lock-'));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('sanitizeLockName', () => {
  test('keeps safe names and collapses junk', () => {
    expect(sanitizeLockName('send-abc123')).toBe('send-abc123');
    expect(sanitizeLockName('../evil/name')).toBe('evil-name');
    expect(sanitizeLockName('')).toBe('lock');
  });
});

describe('filesystem lock', () => {
  test('serializes concurrent acquirers (deterministic barrier, no long sleep)', async () => {
    const locksDir = await freshLocksDir();
    const order: string[] = [];
    const firstReady = Promise.withResolvers<void>();
    const allowFirstRelease = Promise.withResolvers<void>();

    const first = (async () => {
      const release = await acquireLock('send-sess1', { locksDir, timeoutMs: 2_000, pollMs: 5 });
      order.push('first-acquired');
      firstReady.resolve();
      await allowFirstRelease.promise;
      order.push('first-releasing');
      await release();
    })();

    await firstReady.promise;

    const second = (async () => {
      const release = await acquireLock('send-sess1', {
        locksDir,
        timeoutMs: 2_000,
        pollMs: 5,
      });
      order.push('second-acquired');
      await release();
    })();

    // Give the second waiter time to block on the lock, then release the first.
    await new Promise<void>((r) => setTimeout(r, 30));
    allowFirstRelease.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-acquired', 'first-releasing', 'second-acquired']);
    const files = await fs.readdir(locksDir);
    expect(files.filter((f) => f.endsWith('.lock') && !f.includes('cleanup'))).toEqual([]);
  });

  test('withLock always releases after error', async () => {
    const locksDir = await freshLocksDir();
    await expect(
      withLock(
        'send-err',
        async () => {
          throw new Error('boom');
        },
        { locksDir, timeoutMs: 1_000, pollMs: 5 },
      ),
    ).rejects.toThrow(/boom/);

    // A subsequent acquire must succeed immediately (lock not stuck).
    const release = await acquireLock('send-err', { locksDir, timeoutMs: 200, pollMs: 5 });
    await release();
  });

  test('independent lock names do not block each other', async () => {
    const locksDir = await freshLocksDir();
    const a = await acquireLock('send-a', { locksDir });
    const b = await acquireLock('send-b', { locksDir });
    await a();
    await b();
  });

  test('stale lock with dead owner is reclaimed', async () => {
    const locksDir = await freshLocksDir();
    const lockPath = path.join(locksDir, `${sanitizeLockName('stale-one')}.lock`);
    await fs.mkdir(locksDir, { recursive: true });
    // Pid 2^31-2 is almost never a live process; kill(pid,0) → ESRCH.
    await Bun.write(
      lockPath,
      JSON.stringify({ pid: 2_147_483_646, token: 'dead', createdAt: new Date(0).toISOString() }),
    );
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);

    const release = await acquireLock('stale-one', {
      locksDir,
      staleMs: 10,
      timeoutMs: 1_000,
      pollMs: 5,
    });
    await release();
  });
});
