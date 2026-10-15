/**
 * Actor kernel — unit tests (no actor processes): ULIDs, atomic writes, journal
 * (seq continuity, torn tails, cursor/follow), inbox, liveness, deriveState / verdicts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INBOX_FILE_RE, RUNTIME_SCHEMA_VERSION } from '../src/runtime/types.ts';
import type { ActorStateFile, JournalEntry } from '../src/runtime/types.ts';
import { isUlid, ulid, ulidTime } from '../src/runtime/ulid.ts';
import {
  assertValidSessionId,
  ensurePrivateDir,
  readJsonFile,
  writeFileAtomic,
} from '../src/runtime/fsutil.ts';
import {
  JournalCursor,
  JournalWriter,
  followJournal,
  parseJournalText,
  readJournal,
  readJournalFile,
  repairTornTail,
} from '../src/runtime/journal.ts';
import { ensureSessionDirs, sessionPaths } from '../src/runtime/layout.ts';
import {
  enqueue,
  listPending,
  listPendingDetailed,
  removeInboxItem,
} from '../src/runtime/inbox.ts';
import {
  initialActorState,
  isLiveProcess,
  isZombie,
  leaseLive,
  reclaimDeadOwnerLock,
  withSessionLock,
} from '../src/runtime/actor-state.ts';
import { processStartTime } from '../src/runtime/process.ts';
import { TurnLedger, deriveState, summarizeLedger, verdictFor } from '../src/runtime/derive.ts';
import type { SessionView } from '../src/runtime/derive.ts';
import { getRuntimeFactory } from '../src/runtime/providers/index.ts';
import { mkTmp, waitFor } from './runtime-helpers.ts';

const prevHome = process.env.ORC_HOME;
const root = mkTmp('orc-kernel-unit-');
const home = path.join(root, 'orc');

beforeEach(() => {
  process.env.ORC_HOME = home;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

describe('ulid', () => {
  test('format matches the inbox file regex and decodes its time', () => {
    const now = Date.now();
    const id = ulid(now + 10_000);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(INBOX_FILE_RE.test(`${id}.json`)).toBe(true);
    expect(ulidTime(id)).toBe(now + 10_000);
  });

  test('strictly increasing within a millisecond and across a backwards clock step', () => {
    const t = Date.now() + 60_000;
    const ids = Array.from({ length: 5_000 }, () => ulid(t));
    ids.push(ulid(t - 50_000)); // clock stepped back
    ids.push(ulid(t + 1));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fsutil', () => {
  test('writeFileAtomic enforces the mode despite the umask and leaves no temp files', () => {
    const dir = mkTmp('orc-atomic-');
    const p = path.join(dir, 'x.json');
    const old = process.umask(0o000);
    try {
      writeFileAtomic(p, '{"a":1}', { mode: 0o600, fsync: true });
      expect(mode(p)).toBe('600');
      writeFileAtomic(p, '{"a":2}');
      expect(mode(p)).toBe('600');
    } finally {
      process.umask(old);
    }
    process.umask(0o077);
    try {
      writeFileAtomic(p, '{"a":3}', { mode: 0o640 });
      expect(mode(p)).toBe('640');
    } finally {
      process.umask(old);
    }
    expect(readJsonFile<{ a: number }>(p)).toEqual({ a: 3 });
    expect(fs.readdirSync(dir)).toEqual(['x.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readJsonFile: missing → undefined, corrupt → throws naming the file', () => {
    const dir = mkTmp('orc-json-');
    expect(readJsonFile(path.join(dir, 'nope.json'))).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(() => readJsonFile(path.join(dir, 'bad.json'))).toThrow(/bad\.json/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ensurePrivateDir chmods an existing dir to 0700; session dirs are 0700', () => {
    const dir = path.join(mkTmp('orc-dir-'), 'd');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe('700');
    const p = ensureSessionDirs(randomUUID());
    expect(mode(p.dir)).toBe('700');
    expect(mode(p.inbox)).toBe('700');
  });

  test('session ids are validated (no traversal)', () => {
    expect(assertValidSessionId(randomUUID())).toBeString();
    for (const bad of ['..', '../../etc', 'a/b', '', 'short', '-leading-dash', 'x'.repeat(65)]) {
      expect(() => assertValidSessionId(bad)).toThrow(/invalid sessionId/);
    }
  });
});

describe('journal', () => {
  test('seq is monotonic and continues across reopen; file is 0600', () => {
    const sid = randomUUID();
    ensureSessionDirs(sid);
    const j = JournalWriter.forSession(sid);
    j.append({ type: 'actor.started', pid: 1, mode: 'fresh' });
    j.append({ type: 'interrupt.acked' });
    j.close();
    const j2 = JournalWriter.forSession(sid);
    expect(j2.lastSeq).toBe(2);
    const e = j2.append({ type: 'turn.intent', messageId: 'm', ulid: ulid(), text: 't' });
    j2.close();
    expect(e.seq).toBe(3);
    expect(readJournal(sid).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(readJournal(sid, { fromSeq: 2 }).map((x) => x.seq)).toEqual([2, 3]);
    expect(readJournal(sid, { tail: 1 }).map((x) => x.seq)).toEqual([3]);
    expect(mode(sessionPaths(sid).journal)).toBe('600');
  });

  test('torn tail: readers drop the partial line; open() truncates it and continues seq', () => {
    const sid = randomUUID();
    ensureSessionDirs(sid);
    const file = sessionPaths(sid).journal;
    const j = JournalWriter.open(file);
    j.append({ type: 'actor.started', pid: 1, mode: 'fresh' });
    j.append({ type: 'interrupt.acked' });
    j.close();
    const good = fs.readFileSync(file);
    fs.appendFileSync(file, '{"seq":3,"ts":"2026-01-01T00:00:00Z","type":"turn.st');
    expect(readJournal(sid).map((e) => e.seq)).toEqual([1, 2]);
    expect(parseJournalText(fs.readFileSync(file, 'utf8'))).toHaveLength(2);

    const j2 = JournalWriter.open(file);
    expect(fs.readFileSync(file).equals(good)).toBe(true);
    expect(j2.append({ type: 'interrupt.acked' }).seq).toBe(3);
    j2.close();

    // A complete-but-corrupt trailing line (e.g. zero-filled block) is also repaired.
    fs.appendFileSync(file, '\u0000\u0000\u0000\n');
    expect(repairTornTail(file)).toBe(4);
    // Mid-file garbage is skipped by readers, not repaired.
    fs.appendFileSync(file, 'garbage\n');
    const j3 = JournalWriter.open(file);
    expect(j3.append({ type: 'interrupt.acked' }).seq).toBe(4);
    j3.close();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('garbage');
    expect(readJournalFile(file).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test('JournalCursor returns only complete new lines', () => {
    const sid = randomUUID();
    ensureSessionDirs(sid);
    const file = sessionPaths(sid).journal;
    const c = new JournalCursor(file);
    expect(c.readNew()).toEqual([]);
    const j = JournalWriter.open(file);
    j.append({ type: 'interrupt.acked' });
    expect(c.readNew().map((e) => e.seq)).toEqual([1]);
    fs.appendFileSync(file, '{"seq":2,"ts":"x","type":"interrupt.acked"');
    expect(c.readNew()).toEqual([]);
    fs.appendFileSync(file, '}\n');
    expect(c.readNew().map((e) => e.seq)).toEqual([2]);
    expect(c.readNew()).toEqual([]);
    j.close();
  });

  test('followJournal yields history then live appends until aborted', async () => {
    const sid = randomUUID();
    ensureSessionDirs(sid);
    const j = JournalWriter.forSession(sid);
    j.append({ type: 'interrupt.acked' });
    j.append({ type: 'interrupt.acked' });
    const ac = new AbortController();
    const seen: number[] = [];
    const done = (async () => {
      for await (const e of followJournal(sid, { fromSeq: 2, signal: ac.signal, pollMs: 20 })) {
        seen.push(e.seq);
        if (seen.length === 2) ac.abort();
      }
    })();
    await waitFor(() => seen.length === 1, 'history entry', 2_000);
    j.append({ type: 'interrupt.acked' });
    await done;
    j.close();
    expect(seen).toEqual([2, 3]);
  }, 5_000);
});

describe('inbox', () => {
  test('enqueue is ULID-ordered; temp/junk files are ignored; invalid items reported', () => {
    const sid = randomUUID();
    ensureSessionDirs(sid);
    const a = enqueue(sid, { kind: 'message', messageId: 'a', text: 'A' });
    const b = enqueue(sid, { kind: 'interrupt' });
    const c = enqueue(sid, { kind: 'stop', reason: 'r', graceMs: 10 });
    const dir = sessionPaths(sid).inbox;
    fs.writeFileSync(path.join(dir, `.tmp-${ulid()}`), '{"kind":"message"}');
    fs.writeFileSync(path.join(dir, 'README'), 'x');
    fs.writeFileSync(path.join(dir, `${ulid().toLowerCase()}.json`), '{}');
    const bad = ulid();
    fs.writeFileSync(path.join(dir, `${bad}.json`), '{not json');
    const listing = listPendingDetailed(sid);
    expect(listing.items.map((i) => i.ulid)).toEqual([a.ulid, b.ulid, c.ulid]);
    expect(listing.invalid).toEqual([bad]);
    expect(listPending(sid)[2]).toMatchObject({ kind: 'stop', reason: 'r', graceMs: 10 });
    expect(mode(path.join(dir, `${a.ulid}.json`))).toBe('600');
    removeInboxItem(sid, a.ulid);
    removeInboxItem(sid, a.ulid); // idempotent
    expect(listPending(sid).map((i) => i.ulid)).toEqual([b.ulid, c.ulid]);
    expect(listPending(randomUUID())).toEqual([]);
  });
});

describe('liveness', () => {
  const st = (over: Partial<ActorStateFile>): ActorStateFile => ({
    ...initialActorState('s-12345678'),
    ...over,
  });
  const me = { pid: process.pid, startTime: processStartTime(process.pid) };
  const future = () => new Date(Date.now() + 30_000).toISOString();

  test('leaseLive needs an active phase, an unexpired lease and the same live process', () => {
    expect(leaseLive(undefined)).toBe(false);
    expect(leaseLive(st({ phase: 'running' }))).toBe(false);
    const lease = { ...me, token: 't', expiresAt: future() };
    expect(leaseLive(st({ phase: 'running', lease }))).toBe(true);
    expect(leaseLive(st({ phase: 'starting', lease }))).toBe(true);
    expect(leaseLive(st({ phase: 'stopping', lease }))).toBe(true);
    expect(leaseLive(st({ phase: 'suspended', lease }))).toBe(false);
    expect(leaseLive(st({ phase: 'stopped', lease }))).toBe(false);
    expect(leaseLive(st({ phase: 'running', lease: { ...lease, expiresAt: new Date(Date.now() - 1).toISOString() } }))).toBe(false);
    expect(leaseLive(st({ phase: 'running', lease: { ...lease, startTime: 'proc:1' } }))).toBe(false);
    expect(leaseLive(st({ phase: 'running', lease: { ...lease, pid: 2 ** 22 + 7 } }))).toBe(false);
  });

  test('an unreaped zombie is not live', async () => {
    // `sleep 10` (exec'd shell) never reaps its finished `sleep 0.05` child → zombie.
    const proc = Bun.spawn(['sh', '-c', 'sleep 0.05 & echo $!; exec sleep 10'], { stdout: 'pipe' });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const zpid = Number(new TextDecoder().decode(value).trim());
    try {
      const id = { pid: zpid, startTime: processStartTime(zpid) };
      await waitFor(() => isZombie(zpid), 'zombie', 3_000);
      expect(isLiveProcess(id)).toBe(false);
      expect(isLiveProcess({ pid: proc.pid, startTime: processStartTime(proc.pid) })).toBe(true);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }, 5_000);
});

describe('session locks', () => {
  test('a lock left by a dead owner is reclaimed promptly; a live owner keeps it', async () => {
    const name = `actor-${randomUUID()}`;
    const lockPath = path.join(home, 'locks', `${name}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const dead = Bun.spawn(['true']);
    await dead.exited;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: 't1', createdAt: new Date().toISOString() }));
    const t0 = Date.now();
    expect(await withSessionLock(name, async () => 42)).toBe(42);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 't2', createdAt: new Date().toISOString() }));
    expect(reclaimDeadOwnerLock(name)).toBe(false);
    fs.writeFileSync(lockPath, ''); // owner not written yet: never reclaimed by us
    expect(reclaimDeadOwnerLock(name)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.rmSync(lockPath);
  }, 5_000);
});

describe('providers registry', () => {
  test('every runtime provider resolves to its own factory', async () => {
    for (const p of ['fake', 'claude', 'codex', 'pi'] as const) {
      expect((await getRuntimeFactory(p)).provider).toBe(p);
    }
    await expect(getRuntimeFactory('nope' as never)).rejects.toThrow(/unknown runtime provider/);
  });
});

// ---------------------------------------------------------------------------------
// deriveState / verdicts
// ---------------------------------------------------------------------------------

let seq = 0;
const E = (ev: Record<string, unknown>): JournalEntry =>
  ({ seq: ++seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), ...ev }) as JournalEntry;

function view(opts: {
  phase?: ActorStateFile['phase'] | 'missing';
  live?: boolean;
  journal?: JournalEntry[];
  pendingMessages?: number;
}): SessionView {
  const ledger = TurnLedger.from(opts.journal ?? []);
  const phase = opts.phase ?? 'running';
  return {
    sessionId: 's-12345678',
    exists: phase !== 'missing',
    ...(phase !== 'missing'
      ? {
          actor: { ...initialActorState('s-12345678'), phase, version: RUNTIME_SCHEMA_VERSION },
        }
      : {}),
    live: opts.live ?? true,
    pending: { messages: opts.pendingMessages ?? 0, interrupts: 0, stops: 0, messageIds: [] },
    summary: summarizeLedger(ledger),
    tail: [],
    observedAt: new Date().toISOString(),
  };
}

describe('deriveState', () => {
  const started = E({ type: 'actor.started', pid: 1, mode: 'fresh' });
  const intent = (m: string) => E({ type: 'turn.intent', messageId: m, ulid: ulid(), text: 'x' });
  const turnStarted = (m: string) => E({ type: 'turn.started', messageId: m });

  test.each([
    ['missing session', { phase: 'missing' as const }, { state: 'failed', stopped: false, suspended: false }],
    ['stopped (sticky)', { phase: 'stopped' as const, live: false }, { state: 'failed', stopped: true, suspended: false }],
    ['actor gone (crash)', { phase: 'running' as const, live: false }, { state: 'failed', stopped: false, suspended: true }],
    ['suspended', { phase: 'suspended' as const, live: false }, { state: 'failed', suspended: true }],
    ['provider initialising', { phase: 'starting' as const, journal: [started] }, { state: 'starting' }],
    ['idle', { journal: [started] }, { state: 'done', stopped: false, suspended: false }],
    ['queued inbox message', { journal: [started], pendingMessages: 1 }, { state: 'running' }],
  ])('%s', (_label, opts, want) => {
    expect(deriveState(view(opts))).toMatchObject(want);
  });

  test('spawn.json without state.json → failed + suspended (resumable)', () => {
    const v = view({ phase: 'missing' });
    const d = deriveState({ ...v, exists: true });
    expect(d).toMatchObject({ state: 'failed', phase: 'suspended', suspended: true, stopped: false });
  });

  test('open turn → running; outcome → done; last failed → failed (live, not suspended)', () => {
    const j = [started, intent('a'), turnStarted('a')];
    expect(deriveState(view({ journal: j }))).toMatchObject({ state: 'running', openTurn: { messageId: 'a' } });
    j.push(E({ type: 'turn.completed', messageId: 'a', result: 'ok' }));
    expect(deriveState(view({ journal: j }))).toMatchObject({
      state: 'done',
      lastTurn: { messageId: 'a', outcome: 'completed', result: 'ok' },
    });
    j.push(intent('b'), turnStarted('b'), E({ type: 'turn.failed', messageId: 'b', error: 'boom' }));
    expect(deriveState(view({ journal: j }))).toMatchObject({
      state: 'failed',
      stopped: false,
      suspended: false,
      lastTurn: { outcome: 'failed', error: 'boom' },
    });
  });

  test('permission.requested → waiting until the turn ends', () => {
    const j = [started, intent('p'), turnStarted('p'), E({ type: 'permission.requested', messageId: 'p', detail: {} })];
    expect(deriveState(view({ journal: j }))).toMatchObject({ state: 'waiting', pendingPermission: { messageId: 'p' } });
    j.push(E({ type: 'turn.interrupted', messageId: 'p', reason: 'interrupt' }));
    const d = deriveState(view({ journal: j }));
    expect(d.state).toBe('done');
    expect(d.pendingPermission).toBeUndefined();
    // not live wins over waiting
    expect(deriveState(view({ journal: j.slice(0, 4), live: false })).state).toBe('failed');
  });

  test('verdictFor covers every delivery outcome (brief decision 1)', () => {
    const rec = (over: object) => ({ messageId: 'm', ulid: 'u', intentSeq: 1, intentAt: 't', ...over });
    expect(verdictFor(undefined, false, true)).toBe('absent');
    expect(verdictFor(undefined, true, false)).toBe('queued');
    expect(verdictFor(rec({}), false, true)).toBe('queued');
    expect(verdictFor(rec({}), false, false)).toBe('unknown');
    expect(verdictFor(rec({ startedSeq: 2 }), false, false)).toBe('acknowledged');
    expect(verdictFor(rec({ startedSeq: 2, outcome: 'completed' }), false, true)).toBe('completed');
    expect(verdictFor(rec({ startedSeq: 2, outcome: 'failed' }), false, true)).toBe('failed');
    expect(verdictFor(rec({ startedSeq: 2, outcome: 'interrupted', reason: 'interrupt' }), false, true)).toBe('interrupted');
    expect(verdictFor(rec({ startedSeq: 2, outcome: 'interrupted', reason: 'recovered' }), false, true)).toBe('acknowledged');
    expect(verdictFor(rec({ outcome: 'interrupted', reason: 'recovered' }), false, true)).toBe('unknown');
    expect(verdictFor(rec({ outcome: 'interrupted', reason: 'provider-exit' }), false, true)).toBe('unknown');
  });
});
