/**
 * Actor kernel — integration tests. Every scenario runs the REAL detached
 * `orc __actor <sid>` subprocess (src/cli/index.ts) driving the scripted fake provider
 * child, against an isolated ORC_HOME.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SessionStartError,
  SessionStoppedError,
  createSession,
  reopen,
  deliveryVerdict,
  deriveState,
  ensureAwake,
  inspect,
  interrupt,
  readJournal,
  send,
  stop,
} from '../src/runtime/client.ts';
import { enqueue, listPending, removeInboxItem } from '../src/runtime/inbox.ts';
import {
  isLiveProcess,
  leaseLive,
  readActorState,
  withActorLock,
  writeActorState,
} from '../src/runtime/actor-state.ts';
import { readSpawnSpec, writeSpawnSpec } from '../src/runtime/spec.ts';
import { sessionPaths } from '../src/runtime/layout.ts';
import { isPidAlive, selfArgv, spawnDetached } from '../src/runtime/process.ts';
import type { FakeScript } from '../src/runtime/providers/fake.ts';
import { LEASE_HEARTBEAT_MS } from '../src/runtime/types.ts';
import type { ProcessIdentity } from '../src/runtime/types.ts';
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
}, TEARDOWN_TIMEOUT_MS);

async function newSession(script: FakeScript = {}, opts: { startTimeoutMs?: number } = {}): Promise<string> {
  const spec = fakeSpec(mkTmp('orc-actor-cwd-'), script);
  sids.push(spec.sessionId);
  await createSession(spec, opts);
  return spec.sessionId;
}

/**
 * The R1 crash window: the actor is SIGKILLed after spawning its provider but before the
 * pid reached state.json (a provider handshake takes seconds). Reproduced exactly: wait
 * for provider.spawned while the (simulated) handshake runs, kill the actor, and make sure
 * state.json does not name the provider. Returns the orphan.
 */
async function orphanDuringHandshake(sid: string, nth = 1): Promise<ProcessIdentity> {
  await waitFor(() => entries(sid, 'provider.spawned').length >= nth, `provider.spawned #${nth}`);
  const spawned = entries(sid, 'provider.spawned')[nth - 1]!;
  const orphan = { pid: spawned.pid, startTime: spawned.startTime };
  process.kill(actorPid(sid), 'SIGKILL');
  await waitFor(() => !leaseLive(readActorState(sid)), 'lease to die');
  await withActorLock(sid, async () => {
    const st = readActorState(sid)!;
    delete st.provider;
    writeActorState(st);
  });
  expect(entries(sid, 'provider.ready')).toHaveLength(nth - 1);
  expect(isLiveProcess(orphan)).toBe(true);
  expect(fakeProviderPids(sid)).toEqual([orphan.pid]);
  return orphan;
}

const STOPPING_SCRIPT: FakeScript = {
  ignoreStdinEofMs: 60_000,
  rules: [{ match: 'HANG', action: 'hang', ignoreInterrupt: true }],
};

/**
 * An actor SIGKILLed mid-stop: it accepted a stop item and persisted `stopping` + reason
 * (the provider ignores the interrupt, so the actor sits in its bounded interrupt wait),
 * then dies before writing `stopped`. `consumeStopItem` reproduces the worst case where
 * the stop item is already gone too. Leaves the provider orphaned (it ignores EOF).
 */
