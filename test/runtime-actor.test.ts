/**
 * Actor kernel — integration tests. Every scenario runs the REAL detached
 * `orc __actor <sid>` subprocess (src/cli/index.ts) driving the scripted fake provider
 * child, against an isolated ORC_HOME.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SessionStoppedError,
  createSession,
  deliveryVerdict,
  deriveState,
  ensureAwake,
  inspect,
  interrupt,
  readJournal,
  send,
  stop,
} from '../src/runtime/client.ts';
import { enqueue, listPending } from '../src/runtime/inbox.ts';
import {
  isLiveProcess,
  leaseLive,
  readActorState,
  withActorLock,
  writeActorState,
} from '../src/runtime/actor-state.ts';
import { readSpawnSpec } from '../src/runtime/spec.ts';
import { sessionPaths } from '../src/runtime/layout.ts';
import { isPidAlive } from '../src/runtime/process.ts';
import type { FakeScript } from '../src/runtime/providers/fake.ts';
import { LEASE_HEARTBEAT_MS } from '../src/runtime/types.ts';
import {
  actorPid,
  actorPids,
  entries,
  fakeProviderPids,
  fakeSpec,
  killSessionProcesses,
  mkTmp,
  runLauncher,
  waitCompleted,
  waitFor,
  waitForEntry,
} from './runtime-helpers.ts';

const T = 30_000;
const prevHome = process.env.ORC_HOME;
const root = mkTmp('orc-actor-it-');
const home = path.join(root, 'orc');
const sids: string[] = [];

beforeEach(() => {
  process.env.ORC_HOME = home;
});

afterAll(async () => {
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

async function newSession(script: FakeScript = {}): Promise<string> {
  const spec = fakeSpec(mkTmp('orc-actor-cwd-'), script);
  sids.push(spec.sessionId);
  await createSession(spec);
  return spec.sessionId;
}

/** SIGKILL only the actor (its provider lives in its own group) and wait until not live. */
async function crashActor(sid: string): Promise<void> {
  const pid = actorPid(sid);
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !leaseLive(readActorState(sid)), 'lease to die');
}

