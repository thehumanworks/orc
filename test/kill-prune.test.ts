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
import type { LivenessProbe } from '../src/session-status.ts';
import { registryPath } from '../src/paths.ts';
import nodeFs from 'node:fs';
import type { SessionRecord } from '../src/types.ts';

/**
 * BUG 3 — kill() must MARK a record dead (keep it for transcript/metadata reads) rather
 * than hard-deleting it; --purge removes it; prune drops all dead records; list hides
 * dead by default. These run against an isolated ORC_HOME with records that have no
 * kernel session (D15: kill skips the kernel) and an injected liveness probe.
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
    cwd: ws,
    workspace: ws,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * Test liveness: ids in `running` are running, `suspended` are suspended, ids in `throws`
 * make the probe throw (liveness unknowable), everything else is dead.
 */
function live(running: string[], throws: string[] = [], suspended: string[] = []): LivenessProbe {
  return (r) => {
    if (throws.includes(r.id)) throw new Error(`liveness failed for ${r.id}`);
    if (running.includes(r.id)) return 'running';
    if (suspended.includes(r.id)) return 'suspended';
    return 'dead';
  };
}

const OLD = new Date(Date.now() - 3_600_000).toISOString();

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
    const alive = rec({ id: 'alive001', workspace: ws, cwd: ws });
    const killed = rec({
      id: 'dead0002',
      workspace: ws,
      cwd: ws,
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(killed);

    const def = await listSessions({ workspace: ws, liveness: live(['alive001']) });
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
      workspace: ws,
      cwd: ws,
    });
    await upsertRecord(r);

    const found = await findRecordByAlias(parseAliasSelector('@debugger')!, {
      defaultWorkspace: ws,
      liveness: live(['alias001']),
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
      workspace: ws,
      cwd: ws,
    });
    await upsertRecord(r);

    const found = await findRecordByAlias(parseAliasSelector('@orc:codex-debugger')!, {
      defaultWorkspace: '/tmp/elsewhere',
      liveness: live(['alias002']),
    });

    expect(found?.id).toBe('alias002');
  });

  test('namespaced alias lookup prefers exact workspace keys over basename matches', async () => {
    const logical = rec({
      id: 'alias009',
      alias: 'debugger',
      workspace: 'orc',
      cwd: '/tmp/logical',
    });
    const basename = rec({
      id: 'alias010',
      alias: 'debugger',
      workspace: '/tmp/projects/orc',
      cwd: '/tmp/projects/orc',
    });
    await upsertRecord(logical);
    await upsertRecord(basename);

    const found = await findRecordByAlias(parseAliasSelector('@orc:debugger')!, {
      defaultWorkspace: '/tmp/elsewhere',
      liveness: live(['alias009', 'alias010']),
    });

    expect(found?.id).toBe('alias009');
  });

  test('alias lookup and conflicts only consider active records', async () => {
    const ws = '/tmp/projects/orc';
    const active = rec({
      id: 'alias003',
      alias: 'reviewer',
      workspace: ws,
      cwd: ws,
    });
    const killed = rec({
      id: 'alias004',
      alias: 'reviewer',
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
        liveness: live(['alias003']),
      }),
    ).rejects.toThrow(/already in use/);

    const found = await findRecordByAlias(parseAliasSelector('@reviewer')!, {
      defaultWorkspace: ws,
      liveness: live(['alias003']),
    });
    expect(found?.id).toBe('alias003');

    expect(
      await findRecordByAlias(parseAliasSelector('@reviewer')!, {
        defaultWorkspace: ws,
        liveness: live([]),
      }),
    ).toBeNull();
    await expect(
      assertAliasAvailable('reviewer', { workspace: ws, liveness: live([]) }),
    ).resolves.toBeUndefined();
  });

  test('reserveRecord blocks a duplicate fresh alias reservation before the actor is live', async () => {
    const ws = '/tmp/projects/orc';
    const first = rec({
      id: 'alias005',
      alias: 'builder',
      aliasReservedAt: new Date().toISOString(),
      workspace: ws,
      cwd: ws,
    });
    const second = rec({
      id: 'alias006',
      alias: 'builder',
      workspace: ws,
      cwd: ws,
    });

    await reserveRecord(first, { liveness: live([]) });
    await expect(reserveRecord(second, { liveness: live([]) })).rejects.toThrow(
      /already in use/,
    );
  });

  test('a young non-reserved dead pane does not block alias reuse', async () => {
    const ws = '/tmp/projects/orc';
    await upsertRecord(
      rec({
        id: 'alias007',
        alias: 'builder',
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
          workspace: ws,
          cwd: ws,
        }),
        { liveness: live([]) },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('prune drops dead records (BUG 3)', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('pruneSessions removes only dead records', async () => {
    const alive = rec({ id: 'alive003' });
    const killed = rec({
      id: 'dead0003',
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(killed);

    const removed = await pruneSessions({ liveness: live(['alive003']) });
    expect(removed).toEqual(['dead0003']);

    const left = await readRegistry();
    expect(left.map((r) => r.id)).toEqual(['alive003']);
  });

  test('pruneSessions removes liveness-dead records without persisted dead status', async () => {
    const alive = rec({ id: 'alive005' });
    // Old enough not to be a spawn in progress.
    const stale = rec({ id: 'stale005', createdAt: OLD });
    const killed = rec({
      id: 'dead0005',
      status: 'dead',
      killedAt: new Date().toISOString(),
    });
    await upsertRecord(alive);
    await upsertRecord(stale);
    await upsertRecord(killed);

    const removed = await pruneSessions({ liveness: live(['alive005']) });
    expect(removed.sort()).toEqual(['dead0005', 'stale005']);

    const left = await readRegistry();
    expect(left.map((r) => r.id)).toEqual(['alive005']);
  });

  test('pruneSessions returns [] when nothing dead', async () => {
    await upsertRecord(rec({ id: 'alive004' }));
    expect(await pruneSessions({ liveness: live(['alive004']) })).toEqual([]);
  });

  test('pruneSessions keeps records when liveness cannot be determined', async () => {
    const uncertain = rec({ id: 'maybe006' });
    await upsertRecord(uncertain);

    expect(await pruneSessions({ liveness: live([], ['maybe006']) })).toEqual([]);
    expect((await readRegistry()).map((r) => r.id)).toEqual(['maybe006']);
  });

  test('pruneSessions does not remove a replacement record from a stale liveness result', async () => {
    const original = rec({ id: 'race007', createdAt: OLD });
    const replacement = rec({ id: 'race007', sessionId: 'race007-1111-1111-1111-111111111111' });
    await upsertRecord(original);

    // The record is replaced (same short id, new session) after liveness was judged and
    // before the registry update: the replacement must survive.
    const probe: LivenessProbe = () => {
      nodeFs.writeFileSync(registryPath(), JSON.stringify([replacement]));
      return 'dead';
    };

    expect(await pruneSessions({ liveness: probe })).toEqual([]);
    expect(await readRegistry()).toEqual([replacement]);
  });

  test('suspended sessions are kept unless suspended: true', async () => {
    await upsertRecord(rec({ id: 'susp0008', createdAt: OLD }));
    await upsertRecord(rec({ id: 'dead0008', createdAt: OLD }));
    const probe = live([], [], ['susp0008']);
    expect(await pruneSessions({ liveness: probe })).toEqual(['dead0008']);
    expect((await readRegistry()).map((r) => r.id)).toEqual(['susp0008']);
    expect(await pruneSessions({ liveness: probe, suspended: true })).toEqual(['susp0008']);
    expect(await readRegistry()).toEqual([]);
  });

  test('a young record without runtime state (spawn in progress) is never pruned', async () => {
    await upsertRecord(rec({ id: 'young009' }));
    expect(await pruneSessions({ liveness: live([]) })).toEqual([]);
    expect((await readRegistry()).map((r) => r.id)).toEqual(['young009']);
  });

  test('legacy tmux records normalise to dead and are pruned', async () => {
    const legacy = {
      id: 'legacy10',
      sessionId: 'legacy10-0000-0000-0000-000000000000',
      provider: 'codex',
      tmuxName: 'orc-codex-legacy10',
      instructionsPath: '/tmp/x/instructions.md',
      transcriptSessionId: 'cdx-thread',
      cwd: '/tmp/ws-kill-test',
      workspace: '/tmp/ws-kill-test',
      createdAt: new Date().toISOString(),
    };
    nodeFs.writeFileSync(registryPath(), JSON.stringify([legacy]));
    const [r] = await readRegistry();
    expect(r!.legacy).toBe('tmux');
    expect(r!.status).toBe('dead');
    expect(r!.legacyTmuxName).toBe('orc-codex-legacy10');
    expect(r!.systemPromptPath).toBe('/tmp/x/instructions.md');
    expect(r!.providerSessionId).toBe('cdx-thread');
    expect('tmuxName' in r!).toBe(false);
    // Hidden from the default list, pruned by default (kernel liveness).
    expect((await listSessions({ workspace: '/tmp/ws-kill-test' })).map((s) => s.id)).toEqual([]);
    expect(await pruneSessions()).toEqual(['legacy10']);
  });
});

describe('registry mutations are serialized', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('concurrent upsertRecord calls preserve all records', async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec({ id: `up${String(i).padStart(6, '0')}` }),
    );

    await Promise.all(records.map((r) => upsertRecord(r)));

    const ids = (await readRegistry()).map((r) => r.id).sort();
    expect(ids).toEqual(records.map((r) => r.id).sort());
  });

  test('concurrent removeRecord calls do not resurrect records', async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec({ id: `rm${String(i).padStart(6, '0')}` }),
    );
    for (const r of records) await upsertRecord(r);

    await Promise.all(records.map((r) => removeRecord(r.id)));

    expect(await readRegistry()).toEqual([]);
  });

  test('separate processes serialize registry upserts and removals', async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      rec({ id: `proc${String(i).padStart(4, '0')}` }),
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
      rec({ id: `stale${String(i).padStart(3, '0')}` }),
    );

    await Promise.all(records.map((r) => runRegistryWorker(['upsert', JSON.stringify(r)])));
    expect((await readRegistry()).map((r) => r.id).sort()).toEqual(
      records.map((r) => r.id).sort(),
    );
  });
});
