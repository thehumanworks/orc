import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.ts';
import {
  aliasHandle,
  assertAliasAvailable,
  findRecord,
  findRecordByAlias,
  parseAliasSelector,
  readRegistry,
  reserveRecord,
  upsertRecord,
  validateAlias,
  workspaceAlias,
  removeRecord,
} from '../src/registry.ts';
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

describe('workspace-scoped session aliases', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('validates alias values and parses CLI selectors', () => {
    expect(validateAlias('codex-debugger')).toBe('codex-debugger');
    expect(validateAlias('  claude_1  ')).toBe('claude_1');
    expect(() => validateAlias('@bad')).toThrow(/invalid alias/);
    expect(() => validateAlias('orc:debugger')).toThrow(/invalid alias/);

    expect(parseAliasSelector('@debugger')).toEqual({ alias: 'debugger' });
    expect(parseAliasSelector('@orc:debugger')).toEqual({
      workspace: 'orc',
      alias: 'debugger',
    });
    expect(parseAliasSelector('dead0001')).toBeNull();
  });

  test('resolves @alias inside the current workspace', async () => {
    const ws = '/tmp/projects/orc';
    const r = rec({
      id: 'alias001',
      alias: 'debugger',
      tmuxName: 'orc-x-alias-live',
      workspace: ws,
      cwd: ws,
    });
    await upsertRecord(r);

    const found = await findRecordByAlias(parseAliasSelector('@debugger')!, {
      defaultWorkspace: ws,
      driver: livenessDriver(['orc-x-alias-live']),
    });

    expect(found?.id).toBe('alias001');
    expect(workspaceAlias(ws)).toBe('orc');
    expect(aliasHandle(r)).toBe('@orc:debugger');
  });

  test('resolves @workspace:alias by workspace basename from outside the workspace', async () => {
    const ws = '/tmp/projects/orc';
    const r = rec({
      id: 'alias002',
      alias: 'codex-debugger',
      tmuxName: 'orc-x-alias-outside',
      workspace: ws,
      cwd: ws,
    });
    await upsertRecord(r);

    const found = await findRecordByAlias(parseAliasSelector('@orc:codex-debugger')!, {
      defaultWorkspace: '/tmp/elsewhere',
      driver: livenessDriver(['orc-x-alias-outside']),
    });

    expect(found?.id).toBe('alias002');
  });

  test('namespaced alias lookup prefers exact workspace keys over basename matches', async () => {
    const logical = rec({
      id: 'alias009',
      alias: 'debugger',
      tmuxName: 'orc-x-alias-logical',
      workspace: 'orc',
      cwd: '/tmp/logical',
    });
    const basename = rec({
      id: 'alias010',
      alias: 'debugger',
      tmuxName: 'orc-x-alias-basename',
      workspace: '/tmp/projects/orc',
      cwd: '/tmp/projects/orc',
    });
    await upsertRecord(logical);
    await upsertRecord(basename);

    const found = await findRecordByAlias(parseAliasSelector('@orc:debugger')!, {
      defaultWorkspace: '/tmp/elsewhere',
      driver: livenessDriver(['orc-x-alias-logical', 'orc-x-alias-basename']),
    });

    expect(found?.id).toBe('alias009');
  });

  test('alias lookup and conflicts only consider active records', async () => {
    const ws = '/tmp/projects/orc';
    const active = rec({
      id: 'alias003',
      alias: 'reviewer',
      tmuxName: 'orc-x-alias-active',
      workspace: ws,
      cwd: ws,
    });
    const killed = rec({
      id: 'alias004',
      alias: 'reviewer',
      tmuxName: 'orc-x-alias-dead',
      workspace: ws,
      cwd: ws,
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(active);
    await upsertRecord(killed);

    await expect(
      assertAliasAvailable('reviewer', {
        workspace: ws,
        driver: livenessDriver(['orc-x-alias-active']),
      }),
    ).rejects.toThrow(/already in use/);

    const found = await findRecordByAlias(parseAliasSelector('@reviewer')!, {
      defaultWorkspace: ws,
      driver: livenessDriver(['orc-x-alias-active']),
    });
    expect(found?.id).toBe('alias003');

    expect(
      await findRecordByAlias(parseAliasSelector('@reviewer')!, {
        defaultWorkspace: ws,
        driver: livenessDriver([]),
      }),
    ).toBeNull();
    await expect(
      assertAliasAvailable('reviewer', { workspace: ws, driver: livenessDriver([]) }),
    ).resolves.toBeUndefined();
  });

  test('reserveRecord blocks a duplicate fresh alias reservation before tmux is alive', async () => {
    const ws = '/tmp/projects/orc';
    const first = rec({
      id: 'alias005',
      alias: 'builder',
      aliasReservedAt: new Date().toISOString(),
      tmuxName: 'orc-x-alias-reserved-a',
      workspace: ws,
      cwd: ws,
    });
    const second = rec({
      id: 'alias006',
      alias: 'builder',
      tmuxName: 'orc-x-alias-reserved-b',
      workspace: ws,
      cwd: ws,
    });

    await reserveRecord(first, { driver: livenessDriver([]) });
    await expect(reserveRecord(second, { driver: livenessDriver([]) })).rejects.toThrow(
      /already in use/,
    );
  });

  test('a young non-reserved dead pane does not block alias reuse', async () => {
    const ws = '/tmp/projects/orc';
    await upsertRecord(
      rec({
        id: 'alias007',
        alias: 'builder',
        tmuxName: 'orc-x-alias-gone',
        workspace: ws,
        cwd: ws,
      }),
    );

    await expect(
      reserveRecord(
        rec({
          id: 'alias008',
          alias: 'builder',
          aliasReservedAt: new Date().toISOString(),
          tmuxName: 'orc-x-alias-new',
          workspace: ws,
          cwd: ws,
        }),
        { driver: livenessDriver([]) },
      ),
    ).resolves.toBeUndefined();
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
