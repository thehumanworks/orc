import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.ts';
import { readRegistry, upsertRecord, removeRecord, findRecord } from '../src/registry.ts';
import { listSessions, pruneSessions } from '../src/index.ts';
import type { Driver } from '../src/drivers/driver.ts';
import type { SessionRecord } from '../src/types.ts';

/**
 * BUG 3 — kill() must MARK a record dead (keep it for transcript/metadata reads) rather
 * than hard-deleting it; --purge removes it; prune drops all dead records; list hides
 * dead by default. These run against an isolated ORC_HOME and a tmux session that does
 * not exist (kill-session on a missing name returns gracefully).
 */

const tmpHomes: string[] = [];
const registryWorker = path.join(import.meta.dir, 'fixtures', 'registry-worker.ts');

async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-kill-'));
  tmpHomes.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
  return process.env.ORC_HOME;
}

afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fs.rm(d, { recursive: true, force: true });
});

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  const ws = over.workspace ?? '/tmp/ws-kill-test';
  return {
    id: 'dead0001',
    sessionId: 'dead0001-0000-0000-0000-000000000000',
    provider: 'claude',
    tmuxName: 'orc-claude-dead0001-doesnotexist',
    cwd: ws,
    workspace: ws,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function livenessDriver(aliveNames: string[], throwNames: string[] = []): Driver {
  const alive = new Set(aliveNames);
  const throwing = new Set(throwNames);
  return {
    name: 'test-liveness',
    spawn: async () => {},
    capture: async () => '',
    sendKeys: async () => {},
    paste: async () => {},
    attach: async () => 0,
    attachCommand: () => '',
    kill: async () => {},
    isAlive: async (name: string) => {
      if (throwing.has(name)) throw new Error(`liveness failed for ${name}`);
      return alive.has(name);
    },
    list: async () => [],
  } as Driver;
}

async function runRegistryWorker(args: string[]): Promise<void> {
  const proc = Bun.spawn(['bun', registryWorker, ...args], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`registry worker failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
}

describe('kill marks dead, keeps record (BUG 3)', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('kill() sets status=dead + killedAt, keeps the record', async () => {
    const r = rec();
    await upsertRecord(r);
    const s = new Session(r);
    await s.kill();

    const all = await readRegistry();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe('dead');
    expect(typeof all[0]!.killedAt).toBe('string');

    // Still resolvable by id after kill (so transcript reads work).
    const found = await findRecord(r.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(r.id);
  });

  test('kill({purge:true}) removes the record entirely', async () => {
    const r = rec();
    await upsertRecord(r);
    const s = new Session(r);
    await s.kill({ purge: true });

    expect((await readRegistry()).length).toBe(0);
    expect(await findRecord(r.id)).toBeNull();
  });
});

describe('list hides dead by default (BUG 3)', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('dead records hidden by default, shown with all/dead', async () => {
    const ws = '/tmp/ws-list-test';
    const alive = rec({ id: 'alive001', tmuxName: 'orc-x-alive', workspace: ws, cwd: ws });
    const killed = rec({
      id: 'dead0002',
      tmuxName: 'orc-x-dead',
      workspace: ws,
      cwd: ws,
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(killed);

    const def = await listSessions({ workspace: ws });
    expect(def.map((s) => s.id).sort()).toEqual(['alive001']);

    const withDead = await listSessions({ workspace: ws, dead: true });
    expect(withDead.map((s) => s.id).sort()).toEqual(['alive001', 'dead0002']);

    const all = await listSessions({ all: true });
    expect(all.map((s) => s.id).sort()).toEqual(['alive001', 'dead0002']);
  });
});

describe('prune drops dead records (BUG 3)', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('pruneSessions removes only dead records', async () => {
    const alive = rec({ id: 'alive003', tmuxName: 'orc-x-a3' });
    const killed = rec({
      id: 'dead0003',
      tmuxName: 'orc-x-d3',
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(killed);

    const removed = await pruneSessions({ driver: livenessDriver(['orc-x-a3']) });
    expect(removed).toEqual(['dead0003']);

    const left = await readRegistry();
    expect(left.map((r) => r.id)).toEqual(['alive003']);
  });

  test('pruneSessions removes liveness-dead records without persisted dead status', async () => {
    const alive = rec({ id: 'alive005', tmuxName: 'orc-x-live5' });
    const stale = rec({ id: 'stale005', tmuxName: 'orc-x-stale5' });
    const killed = rec({
      id: 'dead0005',
      tmuxName: 'orc-x-dead5',
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(stale);
    await upsertRecord(killed);

    const removed = await pruneSessions({ driver: livenessDriver(['orc-x-live5']) });
    expect(removed.sort()).toEqual(['dead0005', 'stale005']);

    const left = await readRegistry();
    expect(left.map((r) => r.id)).toEqual(['alive005']);
  });

  test('pruneSessions returns [] when nothing dead', async () => {
    await upsertRecord(rec({ id: 'alive004', tmuxName: 'orc-x-a4' }));
    expect(await pruneSessions({ driver: livenessDriver(['orc-x-a4']) })).toEqual([]);
  });

  test('pruneSessions keeps records when liveness cannot be determined', async () => {
    const uncertain = rec({ id: 'maybe006', tmuxName: 'orc-x-throws6' });
    await upsertRecord(uncertain);

    expect(await pruneSessions({ driver: livenessDriver([], ['orc-x-throws6']) })).toEqual([]);
    expect((await readRegistry()).map((r) => r.id)).toEqual(['maybe006']);
  });

  test('pruneSessions does not remove a replacement record from a stale liveness result', async () => {
    const original = rec({ id: 'race007', tmuxName: 'orc-x-old7' });
    const replacement = rec({ id: 'race007', tmuxName: 'orc-x-new7' });
    await upsertRecord(original);

    const driver = {
      ...livenessDriver([]),
      isAlive: async () => {
        await upsertRecord(replacement);
        return false;
      },
    } as Driver;

    expect(await pruneSessions({ driver })).toEqual([]);
    expect(await readRegistry()).toEqual([replacement]);
  });
});

describe('registry mutations are serialized', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('concurrent upsertRecord calls preserve all records', async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec({ id: `up${String(i).padStart(6, '0')}`, tmuxName: `orc-x-up-${i}` }),
    );

    await Promise.all(records.map((r) => upsertRecord(r)));

    const ids = (await readRegistry()).map((r) => r.id).sort();
    expect(ids).toEqual(records.map((r) => r.id).sort());
  });

  test('concurrent removeRecord calls do not resurrect records', async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec({ id: `rm${String(i).padStart(6, '0')}`, tmuxName: `orc-x-rm-${i}` }),
    );
    for (const r of records) await upsertRecord(r);

    await Promise.all(records.map((r) => removeRecord(r.id)));

    expect(await readRegistry()).toEqual([]);
  });

  test('separate processes serialize registry upserts and removals', async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      rec({ id: `proc${String(i).padStart(4, '0')}`, tmuxName: `orc-x-proc-${i}` }),
    );

    await Promise.all(records.map((r) => runRegistryWorker(['upsert', JSON.stringify(r)])));
    expect((await readRegistry()).map((r) => r.id).sort()).toEqual(
      records.map((r) => r.id).sort(),
    );

    await Promise.all(records.map((r) => runRegistryWorker(['remove', r.id])));
    expect(await readRegistry()).toEqual([]);
  });

  test('separate processes coordinate stale lock cleanup', async () => {
    const lock = path.join(process.env.ORC_HOME!, '.registry.lock');
    await fs.writeFile(lock, JSON.stringify({ token: 'stale', createdAt: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 600_000);
    await fs.utimes(lock, old, old);

    const records = Array.from({ length: 8 }, (_, i) =>
      rec({ id: `stale${String(i).padStart(3, '0')}`, tmuxName: `orc-x-stale-${i}` }),
    );

    await Promise.all(records.map((r) => runRegistryWorker(['upsert', JSON.stringify(r)])));
    expect((await readRegistry()).map((r) => r.id).sort()).toEqual(
      records.map((r) => r.id).sort(),
    );
  });
});
