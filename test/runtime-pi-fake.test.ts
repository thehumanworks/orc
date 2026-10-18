/**
 * Offline lifecycle tests for the pi runtime against a scripted fake pi
 * (test/fixtures/pi-fake.ts): the failure paths a real pi rarely produces on demand —
 * hang on close (SIGKILL path), boot timeout, external kill mid-turn, interrupt racing a
 * natural finish, unacked send + close, concurrent close, a dropped abort, and a child left
 * in pi's process group. No pi install, network or model needed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiRuntime } from '../src/runtime/providers/pi.ts';
import type { ProviderEvent, ProviderLaunch, ProviderRuntime, ProviderRuntimeFactory } from '../src/runtime/types.ts';

const FAKE = path.join(import.meta.dir, 'fixtures', 'pi-fake.ts');
let root = '';
let wrapper = '';
const live: ProviderRuntime[] = [];

function factory(opts: { bootTimeoutMs?: number; reabortAfterMs?: number } = {}): ProviderRuntimeFactory {
  return createPiRuntime({ bin: wrapper, bootTimeoutMs: opts.bootTimeoutMs ?? 10_000, ...opts });
}

function launch(mode: string, extraEnv: Record<string, string> = {}): ProviderLaunch & { dir: string } {
  const dir = fs.mkdtempSync(path.join(root, `${mode}-`));
  return {
    dir,
    spec: {
      version: 1,
      sessionId: `fake-${crypto.randomUUID()}`,
      provider: 'pi',
      cwd: dir,
      env: {},
      createdAt: new Date().toISOString(),
    },
    resume: false,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, FAKE_MODE: mode, ...extraEnv },
    rawLogPath: path.join(dir, 'provider.jsonl'),
  };
}

async function start(f: ProviderRuntimeFactory, l: ProviderLaunch): Promise<ProviderRuntime> {
  const rt = await f.start(l);
  live.push(rt);
  return rt;
}

/** Drain events in the background. */
function collect(rt: ProviderRuntime): { events: ProviderEvent[]; done: Promise<void> } {
  const events: ProviderEvent[] = [];
  const done = (async () => {
    for await (const e of rt.events()) events.push(e);
  })();
  return { events, done };
}

const types = (evs: ProviderEvent[]) =>
  evs.map((e) => ('messageId' in e && e.messageId ? `${e.type}:${e.messageId}` : e.type));

function rawLog(l: ProviderLaunch): Array<{ dir: string; line: string }> {
  if (!fs.existsSync(l.rawLogPath)) return [];
  return fs
    .readFileSync(l.rawLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x) as { dir: string; line: string });
}

