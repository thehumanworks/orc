/**
 * Offline I/O tests for the claude runtime against a scripted fake `claude`
 * (test/fixtures/claude-stream/fake-claude.ts): spawn + process group, ready-from-
 * initialize, buffering, exact multi-line text, interrupt, permission deny, close/kill,
 * start failures, raw/stderr logs. The real CLI is covered by claude-runtime.live.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeRuntime, claudeRuntime, startClaudeRuntime } from '../src/runtime/providers/claude.ts';
import type { ProviderEvent, ProviderLaunch, SpawnSpec } from '../src/runtime/types.ts';

const FAKE = path.join(import.meta.dir, 'fixtures', 'claude-stream', 'fake-claude.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-io-')));
const bin = path.join(root, 'claude');
fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
const configDir = path.join(root, 'claude-config');
fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
const spawned: ClaudeRuntime[] = [];

afterAll(async () => {
  for (const rt of spawned) await rt.close({ graceMs: 100 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

async function waitUntil(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

class Tap {
  readonly events: ProviderEvent[] = [];
  readonly done: Promise<void>;
  constructor(rt: ClaudeRuntime) {
    this.done = (async () => {
      for await (const ev of rt.events()) this.events.push(ev);
    })();
  }
  async waitFor(pred: (e: ProviderEvent) => boolean, ms = 5_000): Promise<ProviderEvent> {
    const ok = await waitUntil(() => this.events.some(pred), ms);
    if (!ok) throw new Error(`event not seen; got ${JSON.stringify(this.events.map((e) => e.type))}`);
    return this.events.find(pred) as ProviderEvent;
  }
}

function launch(over: Partial<SpawnSpec> = {}, resume = false, extraEnv: Record<string, string> = {}): ProviderLaunch {
  const sessionId = over.sessionId ?? randomUUID();
  const dir = path.join(root, 'sessions', sessionId);
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    spec: {
      version: 1,
      sessionId,
      provider: 'claude',
      cwd,
      env: { ORC_SESSION_ID: sessionId },
      createdAt: new Date().toISOString(),
      ...over,
    },
    resume,
    env: {
      ...(process.env as Record<string, string>),
      ORC_CLAUDE_BIN: bin,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_ENTRYPOINT: 'remote_cowork',
      CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: 'true',
      CLAUDE_CODE_MAX_RETRIES: '2',
      ...extraEnv,
    },
    rawLogPath: path.join(dir, 'provider.jsonl'),
  };
}

async function start(l: ProviderLaunch): Promise<ClaudeRuntime> {
  const rt = (await claudeRuntime.start(l)) as ClaudeRuntime;
  spawned.push(rt);
  return rt;
}

const rawEntries = (l: ProviderLaunch) =>
  fs
    .readFileSync(l.rawLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x) as { dir: string; line?: string; info?: Record<string, unknown> });

describe('claude runtime I/O (fake claude)', () => {
  test(
    'start: detached group, ready buffered before iteration, env stripped, logs written',
    async () => {
      const record = path.join(root, `record-${randomUUID()}.json`);
      const l = launch({}, false, { FAKE_CLAUDE_RECORD: record });
      const rt = await start(l);
      expect(rt.pid).toBeGreaterThan(0);
      expect(rt.providerSessionId).toBe(l.spec.sessionId);
      // Own process group (pgid === pid).
      const ps = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(rt.pid)]);
      expect(ps.stdout.toString().trim()).toBe(String(rt.pid));

      await Bun.sleep(50); // events produced before anyone iterates must not be lost
      const tap = new Tap(rt);
      const ready = (await tap.waitFor((e) => e.type === 'ready')) as Extract<ProviderEvent, { type: 'ready' }>;
      expect(tap.events[0]).toBe(ready);
      expect(ready.providerSessionId).toBe(l.spec.sessionId);
      expect(ready.transcriptPath).toBeUndefined(); // fresh: no transcript yet
      expect(ready.info?.pid).toBe(rt.pid);
      expect(ready.info?.claude_code_version).toBe('2.1.299');
      expect(() => rt.events()).toThrow(/single-consumer/);

      const rec = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string> };
      expect(rec.argv.slice(0, 1)).toEqual(['-p']);
      expect(rec.argv).toContain('--replay-user-messages');
      expect(rec.argv[rec.argv.indexOf('--session-id') + 1]).toBe(l.spec.sessionId);
      expect(rec.argv).not.toContain('--resume');
      expect(rec.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(rec.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES).toBeUndefined();
      expect(rec.env.CLAUDE_CODE_MAX_RETRIES).toBe('2');
      expect(rec.env.ORC_SESSION_ID).toBe(l.spec.sessionId);

      await rt.close();
      await tap.done;
      const raw = rawEntries(l);
      expect(raw.some((e) => e.dir === 'send' && e.line?.includes('"initialize"'))).toBe(true);
      expect(raw.some((e) => e.dir === 'recv' && e.line?.includes('"control_response"'))).toBe(true);
      expect(fs.readFileSync(l.rawLogPath, 'utf8')).not.toContain('secret@example.com');
      expect((fs.statSync(l.rawLogPath).mode & 0o777).toString(8)).toBe('600');
      expect(fs.existsSync(path.join(path.dirname(l.rawLogPath), 'provider.stderr.log'))).toBe(true);
    },
    15_000,
  );

  test(
    'turns: exact multi-line text, one outcome per turn, send-while-open rejects, idle interrupt no-op',
    async () => {
      const l = launch();
      const rt = await start(l);
      const tap = new Tap(rt);
      const text = 'line one "double" and \'single\'\nline two: ünïcödé ✓ 日本語 \\ backslash\n\n\tlast line';
      await rt.interrupt(); // idle → nothing written
      await rt.send('m1', text);
      await expect(rt.send('m2', 'second')).rejects.toThrow(/already open/);
      const done1 = (await tap.waitFor((e) => e.type === 'turn.completed')) as Extract<
        ProviderEvent,
        { type: 'turn.completed' }
      >;
      expect(done1.messageId).toBe('m1');
      expect(done1.result).toBe(`echo: ${text}`);
      expect(done1.costUsd).toBeCloseTo(0.001, 10);
      expect(done1.usage).toEqual({ inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 11 });
      const forM1 = tap.events.filter((e) => 'messageId' in e && e.messageId === 'm1').map((e) => e.type);
      expect(forM1).toEqual(['turn.started', 'assistant.text', 'turn.completed']);
      expect(rt.initInfo?.capabilities).toContain('interrupt_receipt_v1');
      expect(rt.initInfo?.skillsCount).toBe(2);

      await rt.send('m2', 'second');
      const done2 = (await tap.waitFor((e) => e.type === 'turn.completed' && e.messageId === 'm2')) as Extract<
        ProviderEvent,
        { type: 'turn.completed' }
      >;
      expect(done2.costUsd).toBeCloseTo(0.001, 10); // delta of the cumulative total
      expect(rawEntries(l).filter((e) => e.dir === 'send' && e.line?.includes('"interrupt"')).length).toBe(0);
      await rt.close();
      await tap.done;
      expect(tap.events.at(-1)).toEqual({ type: 'exited', code: 0, signal: null });
    },
    15_000,
  );

  test(
    'interrupt mid-turn → acked + interrupted; runtime stays usable; permission → deny',
    async () => {
      const rt = await start(launch());
      const tap = new Tap(rt);
      await rt.send('h1', 'please HANG');
      await tap.waitFor((e) => e.type === 'turn.started' && e.messageId === 'h1');
      await rt.interrupt();
      await tap.waitFor((e) => e.type === 'turn.interrupted');
      expect(tap.events.some((e) => e.type === 'interrupt.acked')).toBe(true);
      expect(tap.events.filter((e) => 'messageId' in e && e.messageId === 'h1').map((e) => e.type)).toEqual([
        'turn.started',
        'turn.interrupted',
      ]);
      expect(rt.openMessageId).toBeUndefined();

      await rt.send('p1', 'PERM please');
      const perm = (await tap.waitFor((e) => e.type === 'permission.requested')) as Extract<
        ProviderEvent,
        { type: 'permission.requested' }
      >;
      expect(perm.messageId).toBe('p1');
      const done = (await tap.waitFor((e) => e.type === 'turn.completed' && e.messageId === 'p1')) as Extract<
        ProviderEvent,
        { type: 'turn.completed' }
      >;
      expect(done.result).toBe('perm answer: deny');
      await rt.close();
      await tap.done;
    },
    15_000,
  );

  test(
    'close: stragglers in the group are killed; a hung turn is killed after graceMs',
    async () => {
      const rt1 = await start(launch());
      const tap1 = new Tap(rt1);
      await rt1.send('s1', 'SPAWN_CHILD');
      await tap1.waitFor((e) => e.type === 'turn.completed');
      expect(groupAlive(rt1.pid)).toBe(true);
      await rt1.close();
      await tap1.done;
      expect(await waitUntil(() => !groupAlive(rt1.pid), 3_000)).toBe(true);

      const l2 = launch();
      const rt2 = await start(l2);
      const tap2 = new Tap(rt2);
      await rt2.send('h1', 'HANG forever');
      await tap2.waitFor((e) => e.type === 'turn.started');
      const t0 = Date.now();
      const closing = rt2.close({ graceMs: 300 });
      await rt2.interrupt(); // while closing (turn still open) → no-op
      await closing;
      expect(Date.now() - t0).toBeLessThan(4_000);
      await rt2.interrupt(); // after close → no-op
      const rawText = fs.readFileSync(l2.rawLogPath, 'utf8');
      expect(rawText).not.toContain('\\"subtype\\":\\"interrupt\\"');
      await tap2.done;
      const last = tap2.events.at(-1) as Extract<ProviderEvent, { type: 'exited' }>;
      expect(last.type).toBe('exited');
      expect(last.code === 0).toBe(false);
      // No outcome is synthesised for the open turn: the kernel owns provider-exit.
      expect(tap2.events.some((e) => e.type === 'turn.interrupted' || e.type === 'turn.failed')).toBe(false);
      expect(await waitUntil(() => !groupAlive(rt2.pid), 3_000)).toBe(true);
      await expect(rt2.send('x', 'y')).rejects.toThrow(/exited|closing/);
    },
    20_000,
  );

  test(
    'resume: transcript resolved; first cost undefined; missing conversation fails start()',
    async () => {
      const sid = randomUUID();
      const proj = path.join(configDir, 'projects', '-some-cwd');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, `${sid}.jsonl`), '{}\n');
      const record = path.join(root, `record-${randomUUID()}.json`);
      const l = launch({ sessionId: sid, providerSessionId: sid }, true, { FAKE_CLAUDE_RECORD: record });
      const rt = await start(l);
      const tap = new Tap(rt);
      const ready = (await tap.waitFor((e) => e.type === 'ready')) as Extract<ProviderEvent, { type: 'ready' }>;
      expect(ready.transcriptPath).toBe(path.join(proj, `${sid}.jsonl`));
      const rec = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[] };
      expect(rec.argv[rec.argv.indexOf('--resume') + 1]).toBe(sid);
      expect(rec.argv).not.toContain('--session-id');
      await rt.send('r1', 'hello');
      const c1 = (await tap.waitFor((e) => e.type === 'turn.completed')) as Extract<ProviderEvent, { type: 'turn.completed' }>;
      expect('costUsd' in c1).toBe(false);
      await rt.close();
      await tap.done;

      const missing = '00000000-0000-4000-8000-000000000000';
      const lm = launch({ sessionId: missing, providerSessionId: missing }, true);
      const err = await startClaudeRuntime(lm).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('exited before ready');
      expect(err?.message).toContain(`resume of ${missing}`);
      expect(err?.message).toContain('No conversation found');
    },
    15_000,
  );

  test('start() validates the system prompt file and the binary before spawning', async () => {
    await expect(
      startClaudeRuntime(launch({ systemPrompt: { mode: 'append', path: 'relative.md' } })),
    ).rejects.toThrow(/must be absolute/);
    await expect(
      startClaudeRuntime(launch({ systemPrompt: { mode: 'replace', path: path.join(root, 'nope.md') } })),
    ).rejects.toThrow(/not found/);
    await expect(startClaudeRuntime(launch(), { bin: 'orc-no-such-claude-binary' })).rejects.toThrow(/not found on PATH/);
  });

  test(
    'start() times out when initialize is never answered, and kills the group',
    async () => {
      const silent = path.join(root, 'silent-claude');
      fs.writeFileSync(silent, '#!/bin/sh\nexec sleep 37.123\n', { mode: 0o755 });
      const t0 = Date.now();
      const err = await startClaudeRuntime(launch(), { bin: silent, readyTimeoutMs: 300 }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/no initialize response within 300ms/);
      expect(Date.now() - t0).toBeLessThan(5_000);
      // The sleep is gone (we cannot know its pid here; assert no `sleep 37.123` child of ours).
      const ps = Bun.spawnSync(['pgrep', '-f', '^sleep 37.123$']);
      expect(ps.stdout.toString().trim()).toBe('');
    },
    10_000,
  );
});