async function crashWhileStopping(sid: string, reason: string, consumeStopItem: boolean): Promise<ProcessIdentity> {
  expect((await send(sid, { messageId: 'h1', text: 'HANG' })).verdict).toBe('acknowledged');
  const provider = readActorState(sid)!.provider!;
  const pid = actorPid(sid);
  const item = enqueue(sid, { kind: 'stop', reason, graceMs: 4_000 });
  await waitFor(() => readActorState(sid)?.phase === 'stopping', 'stopping');
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !leaseLive(readActorState(sid)), 'lease to die');
  expect(readActorState(sid)).toMatchObject({ phase: 'stopping', stopReason: reason });
  if (consumeStopItem) removeInboxItem(sid, item.ulid);
  expect(isLiveProcess(provider)).toBe(true);
  return provider;
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
    'spawn.json carries the provider session id before provider.ready is journaled',
    async () => {
      for (let i = 0; i < 3; i++) {
        const spec = fakeSpec(mkTmp('orc-actor-cwd-'));
        sids.push(spec.sessionId);
        const created = createSession(spec, { startTimeoutMs: 10_000 });
        const file = sessionPaths(spec.sessionId).journal;
        // Tight poll (yield only): read spawn.json the instant provider.ready is visible.
        let psid: string | undefined;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setImmediate(r));
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('"type":"provider.ready"')) {
            psid = readSpawnSpec(spec.sessionId)?.providerSessionId;
            break;
          }
        }
        await created;
        const ready = entries(spec.sessionId, 'provider.ready')[0]!;
        expect(psid).toBe(ready.providerSessionId);
      }
    },
    T,
  );

  test(
    "a waker never hands its ORC_* lineage (or ORC_HOST) to the session it wakes (spec.env is the authority)",
    async () => {
      const reported = [
        'ORC_RESULT_PATH',
        'ORC_ATTEMPT_ID',
        'ORC_RUN_ID',
        'ORC_STEP_ID',
        'ORC_DEPTH',
        'ORC_PARENT_SESSION_ID',
        'ORC_POLICY_MAX_DEPTH',
        'ORC_HOST',
        'ORC_HOME',
        'ORC_TEST_INHERITED',
      ];
      const spec = fakeSpec(mkTmp('orc-actor-cwd-'), { reportEnv: reported });
      spec.env = { ...spec.env, ORC_DEPTH: '1', ORC_PARENT_SESSION_ID: 'helper-parent' };
      sids.push(spec.sessionId);
      await createSession(spec);
      await crashActor(spec.sessionId);

      // A workflow step agent `orc send`s the suspended helper: its env carries the STEP's lineage.
      const waker: Record<string, string> = {
        ORC_RESULT_PATH: '/tmp/step/result.json',
        ORC_ATTEMPT_ID: 'att-step',
        ORC_RUN_ID: 'run-step',
        ORC_STEP_ID: 'step-a',
        ORC_DEPTH: '7',
        ORC_POLICY_MAX_DEPTH: '9',
        // The user's default remote target never reaches the provider (S10 safety rule 3).
        ORC_HOST: 'studio',
        ORC_TEST_INHERITED: 'kept',
      };
      const saved = Object.fromEntries(Object.keys(waker).map((k) => [k, process.env[k]]));
      Object.assign(process.env, waker);
      try {
        expect((await send(spec.sessionId, { messageId: 'w1', text: 'hi' })).woke).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      const info = entries(spec.sessionId, 'provider.ready').at(-1)!.info as { env: Record<string, string> };
      expect(info.env).toEqual({
        ORC_DEPTH: '1',
        ORC_PARENT_SESSION_ID: 'helper-parent',
        ORC_HOME: home,
        ORC_TEST_INHERITED: 'kept',
      });
      if (fs.existsSync('/proc/self/environ')) {
        const environ = fs.readFileSync(`/proc/${actorPid(spec.sessionId)}/environ`, 'utf8').split('\0');
        expect(environ.filter((l) => /^ORC_(RESULT_PATH|ATTEMPT_ID|RUN_ID|STEP_ID|DEPTH|POLICY_|HOST=)/.test(l))).toEqual([]);
        expect(environ).toContain(`ORC_HOME=${home}`);
      }
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
    'stop mid-turn interrupts the provider first, then closes it',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang' }] });
      expect((await send(sid, { messageId: 'h1', text: 'HANG' })).verdict).toBe('acknowledged');
      expect(await stop(sid, { graceMs: 3_000 })).toEqual({ status: 'stopped' });
      const j = readJournal(sid);
      const at = (pred: (e: (typeof j)[number]) => boolean) => j.findIndex(pred);
      const req = at((e) => e.type === 'interrupt.requested' && e.messageId === 'h1');
      const outcome = at((e) => e.type === 'turn.interrupted' && e.messageId === 'h1');
      const exited = at((e) => e.type === 'provider.exited');
      expect(req).toBeGreaterThan(-1);
      expect(req).toBeLessThan(outcome);
      // Reported by the provider itself while still running (before it was closed).
      expect(outcome).toBeLessThan(exited);
      expect(j[outcome]).toMatchObject({ reason: 'interrupt' });
      expect(exited).toBeLessThan(at((e) => e.type === 'actor.stopped'));
      const raw = fs.readFileSync(sessionPaths(sid).providerRaw, 'utf8');
      expect(raw).toContain('{\\"op\\":\\"interrupt\\"}');
      expect(deliveryVerdict(sid, 'h1')).toBe('interrupted');
    },
    T,
  );

  test(
    'stop mid-turn: a provider that ignores the interrupt is closed after a bounded wait',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang', ignoreInterrupt: true }] });
      expect((await send(sid, { messageId: 'h1', text: 'HANG' })).verdict).toBe('acknowledged');
      const t0 = Date.now();
      expect(await stop(sid, { graceMs: 600 })).toEqual({ status: 'stopped' });
      expect(Date.now() - t0).toBeLessThan(4_000);
      const types = readJournal(sid).map((e) => e.type);
      expect(types.indexOf('interrupt.requested')).toBeLessThan(types.indexOf('interrupt.acked'));
      // No provider outcome: the kernel closes the turn after the provider is gone.
      expect(types.indexOf('provider.exited')).toBeLessThan(types.indexOf('turn.interrupted'));
      expect(entries(sid, 'turn.interrupted', 'h1')).toMatchObject([{ reason: 'interrupt' }]);
      expect(fakeProviderPids(sid)).toEqual([]);
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
    'provider spawned but not yet recorded in state: ensureAwake and actor boot kill it first',
    async () => {
      const script: FakeScript = { ignoreStdinEofMs: 60_000, startDelayMs: 1_000 };
      const sid = await newSession(script, { startTimeoutMs: 300 });
      const orphan = await orphanDuringHandshake(sid);

      // ensureAwake kills it under the lock before spawning the new actor.
      expect((await ensureAwake(sid, { startTimeoutMs: 300 })).status).toBe('started');
      expect(isLiveProcess(orphan)).toBe(false);
      await waitFor(() => readActorState(sid)?.phase === 'running', 'running', 10_000);
      expect(fakeProviderPids(sid)).toEqual([readActorState(sid)!.provider!.pid]);
      expect(entries(sid, 'provider.spawned')).toHaveLength(2);

      // Actor boot path: orphan the second provider (known only from the journal), then
      // start an actor directly (no ensureAwake pre-kill).
      const orphan2 = await orphanDuringHandshake(sid, 2);
      const spec = readSpawnSpec(sid)!;
      spawnDetached([...selfArgv(), '__actor', sid], { cwd: spec.cwd, env: process.env, logPath: sessionPaths(sid).actorLog });
      await waitFor(() => entries(sid, 'provider.spawned').length === 3, 'boot provider.spawned');
      expect(isLiveProcess(orphan2)).toBe(false);
      await waitFor(() => readActorState(sid)?.phase === 'running', 'running again', 10_000);
      expect(fakeProviderPids(sid)).toEqual([readActorState(sid)!.provider!.pid]);
      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(fakeProviderPids(sid)).toEqual([]);
    },
    T,
  );

  test(
    'stop() with no live actor kills a provider that never reached state.json',
    async () => {
      const sid = await newSession({ ignoreStdinEofMs: 60_000, startDelayMs: 1_000 }, { startTimeoutMs: 300 });
      const orphan = await orphanDuringHandshake(sid);
      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(isLiveProcess(orphan)).toBe(false);
      expect(fakeProviderPids(sid)).toEqual([]);
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
    'stop while a send waits behind a turn: send throws SessionStoppedError, message dropped as a fact',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang' }] });
      expect((await send(sid, { messageId: 'h1', text: 'HANG' })).verdict).toBe('acknowledged');
      const outcome = send(sid, { messageId: 'm2', text: 'later' }, { ackTimeoutMs: 15_000 }).then(
        (r) => r,
        (e: unknown) => e,
      );
      await waitFor(() => listPending(sid).some((i) => i.kind === 'message' && i.messageId === 'm2'), 'm2 queued');
      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(await outcome).toBeInstanceOf(SessionStoppedError);
      expect(listPending(sid)).toEqual([]);
      expect(entries(sid, 'inbox.dropped')).toMatchObject([{ messageId: 'm2', reason: 'stopped' }]);
      expect(deliveryVerdict(sid, 'm2')).toBe('failed');
      expect(deliveryVerdict(sid, 'h1')).toBe('interrupted');
      expect(deriveState(inspect(sid))).toMatchObject({ stopped: true, pendingMessages: 0 });
    },
    T,
  );

  test(
    'stop with no live actor drops queued messages as facts (verdict failed)',
    async () => {
      const sid = await newSession();
      await send(sid, { messageId: 'd0', text: 'zero' });
      await waitCompleted(sid, 'd0');
      await crashActor(sid);
      expect((await send(sid, { messageId: 'd1', text: 'queued' }, { wake: false })).verdict).toBe('queued');
      expect(await stop(sid)).toEqual({ status: 'stopped' });
      expect(listPending(sid)).toEqual([]);
      expect(entries(sid, 'inbox.dropped')).toMatchObject([{ messageId: 'd1' }]);
      expect(deliveryVerdict(sid, 'd1')).toBe('failed');
      await expect(send(sid, { messageId: 'd1', text: 'queued' })).rejects.toBeInstanceOf(SessionStoppedError);
    },
    T,
  );

  test(
    'stop ‖ send race: a send is either acknowledged or throws SessionStoppedError; nothing stays queued',
    async () => {
      for (const delay of [0, 1, 3, 6, 12, 25]) {
        const sid = await newSession();
        const messageId = `race-${delay}`;
        const [stopped, sent] = await Promise.allSettled([
          stop(sid),
          Bun.sleep(delay).then(() => send(sid, { messageId, text: 'x' }, { ackTimeoutMs: 5_000 })),
        ]);
        expect(stopped).toMatchObject({ status: 'fulfilled', value: { status: 'stopped' } });
        if (sent.status === 'fulfilled') {
          expect(sent.value.verdict).toBe('acknowledged');
          expect(['acknowledged', 'completed', 'interrupted']).toContain(deliveryVerdict(sid, messageId));
        } else {
          expect(sent.reason).toBeInstanceOf(SessionStoppedError);
          expect(['absent', 'failed']).toContain(deliveryVerdict(sid, messageId));
        }
        expect(readActorState(sid)?.phase).toBe('stopped');
        expect(listPending(sid).filter((i) => i.kind === 'message')).toEqual([]);
        expect(fakeProviderPids(sid)).toEqual([]);
      }
    },
    T,
  );

  test(
    'actor boot sweeps stale inbox temp files but keeps fresh ones',
    async () => {
      const sid = await newSession();
      await crashActor(sid);
      const dir = sessionPaths(sid).inbox;
      const stale = path.join(dir, '.tmp-01STALESTALESTALESTALESTALE');
      const fresh = path.join(dir, '.tmp-01FRESHFRESHFRESHFRESHFRESH');
      fs.writeFileSync(stale, '{}');
      fs.writeFileSync(fresh, '{}');
      const old = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(stale, old, old);
      expect((await ensureAwake(sid)).status).toBe('started');
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    },
    T,
  );

  test(
    'actor dies mid-stop (stop item already gone): ensureAwake finishes the stop, never wakes; reason kept',
    async () => {
      const sid = await newSession(STOPPING_SCRIPT);
      const provider = await crashWhileStopping(sid, 'takeover', true);
      expect(deriveState(inspect(sid))).toMatchObject({ state: 'failed', stopped: true, suspended: false });
      await expect(send(sid, { messageId: 'x1', text: 'x' })).rejects.toBeInstanceOf(SessionStoppedError);
      expect(await ensureAwake(sid)).toEqual({ status: 'stopped' });
      expect(readActorState(sid)).toMatchObject({ phase: 'stopped', stopReason: 'takeover' });
      expect(readActorState(sid)?.lease).toBeUndefined();
      expect(isLiveProcess(provider)).toBe(false);
      expect(entries(sid, 'actor.started')).toHaveLength(1);
      expect(entries(sid, 'turn.interrupted', 'h1')).toMatchObject([{ reason: 'recovered' }]);
      expect(entries(sid, 'actor.stopped').at(-1)).toMatchObject({ reason: 'stop', error: 'takeover' });
      expect(await stop(sid)).toEqual({ status: 'already-stopped' });
      expect(listPending(sid)).toEqual([]);
      expect(fakeProviderPids(sid)).toEqual([]);
      expect(actorPids(sid)).toEqual([]);
    },
    T,
  );

  test(
    'actor dies mid-stop (stop item still queued): a directly started actor finishes the stop instead of starting',
    async () => {
      const sid = await newSession(STOPPING_SCRIPT);
      const provider = await crashWhileStopping(sid, 'kill', false);
      const spec = readSpawnSpec(sid)!;
      spawnDetached([...selfArgv(), '__actor', sid], { cwd: spec.cwd, env: process.env, logPath: sessionPaths(sid).actorLog });
      await waitFor(() => readActorState(sid)?.phase === 'stopped', 'stopped by the booting actor');
      expect(readActorState(sid)).toMatchObject({ stopReason: 'kill' });
      expect(isLiveProcess(provider)).toBe(false);
      expect(entries(sid, 'actor.started')).toHaveLength(1);
      expect(entries(sid, 'provider.spawned')).toHaveLength(1);
      await waitFor(() => actorPids(sid).length === 0, 'booting actor to exit');
      expect(listPending(sid)).toEqual([]);
    },
    T,
  );

  test(
    'actor dies mid-stop: stop() completes it keeping the original reason; resume (reopen) then works',
    async () => {
      const sid = await newSession(STOPPING_SCRIPT);
      const provider = await crashWhileStopping(sid, 'takeover', true);
      expect(await stop(sid, { reason: 'kill' })).toEqual({ status: 'stopped' });
      expect(readActorState(sid)).toMatchObject({ phase: 'stopped', stopReason: 'takeover' });
      expect(isLiveProcess(provider)).toBe(false);
      // Explicit resume path (session.resume): reopen, then a forced wake.
      expect(await reopen(sid, { reason: 'resume' })).toEqual({ status: 'reopened' });
      expect((await ensureAwake(sid, { force: true })).status).toBe('started');
      await send(sid, { messageId: 'after', text: 'back' });
      await waitCompleted(sid, 'after');
      expect(fakeProviderPids(sid)).toEqual([readActorState(sid)!.provider!.pid]);
    },
    T,
  );

  test(
    'resume (reopen) of a session whose actor died mid-stop finishes the stop first',
    async () => {
      const sid = await newSession(STOPPING_SCRIPT);
      const provider = await crashWhileStopping(sid, 'takeover', true);
      expect(await reopen(sid, { reason: 'resume' })).toEqual({ status: 'reopened' });
      expect(isLiveProcess(provider)).toBe(false);
      const types = readJournal(sid).map((e) => e.type);
      expect(types.lastIndexOf('actor.stopped')).toBeLessThan(types.lastIndexOf('actor.reopened'));
      expect(readActorState(sid)?.phase).toBe('suspended');
      expect((await ensureAwake(sid, { force: true })).status).toBe('started');
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
    'host sleep: an alive actor with an expired lease is given a heartbeat to renew, not killed',
    async () => {
      const sid = await newSession({ rules: [{ match: 'HANG', action: 'hang' }] });
      expect((await send(sid, { messageId: 'h1', text: 'HANG' })).verdict).toBe('acknowledged');
      const before = readActorState(sid)!;
      // As after a laptop sleep: the lease looks expired. Also rewind the phase, as if a
      // state write had been lost — the next heartbeat must re-apply the intended phase.
      await withActorLock(sid, async () => {
        const st = readActorState(sid)!;
        st.lease!.expiresAt = new Date(Date.now() - 1_000).toISOString();
        st.phase = 'starting';
        writeActorState(st);
      });
      expect(leaseLive(readActorState(sid))).toBe(false);
      const r = await send(sid, { messageId: 'n2', text: 'next' }, { ackTimeoutMs: 300 });
      expect(r).toMatchObject({ woke: false, verdict: 'queued' });
      const after = readActorState(sid)!;
      expect(after.lease?.pid).toBe(before.lease!.pid);
      expect(after.provider?.pid).toBe(before.provider!.pid);
      expect(after.phase).toBe('running');
      expect(leaseLive(after)).toBe(true);
      expect(deliveryVerdict(sid, 'h1')).toBe('acknowledged');
      expect(entries(sid, 'actor.started')).toHaveLength(1);
    },
    T,
  );

  test(
    'failed resumes: sessionError surfaced, never a fresh fallback, auto-wake refused after 3 until forced',
    async () => {
      const sid = await newSession({ exitOnResume: 7 });
      await send(sid, { messageId: 'r0', text: 'first' });
      await waitCompleted(sid, 'r0');
      await crashActor(sid);

      // Wake 1 (via send): the provider rejects the resume → surfaced, message stays queued.
      const r1 = await send(sid, { messageId: 'r1', text: 'one' }, { ackTimeoutMs: 2_000 });
      expect(r1).toMatchObject({ verdict: 'queued', woke: true });
      expect(r1.sessionError).toMatch(/provider exited before ready \(code=7/);
      expect(r1.sessionError).toContain('no conversation found'); // actor.log tail
      expect(readActorState(sid)).toMatchObject({ phase: 'suspended', startFailures: 1 });
      // Wakes 2 and 3 (explicit ensureAwake): same.
      for (const n of [2, 3]) {
        const w = await ensureAwake(sid);
        expect(w).toMatchObject({ status: 'started' });
        expect((w as { sessionError?: string }).sessionError).toMatch(/code=7/);
        expect(readActorState(sid)?.startFailures).toBe(n);
      }
      expect(deriveState(inspect(sid))).toMatchObject({ suspended: true, startFailures: 3 });
      // Refused now: no new actor, the message is still queued and the reason is surfaced.
      await expect(ensureAwake(sid)).rejects.toBeInstanceOf(SessionStartError);
      const r2 = await send(sid, { messageId: 'r2', text: 'two' });
      expect(r2).toMatchObject({ verdict: 'queued', woke: false });
      expect(r2.sessionError).toMatch(/3 times in a row/);
      expect(listPending(sid).map((i) => (i as { messageId?: string }).messageId)).toEqual(['r1', 'r2']);
      // Never fell back to a fresh session.
      expect(entries(sid, 'actor.started').map((e) => e.mode)).toEqual(['fresh', 'resume', 'resume', 'resume']);

      // Explicit resume after fixing the provider: forced wake → ready → counter reset → delivered in order.
      const spec = readSpawnSpec(sid)!;
      writeSpawnSpec({ ...spec, fakeScript: {} });
      const forced = await ensureAwake(sid, { force: true });
      expect(forced).toMatchObject({ status: 'started' });
      expect((forced as { sessionError?: string }).sessionError).toBeUndefined();
      await waitCompleted(sid, 'r2');
      expect(readActorState(sid)?.startFailures).toBeUndefined();
      expect(entries(sid, 'turn.intent').map((e) => e.messageId)).toEqual(['r0', 'r1', 'r2']);
      expect(entries(sid, 'actor.started').at(-1)?.mode).toBe('resume');
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
      const journalBefore = readJournal(sid).length;
      // The next heartbeat (≤ LEASE_HEARTBEAT_MS) detects the foreign token.
      await waitFor(() => !isLiveProcess(actor), 'actor to exit', LEASE_HEARTBEAT_MS + 5_000);
      expect(isLiveProcess(provider)).toBe(false);
      expect(fs.readFileSync(sessionPaths(sid).actorLog, 'utf8')).toContain('lease lost');
      // The journal now belongs to whoever holds the lease: the loser writes nothing to it.
      expect(readJournal(sid).length).toBe(journalBefore);
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
        // Fails fast with the provider's start error (not a silent success).
        await expect(createSession(spec)).rejects.toBeInstanceOf(SessionStartError);
      } finally {
        if (prevBin === undefined) delete process.env.ORC_CLAUDE_BIN;
        else process.env.ORC_CLAUDE_BIN = prevBin;
      }
      const stopped = await waitForEntry(spec.sessionId, (e) => e.type === 'actor.stopped', 'actor.stopped');
      expect(stopped).toMatchObject({ reason: 'error' });
      expect(String((stopped as { error?: string }).error)).toMatch(/claude|no-such-claude-binary|ENOENT/i);
      await waitFor(() => readActorState(spec.sessionId)?.phase === 'suspended', 'suspended');
      expect(readActorState(spec.sessionId)?.startFailures).toBe(1);

      await expect(createSession(spec)).rejects.toThrow(/already exists/);
      await expect(createSession(fakeSpec(path.join(root, 'missing-dir')))).rejects.toThrow(/does not exist/);
      await expect(send(randomUUID(), { messageId: 'm', text: 't' })).rejects.toThrow(/unknown session/);
    },
    T,
  );
});
