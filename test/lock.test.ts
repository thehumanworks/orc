import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, sanitizeLockName, withLock } from '../src/lock.ts';
import { isZombie, processStartTime } from '../src/runtime/process.ts';
import { readRegistry, upsertRecord } from '../src/registry.ts';

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

  /** Write a lock file `name` in `locksDir` owned by `owner`, with a FRESH mtime. */
  async function plantLock(locksDir: string, name: string, owner: Record<string, unknown>): Promise<string> {
    await fs.mkdir(locksDir, { recursive: true });
    const lockPath = path.join(locksDir, `${sanitizeLockName(name)}.lock`);
    await Bun.write(lockPath, JSON.stringify({ token: 'planted', createdAt: new Date().toISOString(), ...owner }));
    return lockPath;
  }

  async function deadPid(): Promise<number> {
    const p = Bun.spawn(['true']);
    await p.exited;
    return p.pid;
  }

  test('a FRESH lock whose owner is dead is reclaimed on the next poll (no staleMs wait)', async () => {
    const locksDir = await freshLocksDir();
    await plantLock(locksDir, 'run:dead1', { pid: await deadPid() });
    const t0 = Date.now();
    const release = await acquireLock('run:dead1', { locksDir, timeoutMs: 5_000 }); // default staleMs (5 min)
    expect(Date.now() - t0).toBeLessThan(1_000);
    await release();
  });

  test('a lock held by an unreaped zombie is reclaimed', async () => {
    const locksDir = await freshLocksDir();
    // `sleep 10` (exec'd shell) never reaps its finished `sleep 0.05` child → zombie.
    const proc = Bun.spawn(['sh', '-c', 'sleep 0.05 & echo $!; exec sleep 10'], { stdout: 'pipe' });
    const { value } = await proc.stdout.getReader().read();
    const zpid = Number(new TextDecoder().decode(value).trim());
    try {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !isZombie(zpid)) await Bun.sleep(10);
      expect(isZombie(zpid)).toBe(true);
      await plantLock(locksDir, 'zombie-held', { pid: zpid, startTime: processStartTime(zpid) });
      const release = await acquireLock('zombie-held', { locksDir, timeoutMs: 2_000 });
      await release();
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  });

  test('a reused pid (alive, different start time) is not the owner: reclaimed', async () => {
    const locksDir = await freshLocksDir();
    const own = processStartTime(process.pid)!;
    const other = own.startsWith('proc:') ? 'proc:1' : 'ps:Thu Jan  1 00:00:00 1970';
    await plantLock(locksDir, 'reused', { pid: process.pid, startTime: other });
    const release = await acquireLock('reused', { locksDir, timeoutMs: 2_000 });
    await release();
  });

  test('a live owner is never robbed — not even past staleMs; an unwritten owner waits for staleMs', async () => {
    const locksDir = await freshLocksDir();
    const live = await plantLock(locksDir, 'live-held', { pid: process.pid, startTime: processStartTime(process.pid) });
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(live, past, past);
    await expect(acquireLock('live-held', { locksDir, staleMs: 10, timeoutMs: 300, pollMs: 10 })).rejects.toThrow(/timed out/);
    expect(await Bun.file(live).exists()).toBe(true);

    const empty = path.join(locksDir, `${sanitizeLockName('unwritten')}.lock`);
    await Bun.write(empty, '');
    await expect(acquireLock('unwritten', { locksDir, timeoutMs: 300, pollMs: 10 })).rejects.toThrow(/timed out/);
    await fs.utimes(empty, past, past);
    const release = await acquireLock('unwritten', { locksDir, staleMs: 10, timeoutMs: 1_000, pollMs: 5 });
    await release();
  });

  test('a dead pid recorded on ANOTHER host is not provably gone: only staleMs reclaims it', async () => {
    const locksDir = await freshLocksDir();
    const foreign = await plantLock(locksDir, 'foreign', { pid: await deadPid(), host: `not-${os.hostname()}` });
    await expect(acquireLock('foreign', { locksDir, timeoutMs: 300, pollMs: 10 })).rejects.toThrow(/timed out/);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(foreign, past, past);
    const release = await acquireLock('foreign', { locksDir, staleMs: 10, timeoutMs: 1_000, pollMs: 5 });
    await release();
    // Our own records carry this host, so same-host dead owners stay fast (previous tests).
    await plantLock(locksDir, 'own-host', { pid: await deadPid(), host: os.hostname() });
    const t0 = Date.now();
    const releaseOwn = await acquireLock('own-host', { locksDir, timeoutMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    await releaseOwn();
  });

  test("a cleaner that died inside its .cleanup section does not wedge recovery", async () => {
    const locksDir = await freshLocksDir();
    const lockPath = await plantLock(locksDir, 'wedged', { pid: await deadPid() });
    const cleanup = `${lockPath}.cleanup`;
    await Bun.write(cleanup, JSON.stringify({ pid: await deadPid(), token: 'dead-cleaner' }));
    const past = new Date(Date.now() - 10_000);
    await fs.utimes(cleanup, past, past);
    const release = await acquireLock('wedged', { locksDir, timeoutMs: 3_000 });
    await release();
    expect(await Bun.file(cleanup).exists()).toBe(false);
  });

  test('a process SIGKILLed while holding run:<id> does not block the next acquirer', async () => {
    const locksDir = await freshLocksDir();
    const mod = path.resolve(import.meta.dir, '..', 'src', 'lock.ts');
    const script = [
      `import { acquireLock } from ${JSON.stringify(mod)};`,
      `await acquireLock('run:killed', { locksDir: ${JSON.stringify(locksDir)} });`,
      `console.log('held');`,
      `await Bun.sleep(60_000);`,
    ].join('\n');
    const holder = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const reader = holder.stdout.getReader();
    let out = '';
    while (!out.includes('held')) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain('held');
    holder.kill('SIGKILL');
    await holder.exited;
    const t0 = Date.now();
    const value = await withLock('run:killed', async () => 'acquired', { locksDir, timeoutMs: 5_000 });
    expect(value).toBe('acquired');
    expect(Date.now() - t0).toBeLessThan(1_500);
  }, 15_000);

  test('the registry lock gets the same dead-owner recovery', async () => {
    const home = await freshLocksDir();
    const prev = process.env.ORC_HOME;
    process.env.ORC_HOME = home;
    try {
      await Bun.write(path.join(home, '.registry.lock'), JSON.stringify({ pid: await deadPid(), token: 'dead' }));
      const t0 = Date.now();
      await upsertRecord({
        id: 'lockreg1',
        sessionId: 'lockreg1-0000-0000-0000-000000000000',
        provider: 'claude',
        cwd: home,
        workspace: home,
        createdAt: new Date().toISOString(),
      });
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect((await readRegistry()).map((r) => r.id)).toContain('lockreg1');
    } finally {
      if (prev === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = prev;
    }
  });
});