async function waitUntil(pred: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** '' when gone; otherwise the ps state (Z = killed, awaiting reap by init). */
function procState(pid: number): string {
  const r = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout.toString().trim();
}

/** Non-zombie processes whose process group is `pgid`. */
function liveGroupMembers(pgid: number): string[] {
  const r = Bun.spawnSync(['ps', '-eo', 'pid=,pgid=,stat='], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout
    .toString()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[1] === String(pgid) && !(f[2] ?? '').startsWith('Z'))
    .map((f) => f.join(' '));
}

function processesMentioning(needle: string): string[] {
  const r = Bun.spawnSync(['ps', '-eo', 'pid=,args='], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout
    .toString()
    .split('\n')
    .filter((l) => l.includes(needle));
}

/** Open fds of this process that point at `file` (Linux only; null elsewhere). */
function openFdsTo(file: string): number | null {
  if (!fs.existsSync('/proc/self/fd')) return null;
  return fs.readdirSync('/proc/self/fd').filter((f) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${f}`) === file;
    } catch {
      return false;
    }
  }).length;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-pi-fake-')));
  wrapper = path.join(root, 'fake-pi');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((rt) => rt.close({ graceMs: 200 }).catch(() => {})));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pi runtime lifecycle (fake pi)', () => {
  test('a qualified selector cannot silently select another Pi provider or model', async () => {
    for (const model of ['openai/fake-model', 'fake/another-model']) {
      const l = launch('slow');
      l.spec.model = model;
      await expect(factory().start(l)).rejects.toThrow(/requested model .* but Pi selected/);
      expect(rawLog(l).filter((r) => r.dir === 'send').every((r) => !r.line.includes('"type":"prompt"'))).toBe(true);
      expect(processesMentioning(l.spec.sessionId)).toEqual([]);
    }
  }, 15_000);

  test('exact OpenAI selector and a supported thinking suffix retain the Pi path', async () => {
    for (const model of ['openai/gpt-5.5', 'openai/gpt-5.5:high']) {
      const l = launch('slow', { FAKE_MODEL_PROVIDER: 'openai', FAKE_MODEL_ID: 'gpt-5.5' });
      l.spec.model = model;
      const rt = await start(factory(), l);
      const { events, done } = collect(rt);
      await rt.close({ graceMs: 500 });
      await done;
      expect(events[0]).toMatchObject({ type: 'ready', info: { model: 'openai/gpt-5.5' } });
      expect(rawLog(l).some((r) => r.dir === 'info' && r.line.includes('"--provider","openai","--model"'))).toBe(true);
      expect(rawLog(l).filter((r) => r.dir === 'send').map((r) => JSON.parse(r.line).type))
        .toEqual(['get_state', 'get_available_models']);
    }
  }, 15_000);

  test('a qualified model absent from Pi available models fails before a prompt', async () => {
    const l = launch('slow', { FAKE_MODEL_PROVIDER: 'openai', FAKE_MODEL_ID: 'gpt-5.5', FAKE_MODEL_UNAVAILABLE: '1' });
    l.spec.model = 'openai/gpt-5.5';
    await expect(factory().start(l)).rejects.toThrow(/not available in Pi's authenticated model list/);
    expect(rawLog(l).filter((r) => r.dir === 'send').every((r) => !r.line.includes('"type":"prompt"'))).toBe(true);
    expect(processesMentioning(l.spec.sessionId)).toEqual([]);
  }, 10_000);

  test('a literal colon model id is checked before interpreting a thinking suffix', async () => {
    const l = launch('slow', { FAKE_MODEL_PROVIDER: 'openrouter', FAKE_MODEL_ID: 'vendor/model:exacto' });
    l.spec.model = 'openrouter/vendor/model:exacto';
    const rt = await start(factory(), l);
    await rt.close({ graceMs: 500 });
  }, 10_000);

  test('a different session id is refused before any prompt is delivered', async () => {
    const l = launch('slow', { FAKE_SESSION_ID: 'different-session' });
    await expect(factory().start(l)).rejects.toThrow(/requested session .* but Pi opened 'different-session'/);
    expect(rawLog(l).filter((r) => r.dir === 'send').every((r) => !r.line.includes('"type":"prompt"'))).toBe(true);
    expect(processesMentioning(l.spec.sessionId)).toEqual([]);
  }, 10_000);

  test(
    'close: provider ignores stdin EOF and SIGTERM → group SIGKILLed; exited is last',
    async () => {
      const rt = await start(factory(), launch('hang'));
      const { events, done } = collect(rt);
      const t0 = Date.now();
      await rt.close({ graceMs: 300 });
      await done;
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(types(events)).toEqual(['ready', 'exited']);
      expect(events.at(-1)).toEqual({ type: 'exited', code: null, signal: 'SIGKILL' });
      expect(groupAlive(rt.pid)).toBe(false);
    },
    15_000,
  );

  test(
    'boot timeout (get_state never answered) → start() rejects and leaves no process',
    async () => {
      const l = launch('mute');
      const t0 = Date.now();
      await expect(factory({ bootTimeoutMs: 400 }).start(l)).rejects.toThrow(/no get_state response within 400 ms/);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(processesMentioning(l.spec.sessionId)).toEqual([]);
      expect(rawLog(l).at(-1)?.line).toMatch(/^exit /);
    },
    15_000,
  );

  test(
    'external kill mid-turn → turn.interrupted then exited; send() released; fds closed; later calls safe',
    async () => {
      const l = launch('slow');
      const rt = await start(factory(), l);
      const { events, done } = collect(rt);
      await rt.send('m1', 'go');
      await waitUntil(() => rawLog(l).some((r) => r.line.includes('text_delta')), 5_000, 'streaming');
      process.kill(rt.pid, 'SIGTERM');
      await done;
      expect(types(events)).toEqual(['ready', 'turn.started:m1', 'turn.interrupted:m1', 'exited']);
      expect(events.at(-1)).toEqual({ type: 'exited', code: null, signal: 'SIGTERM' });
      const fds = openFdsTo(l.rawLogPath);
      if (fds !== null) expect(fds).toBe(0);
      await expect(rt.send('m2', 'late')).rejects.toThrow(/closed/);
      await rt.interrupt(); // no-op after exit
      await rt.close(); // resolves at once
    },
    15_000,
  );

  test(
    'interrupt racing a natural finish → exactly one outcome (completed) + interrupt.acked',
    async () => {
      const rt = await start(factory(), launch('race'));
      const { events, done } = collect(rt);
      await rt.send('m1', 'go');
      await rt.interrupt();
      await rt.close({ graceMs: 1_000 });
      await done;
      expect(types(events)).toEqual(['ready', 'turn.started:m1', 'assistant.text:m1', 'turn.completed:m1', 'interrupt.acked', 'exited']);
      expect(events[3]).toMatchObject({ type: 'turn.completed', result: 'done' });
    },
    15_000,
  );

  test(
    'unacked send + close → send() resolves, second send rejects, turn.interrupted, exited last',
    async () => {
      const rt = await start(factory(), launch('noack'));
      const { events, done } = collect(rt);
      const sent = rt.send('m1', 'go');
      await expect(rt.send('m2', 'again')).rejects.toThrow(/still open/);
      await rt.interrupt(); // deferred: the prompt was never acked
      const t0 = Date.now();
      await rt.close({ graceMs: 400 });
      await sent;
      await done;
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(types(events)).toEqual(['ready', 'turn.interrupted:m1', 'exited']);
      expect(events.at(-1)).toEqual({ type: 'exited', code: 0, signal: null });
    },
    15_000,
  );

  test(
    'concurrent close() calls share one shutdown that aborts first; events readable afterwards; single consumer',
    async () => {
      const l = launch('slow');
      const rt = await start(factory(), l);
      await rt.send('m1', 'go');
      await Promise.all([rt.close({ graceMs: 1_000 }), rt.close({ graceMs: 1_000 }), rt.close()]);
      const { events, done } = collect(rt);
      await done;
      expect(types(events)).toEqual([
        'ready',
        'turn.started:m1',
        'assistant.text:m1',
        'turn.interrupted:m1',
        'interrupt.acked',
        'exited',
      ]);
      expect(() => rt.events()).toThrow(/single-consumer/);
      const raw = rawLog(l);
      expect(raw.filter((r) => r.dir === 'send' && r.line.includes('"type":"abort"'))).toHaveLength(1);
      expect(raw.filter((r) => r.dir === 'info' && r.line === 'stdin closed')).toHaveLength(1);
      const abortAt = raw.findIndex((r) => r.dir === 'send' && r.line.includes('"type":"abort"'));
      const settledAt = raw.findIndex((r) => r.dir === 'recv' && r.line.includes('"agent_settled"'));
      const stdinEndAt = raw.findIndex((r) => r.dir === 'info' && r.line === 'stdin closed');
      expect(abortAt).toBeLessThan(settledAt);
      expect(settledAt).toBeLessThan(stdinEndAt);
      expect(raw.every((r) => ['send', 'recv', 'info'].includes(r.dir))).toBe(true);
    },
    15_000,
  );

  test(
    'dropped abort: a repeat interrupt re-sends abort only after reabortAfterMs',
    async () => {
      const l = launch('dropabort');
      const rt = await start(factory({ reabortAfterMs: 150 }), l);
      const { events, done } = collect(rt);
      await rt.send('m1', 'go');
      const aborts = () => rawLog(l).filter((r) => r.dir === 'send' && r.line.includes('"type":"abort"')).length;
      const t0 = Date.now();
      await rt.interrupt(); // dropped by the fake
      await rt.interrupt(); // within the window: no second abort
      expect(aborts()).toBe(1);
      await waitUntil(() => Date.now() - t0 >= 150, 1_000, 'reabort window');
      await rt.interrupt(); // window passed, still unanswered → re-abort
      expect(aborts()).toBe(2);
      await waitUntil(() => events.some((e) => e.type === 'interrupt.acked'), 5_000, 'interrupt.acked');
      await rt.close({ graceMs: 500 });
      await done;
      expect(types(events)).toEqual([
        'ready',
        'turn.started:m1',
        'assistant.text:m1',
        'turn.interrupted:m1',
        'interrupt.acked',
        'exited',
      ]);
    },
    15_000,
  );

  test(
    'a child left in pi’s process group after pi exits is swept (SIGKILL)',
    async () => {
      const pidFile = path.join(root, `child-${crypto.randomUUID()}.pid`);
      const rt = await start(factory(), launch('child', { FAKE_CHILD_PID_FILE: pidFile }));
      const { done } = collect(rt);
      await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 5_000, 'child pid');
      const child = Number(fs.readFileSync(pidFile, 'utf8').trim());
      const pgid = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(child)], { stdout: 'pipe' }).stdout.toString().trim();
      expect(pgid).toBe(String(rt.pid));
      await rt.close({ graceMs: 1_000 });
      await done;
      await waitUntil(() => procState(child) === '' || procState(child).startsWith('Z'), 3_000, 'child killed');
      // A killed orphan may linger as a zombie until init reaps it: only zombies may remain.
      expect(liveGroupMembers(rt.pid)).toEqual([]);
    },
    15_000,
  );
});