const rawSends = (sid: string, messageId: string) =>
  fs
    .readFileSync(sessionPaths(sid).providerRaw, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"dir":"send"') && l.includes(`\\"messageId\\":\\"${messageId}\\"`)).length;

describe('actor kernel (real __actor subprocess + fake provider)', () => {
  test(
    'create → two turns complete in order; send acks; intent < started < completed',
    async () => {
      const sid = await newSession();
      const r1 = await send(sid, { messageId: 'm1', text: 'one' });
      expect(r1).toMatchObject({ verdict: 'acknowledged', duplicate: false, woke: false });
      const r2 = await send(sid, { messageId: 'm2', text: 'two\nwith a second line' });
      expect(r2.verdict).toBe('acknowledged');
      await waitCompleted(sid, 'm2');

      const j = readJournal(sid);
      expect(j.map((e) => e.seq)).toEqual(j.map((_, i) => i + 1));
      const at = (type: string, m: string) =>
        j.findIndex((e) => e.type === type && (e as { messageId?: string }).messageId === m);
      for (const m of ['m1', 'm2']) {
        expect(at('turn.intent', m)).toBeGreaterThan(-1);
        expect(at('turn.intent', m)).toBeLessThan(at('turn.started', m));
        expect(at('turn.started', m)).toBeLessThan(at('turn.completed', m));
      }
      expect(at('turn.completed', 'm1')).toBeLessThan(at('turn.intent', 'm2'));
      expect(entries(sid, 'turn.completed', 'm2')[0]?.result).toBe('echo: two\nwith a second line');
      expect(entries(sid, 'actor.started')).toMatchObject([{ mode: 'fresh' }]);

      const ready = entries(sid, 'provider.ready')[0]!;
      expect(readSpawnSpec(sid)?.providerSessionId).toBe(ready.providerSessionId);
      expect(readActorState(sid)).toMatchObject({ phase: 'running' });
      expect(inspect(sid).summary).toMatchObject({ completedTurns: 2, startedTurns: 2 });
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'done', live: true, lastTurn: { messageId: 'm2' } });
      expect(deliveryVerdict(sid, 'm1')).toBe('completed');
      // The item is unlinked right after its outcome is journaled.
      await waitFor(() => listPending(sid).length === 0, 'inbox to drain');

      const p = sessionPaths(sid);
      const mode = (f: string) => (fs.statSync(f).mode & 0o777).toString(8);
      expect([p.dir, p.inbox].map(mode)).toEqual(['700', '700']);
      expect([p.spawn, p.state, p.journal, p.actorLog].map(mode)).toEqual(['600', '600', '600', '600']);
    },
    T,
  );

  test(
    'the actor survives its launcher',
    async () => {
      const spec = fakeSpec(mkTmp('orc-actor-cwd-'));
      sids.push(spec.sessionId);
      const specFile = path.join(root, `${spec.sessionId}.json`);
      fs.writeFileSync(specFile, JSON.stringify(spec));
      const launched = await runLauncher(['create', specFile]);
      expect(launched.code).toBe(0);
      const actor = (launched.out as { actor: { pid: number; startTime: string | null } }).actor;
      expect(isPidAlive(launched.pid)).toBe(false);
      expect(isLiveProcess(actor)).toBe(true);
      expect(actorPids(spec.sessionId)).toEqual([actor.pid]);

      const r = await send(spec.sessionId, { messageId: 'after-launcher', text: 'hi' });
      expect(r).toMatchObject({ verdict: 'acknowledged', woke: false });
      await waitCompleted(spec.sessionId, 'after-launcher');
      expect(readActorState(spec.sessionId)?.lease?.pid).toBe(actor.pid);
    },
    T,
  );

  test(
    'idempotent per messageId (sequential, concurrent, and a raw duplicate inbox item)',
    async () => {
      const sid = await newSession();
      const a = await send(sid, { messageId: 'dup', text: 'x' });
      const b = await send(sid, { messageId: 'dup', text: 'x' });
      expect(b).toMatchObject({ ulid: a.ulid, duplicate: true, verdict: 'acknowledged' });

      const [c, d] = await Promise.all([
        send(sid, { messageId: 'dup2', text: 'y' }),
        send(sid, { messageId: 'dup2', text: 'y' }),
      ]);
      expect(c.ulid).toBe(d.ulid);
      expect([c.duplicate, d.duplicate].filter(Boolean)).toHaveLength(1);

      // Behind the client's back: the actor itself must drop it.
      enqueue(sid, { kind: 'message', messageId: 'dup', text: 'again' });
      await send(sid, { messageId: 'after', text: 'z' });
      await waitCompleted(sid, 'after');
      await waitFor(() => listPending(sid).length === 0, 'inbox to drain');
      expect(entries(sid, 'turn.intent', 'dup')).toHaveLength(1);
      expect(entries(sid, 'turn.intent', 'dup2')).toHaveLength(1);
      expect(rawSends(sid, 'dup')).toBe(1);
    },
    T,
  );

  test(
    'interrupt a hanging turn; interrupt with no open turn is a no-op',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang' }] });
      expect((await send(sid, { messageId: 'h1', text: 'HANG please' })).verdict).toBe('acknowledged');
      expect(deriveState(inspect(sid)).state).toBe('running');

      expect((await interrupt(sid)).status).toBe('requested');
      const ti = await waitForEntry(sid, (e) => e.type === 'turn.interrupted' && e.messageId === 'h1', 'interrupted');
      expect(ti).toMatchObject({ reason: 'interrupt' });
      expect(entries(sid, 'interrupt.requested', 'h1')).toHaveLength(1);
      await waitForEntry(sid, (e) => e.type === 'interrupt.acked', 'interrupt.acked');
      expect(deliveryVerdict(sid, 'h1')).toBe('interrupted');
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'done', lastTurn: { outcome: 'interrupted' } });

      const acked = entries(sid, 'interrupt.acked').length;
      expect((await interrupt(sid)).status).toBe('requested');
      await waitFor(() => listPending(sid).length === 0, 'interrupt consumed');
      expect((await send(sid, { messageId: 'n1', text: 'normal' })).verdict).toBe('acknowledged');
      await waitCompleted(sid, 'n1');
      expect(entries(sid, 'interrupt.requested')).toHaveLength(1);
      expect(entries(sid, 'interrupt.acked')).toHaveLength(acked);
      expect(entries(sid, 'inbox.accepted').filter((e) => e.kind === 'interrupt')).toHaveLength(2);
    },
    T,
  );

  test(
    'crash after ack: verdict acknowledged, turn.interrupted{recovered} on wake, resume, one provider',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang' }] });
      await send(sid, { messageId: 'c1', text: 'first' });
      await waitCompleted(sid, 'c1');
      expect((await send(sid, { messageId: 'c2', text: 'HANG' })).verdict).toBe('acknowledged');
      const oldProvider = readActorState(sid)!.provider!;

      await crashActor(sid);
      expect(deriveState(inspect(sid))).toMatchObject({
        state: 'failed',
        suspended: true,
        stopped: false,
        openTurn: { messageId: 'c2' },
      });
      expect(deliveryVerdict(sid, 'c2')).toBe('acknowledged');
      // The default fake exits on stdin EOF once its actor is gone.
      await waitFor(() => !isLiveProcess(oldProvider), 'orphaned provider to exit');

      const r = await send(sid, { messageId: 'c3', text: 'next' });
      expect(r).toMatchObject({ verdict: 'acknowledged', woke: true });
      await waitCompleted(sid, 'c3');

      expect(entries(sid, 'turn.interrupted', 'c2')).toMatchObject([{ reason: 'recovered' }]);
      expect(deliveryVerdict(sid, 'c2')).toBe('acknowledged');
      expect(entries(sid, 'turn.intent', 'c2')).toHaveLength(1);
      expect(rawSends(sid, 'c2')).toBe(1);
      expect(entries(sid, 'actor.started').map((e) => e.mode)).toEqual(['fresh', 'resume']);
      const readies = entries(sid, 'provider.ready');
      expect(readies[1]?.providerSessionId).toBe(readies[0]!.providerSessionId);
      expect(readies[1]?.info).toMatchObject({ mode: 'resume' });
      expect(fakeProviderPids(sid)).toEqual([readActorState(sid)!.provider!.pid]);
      expect(actorPids(sid)).toHaveLength(1);
    },
    T,
  );

  test(
    'crash after intent but before ack: verdict unknown, never re-sent',
    async () => {
      const sid = await newSession({ rules: [{ match: 'SLOW', ackDelayMs: 20_000 }] });
      await send(sid, { messageId: 's1', text: 'first' });
      await waitCompleted(sid, 's1');
      const r = await send(sid, { messageId: 's2', text: 'SLOW' }, { ackTimeoutMs: 300 });
      expect(r).toMatchObject({ verdict: 'queued', delivery: 'queued' });
      await waitForEntry(sid, (e) => e.type === 'turn.intent' && e.messageId === 's2', 'intent s2');
      await waitFor(() => rawSends(sid, 's2') === 1, 'provider to receive s2');

      await crashActor(sid);
      expect(deliveryVerdict(sid, 's2')).toBe('unknown');

      const r3 = await send(sid, { messageId: 's3', text: 'next' });
      expect(r3).toMatchObject({ verdict: 'acknowledged', woke: true });
      await waitCompleted(sid, 's3');
      expect(entries(sid, 'turn.interrupted', 's2')).toMatchObject([{ reason: 'recovered' }]);
      expect(deliveryVerdict(sid, 's2')).toBe('unknown');

      // An explicit re-send of the same messageId is a duplicate, not a redelivery.
      const again = await send(sid, { messageId: 's2', text: 'SLOW' });
      expect(again).toMatchObject({ duplicate: true, verdict: 'unknown', delivery: 'unknown' });
      expect(entries(sid, 'turn.intent', 's2')).toHaveLength(1);
      expect(rawSends(sid, 's2')).toBe(1);
    },
    T,
  );

  test(
    'orphaned provider (ignores stdin EOF) is terminated before the new provider starts',
    async () => {
      const sid = await newSession({ ignoreStdinEofMs: 60_000 });
      await send(sid, { messageId: 'o1', text: 'first' });
      await waitCompleted(sid, 'o1');
      const oldProvider = readActorState(sid)!.provider!;

      await crashActor(sid);
      expect(isLiveProcess(oldProvider)).toBe(true);
      expect(fakeProviderPids(sid)).toEqual([oldProvider.pid]);

      const woke = await ensureAwake(sid);
      expect(woke.status).toBe('started');
      // ensureAwake killed it under the lock before spawning the actor.
      expect(isLiveProcess(oldProvider)).toBe(false);

      expect((await send(sid, { messageId: 'o2', text: 'again' })).verdict).toBe('acknowledged');
      await waitCompleted(sid, 'o2');
      const now = fakeProviderPids(sid);
      expect(now).toHaveLength(1);
      expect(now[0]).not.toBe(oldProvider.pid);
      expect(now[0]).toBe(readActorState(sid)!.provider!.pid);
      expect(actorPids(sid)).toHaveLength(1);
    },
    T,
  );

  test(
    'concurrent wakers (in-process and cross-process) on a suspended session yield one actor',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 'w1', text: 'first' });
      await waitCompleted(sid, 'w1');
      const oldProvider = readActorState(sid)!.provider!;
      await crashActor(sid);
      await waitFor(() => !isLiveProcess(oldProvider), 'old provider to exit');
      const startedBefore = entries(sid, 'actor.started').length;

      const children = [runLauncher(['wake', sid]), runLauncher(['wake', sid])];
      const [a, b, s2, s3] = await Promise.all([
        ensureAwake(sid),
        ensureAwake(sid),
        send(sid, { messageId: 'w2', text: 'two' }),
        send(sid, { messageId: 'w3', text: 'three' }),
      ]);
      const kids = await Promise.all(children);
      for (const k of kids) expect(k.code).toBe(0);
      await waitCompleted(sid, 'w2');
      await waitCompleted(sid, 'w3');

      const statuses = [a.status, b.status, ...kids.map((k) => (k.out as { status: string }).status)];
      const spawned = statuses.filter((s) => s === 'started').length + [s2, s3].filter((s) => s.woke).length;
      expect(spawned).toBe(1);
      expect(entries(sid, 'actor.started').length - startedBefore).toBe(1);
      expect(actorPids(sid)).toHaveLength(1);
      expect(fakeProviderPids(sid)).toHaveLength(1);
    },
    T,
  );

  test(
    'stop is sticky: provider and actor gone; send throws; ensureAwake never wakes',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 'p1', text: 'first' });
      await waitCompleted(sid, 'p1');
      const st = readActorState(sid)!;
      const actor = { pid: st.lease!.pid, startTime: st.lease!.startTime };
      const provider = st.provider!;

      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(readActorState(sid)).toMatchObject({ phase: 'stopped', stopReason: 'stop' });
      expect(readActorState(sid)?.lease).toBeUndefined();
      await waitFor(() => !isLiveProcess(actor), 'actor to exit');
      expect(isLiveProcess(provider)).toBe(false);
      expect(entries(sid, 'actor.stopped')).toMatchObject([{ reason: 'stop' }]);
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'failed', stopped: true, suspended: false });

      await expect(send(sid, { messageId: 'p2', text: 'x' })).rejects.toBeInstanceOf(SessionStoppedError);
      expect(await ensureAwake(sid)).toEqual({ status: 'stopped' });
      expect(await stop(sid)).toEqual({ status: 'already-stopped' });
      expect(await interrupt(sid)).toEqual({ status: 'not-live' });
      expect(listPending(sid)).toEqual([]);
      expect(entries(sid, 'actor.started')).toHaveLength(1);
      expect(actorPids(sid)).toEqual([]);
      expect(fakeProviderPids(sid)).toEqual([]);
    },
    T,
  );

  test(
    'stop with no live actor kills the orphaned provider and closes the open turn',
    async () => {
      const sid = await newSession({ ignoreStdinEofMs: 60_000, rules: [{ match: 'HANG', action: 'hang' }] });
      expect((await send(sid, { messageId: 'q1', text: 'HANG' })).verdict).toBe('acknowledged');
      const provider = readActorState(sid)!.provider!;
      await crashActor(sid);
      expect(isLiveProcess(provider)).toBe(true);

      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(isLiveProcess(provider)).toBe(false);
      expect(readActorState(sid)).toMatchObject({ phase: 'stopped' });
      expect(entries(sid, 'turn.interrupted', 'q1')).toMatchObject([{ reason: 'recovered' }]);
      expect(entries(sid, 'actor.stopped').at(-1)).toMatchObject({ reason: 'stop' });
      expect(deliveryVerdict(sid, 'q1')).toBe('acknowledged');
      expect(fakeProviderPids(sid)).toEqual([]);
    },
    T,
  );

  test(
    'provider exits / crashes mid-turn → suspended + turn.interrupted{provider-exit}; wakes again',
    async () => {
      const sid = await newSession({
        rules: [
          { match: 'DIE', action: 'exit', exitCode: 3, delayMs: 50 },
          { match: 'CRASH', action: 'crash', delayMs: 50 },
        ],
      });
      expect((await send(sid, { messageId: 'x1', text: 'DIE now' })).verdict).toBe('acknowledged');
      await waitForEntry(sid, (e) => e.type === 'actor.stopped' && e.reason === 'provider-exit', 'provider-exit stop');
      expect(entries(sid, 'turn.interrupted', 'x1')).toMatchObject([{ reason: 'provider-exit' }]);
      expect(entries(sid, 'provider.exited')).toMatchObject([{ code: 3, signal: null }]);
      await waitFor(() => readActorState(sid)?.phase === 'suspended', 'suspended');
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'failed', suspended: true, stopped: false });
      expect(deliveryVerdict(sid, 'x1')).toBe('interrupted');
      expect(fakeProviderPids(sid)).toEqual([]);

      const r = await send(sid, { messageId: 'x2', text: 'CRASH' });
      expect(r).toMatchObject({ verdict: 'acknowledged', woke: true });
      await waitForEntry(sid, (e) => e.type === 'provider.exited' && e.signal === 'SIGKILL', 'crash exit');
      await waitFor(() => readActorState(sid)?.phase === 'suspended', 'suspended again');
      expect(entries(sid, 'turn.interrupted', 'x2')).toMatchObject([{ reason: 'provider-exit' }]);

      expect((await send(sid, { messageId: 'x3', text: 'fine' })).woke).toBe(true);
      await waitCompleted(sid, 'x3');
    },
    T,
  );

  test(
    'a failed turn → failed while live (not suspended); verdict failed; next turn → done',
    async () => {
      const sid = await newSession({ rules: [{ match: 'BOOM', action: 'fail', error: 'kaboom' }] });
      expect((await send(sid, { messageId: 'f1', text: 'BOOM' })).verdict).toBe('acknowledged');
      await waitForEntry(sid, (e) => e.type === 'turn.failed' && e.messageId === 'f1', 'turn.failed');
      expect(deriveState(inspect(sid))).toMatchObject({
        state: 'failed',
        live: true,
        suspended: false,
        stopped: false,
        lastTurn: { messageId: 'f1', outcome: 'failed', error: 'kaboom' },
      });
      expect(deliveryVerdict(sid, 'f1')).toBe('failed');
      // Delivered (acked) then failed: the send verdict is about delivery, `delivery` carries the outcome.
      expect(await send(sid, { messageId: 'f1', text: 'BOOM' })).toMatchObject({
        verdict: 'acknowledged',
        delivery: 'failed',
        duplicate: true,
      });
      await send(sid, { messageId: 'f2', text: 'fine' });
      await waitCompleted(sid, 'f2');
      expect(deriveState(inspect(sid)).state).toBe('done');
    },
    T,
  );

  test(
    'permission.requested → waiting; interrupt ends the turn → done',
    async () => {
      const sid = await newSession({ rules: [{ match: 'PERM', action: 'permission' }] });
      await send(sid, { messageId: 'q1', text: 'PERM' });
      await waitForEntry(sid, (e) => e.type === 'permission.requested', 'permission.requested');
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'waiting', pendingPermission: { messageId: 'q1' } });
      await interrupt(sid);
      await waitForEntry(sid, (e) => e.type === 'turn.interrupted' && e.messageId === 'q1', 'interrupted');
      expect(deriveState(inspect(sid)).state).toBe('done');
    },
    T,
  );

  test(
    'SIGTERM to the actor → suspended (not sticky), provider gone, wakes on send',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 't1', text: 'one' });
      await waitCompleted(sid, 't1');
      const provider = readActorState(sid)!.provider!;
      process.kill(actorPid(sid), 'SIGTERM');
      await waitFor(() => readActorState(sid)?.phase === 'suspended', 'suspended');
      expect(isLiveProcess(provider)).toBe(false);
      expect(entries(sid, 'actor.stopped')).toMatchObject([{ reason: 'stop', error: 'SIGTERM' }]);
      expect(deriveState(inspect(sid))).toMatchObject({ suspended: true, stopped: false });

      expect((await send(sid, { messageId: 't2', text: 'two' })).woke).toBe(true);
      await waitCompleted(sid, 't2');
    },
    T,
  );

  test(
    'messages queued while suspended with wake:false are delivered in order on the next wake',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 'k0', text: 'zero' });
      await waitCompleted(sid, 'k0');
      const deadPid = actorPid(sid);
      await crashActor(sid);
      for (const m of ['k1', 'k2', 'k3']) {
        expect(await send(sid, { messageId: m, text: m }, { wake: false })).toMatchObject({
          verdict: 'queued',
          woke: false,
        });
      }
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'failed', suspended: true, pendingMessages: 3 });
      // As if the actor died inside a state write: its actor lock is left behind.
      const lockFile = path.join(home, 'locks', `actor-${sid}.lock`);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, token: 'dead', createdAt: new Date().toISOString() }));
      const t0 = Date.now();
      expect((await ensureAwake(sid)).status).toBe('started');
      expect(Date.now() - t0).toBeLessThan(5_000);
      await waitCompleted(sid, 'k3');
      expect(entries(sid, 'turn.intent').map((e) => e.messageId)).toEqual(['k0', 'k1', 'k2', 'k3']);
    },
    T,
  );

  test(
    'lease lost → the actor kills its provider and exits without touching state.json',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 'l1', text: 'one' });
      await waitCompleted(sid, 'l1');
      const provider = readActorState(sid)!.provider!;
      const actor = { pid: actorPid(sid), startTime: readActorState(sid)!.lease!.startTime };
      await withActorLock(sid, async () => {
        const st = readActorState(sid)!;
        st.lease!.token = 'stolen-by-another-actor';
        writeActorState(st);
      });
      // The next heartbeat (≤ LEASE_HEARTBEAT_MS) detects the foreign token.
      await waitForEntry(
        sid,
        (e) => e.type === 'actor.stopped' && e.reason === 'lease-lost',
        'lease-lost',
        LEASE_HEARTBEAT_MS + 5_000,
      );
      await waitFor(() => !isLiveProcess(actor), 'actor to exit');
      expect(isLiveProcess(provider)).toBe(false);
      expect(readActorState(sid)?.lease?.token).toBe('stolen-by-another-actor');
      expect(fakeProviderPids(sid)).toEqual([]);
    },
    T,
  );

  test(
    'errors: provider fails to start → actor stops with error (suspended); bad create inputs',
    async () => {
      const spec = { ...fakeSpec(mkTmp('orc-actor-cwd-')), provider: 'claude' as const };
      sids.push(spec.sessionId);
      // The actor inherits this env: point the claude runtime at a binary that cannot exist.
      const prevBin = process.env.ORC_CLAUDE_BIN;
      process.env.ORC_CLAUDE_BIN = path.join(root, 'no-such-claude-binary');
      try {
        await createSession(spec);
      } finally {
        if (prevBin === undefined) delete process.env.ORC_CLAUDE_BIN;
        else process.env.ORC_CLAUDE_BIN = prevBin;
      }
      const stopped = await waitForEntry(spec.sessionId, (e) => e.type === 'actor.stopped', 'actor.stopped');
      expect(stopped).toMatchObject({ reason: 'error' });
      expect(String((stopped as { error?: string }).error)).toMatch(/claude|no-such-claude-binary|ENOENT/i);
      await waitFor(() => readActorState(spec.sessionId)?.phase === 'suspended', 'suspended');

      await expect(createSession(spec)).rejects.toThrow(/already exists/);
      await expect(createSession(fakeSpec(path.join(root, 'missing-dir')))).rejects.toThrow(/does not exist/);
      await expect(send(randomUUID(), { messageId: 'm', text: 't' })).rejects.toThrow(/unknown session/);
    },
    T,
  );
});
