/**
 * S5 cutover — the SDK (agent() / Session) on the actor runtime, end to end over the
 * scripted fake provider (ORC_TEST_FAKE_PROVIDER): real detached actors, real journal,
 * isolated ORC_HOME. Covers send idempotency, wake-on-send, kill (sticky) → resume,
 * takeover, purge, prune, the wake-time concurrency check (D2) and the system prompt file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_PROVIDER_ENV, agent } from '../src/agent.ts';
import { getSession, listSessions, pruneSessions } from '../src/index.ts';
import { readRegistry } from '../src/registry.ts';
import { readSpawnSpec } from '../src/runtime/spec.ts';
import { readActorState, leaseLive } from '../src/runtime/actor-state.ts';
import { sessionPaths } from '../src/runtime/layout.ts';
import { deliveryVerdict } from '../src/runtime/client.ts';
import type { Session } from '../src/session.ts';
import { renderCapture } from '../src/journal-render.ts';
import { actorPids, fakeProviderPids, killSessionProcesses, mkTmp, waitFor } from './runtime-helpers.ts';

const T = 45_000;
const prevHome = process.env.ORC_HOME;
const prevFake = process.env[FAKE_PROVIDER_ENV];
const root = mkTmp('orc-session-actor-');
const home = path.join(root, 'orc');
const cwd = path.join(root, 'work');
const sids: string[] = [];

const SCRIPT = {
  rules: [
    { match: 'HANG', action: 'hang' },
    { match: 'ASK', action: 'permission', detail: { tool: 'Bash' } },
    { match: 'SLOW', delayMs: 1_500 },
  ],
};

beforeAll(() => {
  process.env.ORC_HOME = home;
  process.env[FAKE_PROVIDER_ENV] = JSON.stringify(SCRIPT);
  fs.mkdirSync(cwd, { recursive: true });
});

afterAll(async () => {
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  fs.rmSync(root, { recursive: true, force: true });
});

async function spawn(opts: Partial<Parameters<typeof agent>[0]> = {}): Promise<Session> {
  const s = await agent({ provider: 'claude', cwd, workspace: cwd, ...opts });
  sids.push(s.sessionId);
  return s;
}

async function crashActor(s: Session): Promise<void> {
  const pid = readActorState(s.sessionId)!.lease!.pid;
  process.kill(pid, 'SIGKILL');
  await waitFor(() => !leaseLive(readActorState(s.sessionId)), 'lease to die');
}

describe('agent() + Session on the actor runtime', () => {
  test(
    'spawn → initial prompt acked → done; record carries runtime=actor; read journal',
    async () => {
      const s = await spawn({ prompt: 'line one\nline two\n' });
      const rec = s.toJSON();
      expect(rec.runtime).toBe('actor');
      expect('tmuxName' in rec).toBe(false);
      const spec = readSpawnSpec(s.sessionId)!;
      // The provider-side id (server-assigned for the fake, like codex) is on the record.
      expect(rec.providerSessionId).toBe(spec.providerSessionId!);
      expect(rec.providerSessionId).toMatch(/^fake-/);
      const readyEntry = s.journal().find((e) => e.type === 'provider.ready');
      expect(readyEntry?.type === 'provider.ready' && readyEntry.providerSessionId).toBe(rec.providerSessionId!);
      expect(spec.provider).toBe('fake');
      expect(spec.env.ORC_PARENT_SESSION_ID).toBe(s.id);
      expect(spec.env.ORC_DEPTH).toBe('1');

      expect((await s.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      const j = s.journal();
      const intent = j.find((e) => e.type === 'turn.intent');
      // Multi-line prompt arrives verbatim (one trailing newline dropped).
      expect(intent && intent.type === 'turn.intent' && intent.text).toBe('line one\nline two');
      expect(renderCapture(j)).toContain('echo: line one\nline two');
      expect(await s.status()).toBe('running');
      const d = await s.stateDetail();
      expect(d).toMatchObject({ state: 'done', status: 'running', live: true, stopped: false, suspended: false });
      expect(s.attachCommand()).toBe(`orc attach ${s.id}`);
    },
    T,
  );

  test(
    'send is idempotent per messageId; a reused key with different text throws',
    async () => {
      const s = await spawn();
      const a = await s.send('hello', { messageId: 'key-1' });
      expect(a).toEqual({ phase: 'acknowledged', messageId: 'key-1', replayed: false });
      const b = await s.send('hello\n', { messageId: 'key-1' });
      expect(b.replayed).toBe(true);
      expect(b.phase).toBe('acknowledged');
      await expect(s.send('different', { messageId: 'key-1' })).rejects.toThrow(/already used with a different prompt/);
      expect(s.journal().filter((e) => e.type === 'turn.intent')).toHaveLength(1);
      // Default key: a fresh ULID per call.
      const c = await s.send('again');
      expect(c.messageId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    },
    T,
  );

  test(
    'running while a turn is open; interrupt ends it; permission → waiting',
    async () => {
      const s = await spawn();
      await s.send('HANG please');
      expect(await s.state()).toBe('running');
      const r = await s.waitForResult({ until: ['done'], timeoutMs: 300 });
      expect(r).toEqual({ state: 'running', settled: false });
      expect(await s.interrupt()).toBe(true);
      expect((await s.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      expect(s.journal().some((e) => e.type === 'turn.interrupted')).toBe(true);

      await s.send('ASK for permission');
      expect((await s.waitForResult({ timeoutMs: 10_000 })).state).toBe('waiting');
      await s.interrupt();
    },
    T,
  );

  test(
    'actor crash → suspended (listed, resumable) → send wakes it; --no-wake only queues',
    async () => {
      const s = await spawn();
      await s.send('first', { messageId: 'w1' });
      await s.waitFor({ timeoutMs: 10_000 });
      await crashActor(s);
      expect(await s.status()).toBe('suspended');
      expect((await s.stateDetail()).suspended).toBe(true);
      expect((await listSessions({ workspace: cwd })).map((x) => x.id)).toContain(s.id);

      const q = await s.send('queued only', { messageId: 'w2', wake: false, ackTimeoutMs: 0 });
      expect(q.phase).toBe('queued');
      expect(await s.status()).toBe('suspended');

      const r = await s.send('wake up', { messageId: 'w3' });
      expect(r.phase).toBe('acknowledged');
      expect(await s.status()).toBe('running');
      expect((await s.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      const started = s.journal().filter((e) => e.type === 'actor.started');
      expect(started.at(-1)).toMatchObject({ mode: 'resume' });
      // The queued message was delivered (in order) by the woken actor.
      const intents = s.journal().filter((e) => e.type === 'turn.intent').map((e) => (e as { messageId: string }).messageId);
      expect(intents).toEqual(['w1', 'w2', 'w3']);
    },
    T,
  );

  test(
    'kill is sticky and keeps record + journal; resume hands it back',
    async () => {
      const s = await spawn();
      await s.send('before kill');
      await s.waitFor({ timeoutMs: 10_000 });
      await s.kill();
      expect(actorPids(s.sessionId)).toEqual([]);
      expect(fakeProviderPids(s.sessionId)).toEqual([]);
      const rec = (await readRegistry()).find((r) => r.id === s.id)!;
      expect(rec).toMatchObject({ status: 'dead', stoppedBy: 'kill' });
      expect(fs.existsSync(sessionPaths(s.sessionId).journal)).toBe(true);
      const dead = (await getSession(s.id))!;
      expect(await dead.status()).toBe('dead');
      expect((await dead.stateDetail()).stopped).toBe(true);
      await expect(dead.send('after kill')).rejects.toThrow(/stopped .*orc resume/);

      const d = await dead.resume();
      expect(d).toMatchObject({ status: 'running', state: 'done', stopped: false });
      const rec2 = (await readRegistry()).find((r) => r.id === s.id)!;
      expect(rec2.status).toBeUndefined();
      expect(rec2.stoppedBy).toBeUndefined();
      expect((await dead.send('after resume')).phase).toBe('acknowledged');
      expect((await dead.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      await dead.kill({ purge: true });
      expect(fs.existsSync(sessionPaths(s.sessionId).dir)).toBe(false);
      expect((await readRegistry()).some((r) => r.id === s.id)).toBe(false);
    },
    T,
  );

  test(
    'takeover stops the actor and its provider, marks the record, prints the native command',
    async () => {
      const s = await spawn();
      await s.send('work');
      await s.waitFor({ timeoutMs: 10_000 });
      const providerPid = readActorState(s.sessionId)!.provider!.pid;
      const t = await s.takeover();
      expect(t.id).toBe(s.id);
      expect(t.cwd).toBe(fs.realpathSync(cwd));
      expect(t.command).toContain('fake');
      expect(() => process.kill(providerPid, 0)).toThrow();
      expect(fakeProviderPids(s.sessionId)).toEqual([]);
      const rec = (await readRegistry()).find((r) => r.id === s.id)!;
      expect(rec).toMatchObject({ status: 'dead', stoppedBy: 'takeover' });
      expect(readActorState(s.sessionId)?.stopReason).toBe('takeover');
      // Handback.
      const back = await (await getSession(s.id))!.resume();
      expect(back.status).toBe('running');
      await s.kill();
    },
    T,
  );

  test(
    'prune removes dead sessions and their dirs, never suspended ones unless asked',
    async () => {
      const dead = await spawn();
      const susp = await spawn();
      await dead.kill();
      await crashActor(susp);
      const pruned = await pruneSessions();
      expect(pruned).toContain(dead.id);
      expect(pruned).not.toContain(susp.id);
      expect(fs.existsSync(sessionPaths(dead.sessionId).dir)).toBe(false);
      expect(fs.existsSync(sessionPaths(susp.sessionId).dir)).toBe(true);
      expect(await pruneSessions({ suspended: true })).toContain(susp.id);
      expect(fs.existsSync(sessionPaths(susp.sessionId).dir)).toBe(false);
      expect(actorPids(susp.sessionId)).toEqual([]);
    },
    T,
  );

  test(
    'waking a suspended session re-checks maxConcurrentSessions (D2)',
    async () => {
      const policy = { maxConcurrentSessions: 1 };
      const a = await spawn({ rootRunId: 'root-d2', policy });
      await crashActor(a);
      // a is suspended: it does not hold a slot, so b may spawn.
      const b = await spawn({ rootRunId: 'root-d2', policy });
      await expect(a.send('first attempt', { messageId: 'd2-first' })).rejects.toThrow(/maxConcurrentSessions=1/);
      expect(await a.status()).toBe('suspended');
      // The rejected wake leaves nothing queued for a later wake to deliver.
      expect((await a.stateDetail()).pendingMessages).toBe(0);
      expect(a.journal().filter((e) => e.type === 'inbox.dropped')).toMatchObject([
        { messageId: 'd2-first', reason: 'policy' },
      ]);
      expect(deliveryVerdict(a.sessionId, 'd2-first')).toBe('failed');
      await b.kill();
      expect((await a.send('second attempt', { messageId: 'd2-second' })).phase).toBe('acknowledged');
      expect((await a.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      const delivered = a
        .journal()
        .filter((e) => e.type === 'turn.intent')
        .map((e) => (e.type === 'turn.intent' ? e.text : ''));
      expect(delivered).toEqual(['second attempt']);
      await a.kill();
    },
    T,
  );

  test(
    'system prompt goes to an orc-owned 0600 file; codex replace mode is supported (D3)',
    async () => {
      const s = await spawn({ provider: 'codex', systemPrompt: 'be terse', systemPromptMode: 'replace' });
      const rec = s.toJSON();
      expect(rec.systemPromptPath).toBe(path.join(sessionPaths(s.sessionId).dir, 'system-prompt.md'));
      expect(fs.readFileSync(rec.systemPromptPath!, 'utf8')).toBe('be terse\n');
      expect(fs.statSync(rec.systemPromptPath!).mode & 0o777).toBe(0o600);
      expect(readSpawnSpec(s.sessionId)!.systemPrompt).toEqual({ mode: 'replace', path: rec.systemPromptPath! });
      expect(fs.readdirSync(cwd).includes('AGENTS.md')).toBe(false);
      // kill keeps it (resume needs it); purge removes it with the session dir.
      await s.kill();
      expect(fs.existsSync(rec.systemPromptPath!)).toBe(true);
      await (await getSession(s.id))!.kill({ purge: true });
      expect(fs.existsSync(rec.systemPromptPath!)).toBe(false);
    },
    T,
  );

  test(
    'attach follows the journal until the session stops',
    async () => {
      const s = await spawn();
      let out = '';
      const done = s.attach({ write: (t) => (out += t) });
      await s.send('SLOW hello');
      await waitFor(() => out.includes('echo: SLOW hello'), 'attach to render the reply');
      await s.kill();
      expect(await done).toBe(0);
      expect(out).toContain('> SLOW hello');
      expect(out).toMatch(/# session \w+ stopped/);
    },
    T,
  );

  test(
    'waitForReady:false returns once the actor started and still delivers the prompt',
    async () => {
      const s = await spawn({ waitForReady: false, prompt: 'deferred' });
      expect((await s.waitForResult({ timeoutMs: 10_000 })).state).toBe('done');
      expect(renderCapture(s.journal())).toContain('echo: deferred');
      await s.kill();
    },
    T,
  );
});
