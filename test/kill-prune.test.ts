import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.ts';
import { readRegistry, upsertRecord, findRecord } from '../src/registry.ts';
import { listSessions, pruneSessions } from '../src/index.ts';
import type { SessionRecord } from '../src/types.ts';

/**
 * BUG 3 — kill() must MARK a record dead (keep it for transcript/metadata reads) rather
 * than hard-deleting it; --purge removes it; prune drops all dead records; list hides
 * dead by default. These run against an isolated ORC_HOME and a tmux session that does
 * not exist (kill-session on a missing name returns gracefully).
 */

const tmpHomes: string[] = [];

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

    const removed = await pruneSessions();
    expect(removed).toEqual(['dead0003']);

    const left = await readRegistry();
    expect(left.map((r) => r.id)).toEqual(['alive003']);
  });

  test('pruneSessions returns [] when nothing dead', async () => {
    await upsertRecord(rec({ id: 'alive004', tmuxName: 'orc-x-a4' }));
    expect(await pruneSessions()).toEqual([]);
  });
});
