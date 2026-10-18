/**
 * Contract test: the pi runtime against the REAL `pi --mode rpc` (pinned: pi 1.2.0) talking
 * to a local Bun.serve mock model provider (openai-completions SSE). No auth, no network,
 * never touches the real ~/.pi: HOME and PI_CODING_AGENT_DIR point at temp dirs and the
 * child env is built from scratch (no inherited provider keys / cloud creds / proxies).
 *
 * pi binary: $ORC_TEST_PI_BIN, else `pi` on PATH, else the S4 scratch install. When none
 * exists the suite registers a visible skipped test instead of running.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PI_VERIFIED_VERSION } from '../src/runtime/providers/pi-protocol.ts';
import { createPiRuntime, piStderrLogPath } from '../src/runtime/providers/pi.ts';
import type { ProviderEvent, ProviderLaunch, ProviderRuntime, SpawnSpec } from '../src/runtime/types.ts';

const SCRATCH_PI_BIN =
  '/tmp/claude-0/-home-claude/b00ce3a9-453c-561e-a590-e55f008719e0/scratchpad/pi/node_modules/.bin/pi';

/** $ORC_TEST_PI_BIN, else `pi` on PATH, else the S4 scratch install; null when none is executable. */
function resolveTestPiBin(): string | null {
  const candidates = [process.env.ORC_TEST_PI_BIN, Bun.which('pi'), SCRATCH_PI_BIN];
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // try the next one
    }
  }
  return null;
}

const RESOLVED_PI_BIN = resolveTestPiBin();
const HAVE_PI = RESOLVED_PI_BIN !== null;
const PI_BIN = RESOLVED_PI_BIN ?? 'pi';
if (!HAVE_PI) {
  // Visible in the test report (not just a log line): the contract — incl. the version pin — did not run.
  test.skip('pi runtime contract: no pi binary found (set ORC_TEST_PI_BIN or put pi on PATH)', () => {});
}
const d = HAVE_PI ? describe : describe.skip;

// ---------------------------------------------------------------------------------
// Mock model provider
// ---------------------------------------------------------------------------------

interface MockMessage {
  role: string;
  text: string;
}

/**
 * Behaviour by the last user message:
 *   contains FAIL400 → HTTP 400 (pi does not retry)
 *   contains SLOW    → a slow stream (~40 chunks × 150 ms) that stops when pi aborts
 *   starts with ECHO → streams the user text back verbatim (chunked)
 *   otherwise        → "MOCK OK: <first line of the user text>"
 */
class MockModel {
  readonly requests: MockMessage[][] = [];
  private streamingWaiters: Array<() => void> = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(): void {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => this.handle(req),
    });
  }

  stop(): void {
    this.server?.stop(true);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server?.port}/v1`;
  }

  /** Resolves once a SLOW stream has sent its first content chunk. */
  nextSlowStream(): Promise<void> {
    return new Promise((resolve) => this.streamingWaiters.push(resolve));
  }

  lastUserText(i = this.requests.length - 1): string {
    const msgs = this.requests[i] ?? [];
    return [...msgs].reverse().find((m) => m.role === 'user')?.text ?? '';
  }

  private async handle(req: Request): Promise<Response> {
    const body = (await req.json()) as { messages?: Array<{ role: string; content: unknown }> };
    const messages: MockMessage[] = (body.messages ?? []).map((m) => ({ role: m.role, text: textOf(m.content) }));
    this.requests.push(messages);
    const last = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';

    if (last.includes('FAIL400')) {
      return Response.json(
        { error: { message: 'mock upstream rejected request', type: 'invalid_request_error', code: 'mock_400' } },
        { status: 400 },
      );
    }
    const slow = last.includes('SLOW');
    const parts = slow
      ? Array.from({ length: 40 }, (_, i) => `chunk${i} `)
      : last.startsWith('ECHO')
        ? chunk(last, 7)
        : [`MOCK OK: ${last.split('\n')[0]}`];
    const onStreaming = () => this.streamingWaiters.splice(0).forEach((w) => w());
    const enc = new TextEncoder();
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        try {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          for (const [i, p] of parts.entries()) {
            if (req.signal.aborted) throw new Error('aborted');
            send({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
            if (slow) {
              if (i === 0) onStreaming();
              await Bun.sleep(150);
            }
          }
          send({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
          });
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        } catch {
          // client aborted mid-stream
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  }
  return '';
}

function chunk(s: string, n: number): string[] {
  const cps = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''));
  return out.length ? out : [''];
}

// ---------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------

const mock = new MockModel();
let root = '';
let agentDir = '';
let homeDir = '';
const live: ProviderRuntime[] = [];
const factory = createPiRuntime({ bin: PI_BIN, bootTimeoutMs: 20_000 });

function piEnv(agent = agentDir): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir,
    LANG: 'C.UTF-8',
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

interface Session {
  dir: string;
  cwd: string;
  sessionId: string;
  sessionDir: string;
  spec: SpawnSpec;
}

function newSession(over: Partial<SpawnSpec> = {}): Session {
  const dir = fs.mkdtempSync(path.join(root, 'sess-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(dir, 'pi-sessions');
  const spec: SpawnSpec = {
    version: 1,
    sessionId,
    provider: 'pi',
    cwd,
    env: {},
    model: 'mock/mock-model',
    sessionDir,
    createdAt: new Date().toISOString(),
    ...over,
  };
  return { dir, cwd, sessionId, sessionDir, spec };
}

function launchOf(s: Session, resume = false, over: Partial<ProviderLaunch> = {}): ProviderLaunch {
  return { spec: s.spec, resume, env: piEnv(), rawLogPath: path.join(s.dir, 'provider.jsonl'), ...over };
}

async function start(launch: ProviderLaunch): Promise<ProviderRuntime> {
  const rt = await factory.start(launch);
  live.push(rt);
  return rt;
}

/** Background consumer with predicate waits (no fixed sleeps). */
class Collector {
  readonly events: ProviderEvent[] = [];
  ended = false;
  private waiters: Array<() => void> = [];
  readonly done: Promise<void>;

  constructor(rt: ProviderRuntime) {
    this.done = (async () => {
      for await (const ev of rt.events()) {
        this.events.push(ev);
        this.notify();
      }
      this.ended = true;
      this.notify();
    })();
  }

  async waitFor(pred: (e: ProviderEvent) => boolean, timeoutMs = 15_000): Promise<ProviderEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (this.ended) throw new Error(`stream ended without match; events=${JSON.stringify(this.types())}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; events=${JSON.stringify(this.types())}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  outcome(messageId: string, timeoutMs?: number): Promise<ProviderEvent> {
    return this.waitFor(
      (e) =>
        (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') &&
        e.messageId === messageId,
      timeoutMs,
    );
  }

  forTurn(messageId: string): ProviderEvent[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === messageId);
  }

  types(): string[] {
    return this.events.map((e) => ('messageId' in e && e.messageId ? `${e.type}:${e.messageId}` : e.type));
  }

  private notify(): void {
    this.waiters.splice(0).forEach((w) => w());
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
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

function processesMentioning(needle: string): string[] {
  const r = Bun.spawnSync(['ps', '-eo', 'pid=,args='], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout
    .toString()
    .split('\n')
    .filter((l) => l.includes(needle) && !l.includes('ps -eo'));
}

function rawLog(s: Session): Array<{ ts: string; dir: string; line: string }> {
  const p = path.join(s.dir, 'provider.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ts: string; dir: string; line: string });
}

beforeAll(() => {
  if (!HAVE_PI) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-pi-contract-'));
  agentDir = path.join(root, 'agent');
  homeDir = path.join(root, 'home');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  mock.start();
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: mock.baseUrl,
          api: 'openai-completions',
          apiKey: 'mock-key',
          models: [
            { id: 'mock-model', name: 'Mock', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 },
          ],
        },
      },
    }),
  );
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((rt) => rt.close({ graceMs: 1_000 }).catch(() => {})));
});

afterAll(() => {
  if (!HAVE_PI) return;
  mock.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------

d('pi runtime contract (real pi --mode rpc, mock model)', () => {
  test(
    `pinned pi version is ${PI_VERIFIED_VERSION}`,
    () => {
      const r = Bun.spawnSync([PI_BIN, '--version'], { env: piEnv(), stdout: 'pipe', stderr: 'pipe' });
      expect(r.stdout.toString().trim()).toBe(PI_VERIFIED_VERSION);
    },
    15_000,
  );

  test(
    'fresh start → ready (session id, transcript path, model, version); own process group; close → exited',
    async () => {
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      const ready = await c.waitFor((e) => e.type === 'ready');
      expect(c.events[0]).toBe(ready);
      if (ready.type !== 'ready') throw new Error('unreachable');
      expect(ready.providerSessionId).toBe(s.sessionId);
      expect(ready.transcriptPath).toStartWith(`${s.sessionDir}/`);
      expect(ready.transcriptPath).toEndWith(`_${s.sessionId}.jsonl`);
      expect(ready.info).toMatchObject({ model: 'mock/mock-model', version: PI_VERIFIED_VERSION, messageCount: 0 });

      const ps = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(rt.pid)], { stdout: 'pipe' });
      expect(ps.stdout.toString().trim()).toBe(String(rt.pid));
      expect(fs.existsSync(piStderrLogPath(path.join(s.dir, 'provider.jsonl')))).toBe(true);

      // interrupt() with no open turn is a no-op.
      await rt.interrupt();
      await rt.close({ graceMs: 2_000 });
      await c.done;
      expect(c.types()).toEqual(['ready', 'exited']);
      expect(c.events.at(-1)).toEqual({ type: 'exited', code: 0, signal: null });
      expect(groupAlive(rt.pid)).toBe(false);
    },
    30_000,
  );

  test(
    'two turns: started → text → completed with the mock reply; buffered before iteration; send while open rejects',
    async () => {
      const promptFile = path.join(root, `sysprompt-${crypto.randomUUID()}.md`);
      fs.writeFileSync(promptFile, 'ORC-APPEND-MARKER-7f3a: follow orc instructions.\n');
      const s = newSession({ systemPrompt: { mode: 'append', path: promptFile } });
      const rt = await start(launchOf(s));

      // Run a whole turn BEFORE anyone iterates events(): nothing may be lost.
      await rt.send('m-1', 'hello one');
      await waitUntil(
        () => rawLog(s).some((r) => r.dir === 'recv' && r.line.includes('"agent_settled"')),
        15_000,
        'agent_settled in raw log',
      );
      const c = new Collector(rt);
      await c.outcome('m-1');
      expect(c.types()).toEqual(['ready', 'turn.started:m-1', 'assistant.text:m-1', 'turn.completed:m-1']);
      expect(c.events[2]).toEqual({ type: 'assistant.text', messageId: 'm-1', text: 'MOCK OK: hello one' });
      expect(c.events[3]).toMatchObject({
        type: 'turn.completed',
        messageId: 'm-1',
        result: 'MOCK OK: hello one',
        usage: { inputTokens: 11, outputTokens: 2 },
      });
      // The system prompt FILE (not its path string) reached the model.
      const system = mock.requests.at(-1)?.find((m) => m.role === 'system' || m.role === 'developer');
      expect(system?.text).toContain('ORC-APPEND-MARKER-7f3a');

      const second = rt.send('m-2', 'hello two');
      await expect(rt.send('m-3', 'not now')).rejects.toThrow(/still open/);
      await second;
      expect(await c.outcome('m-2')).toMatchObject({ type: 'turn.completed', result: 'MOCK OK: hello two' });
      expect(c.forTurn('m-3')).toEqual([]);

      // Raw log: both directions, verbatim, tagged.
      const raw = rawLog(s);
      expect(raw.some((r) => r.dir === 'send' && JSON.parse(r.line).id === 'm-2')).toBe(true);
      expect(raw.some((r) => r.dir === 'recv' && r.line.includes('"command":"prompt"'))).toBe(true);
      expect(raw.every((r) => ['send', 'recv', 'info'].includes(r.dir) && typeof r.ts === 'string')).toBe(true);
    },
    30_000,
  );

  test(
    'multi-line prompt (newlines, quotes, unicode) round-trips exactly',
    async () => {
      const text =
        'ECHO multi-line check\nline 2 has "double" and \'single\' quotes\n\ttab, back\\slash, {"json":true}\n' +
        'unicode: café ✓ — 日本語 🚀\u2028after-LS\u2029after-PS\nlast line';
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      await rt.send('m-ml', text);
      const out = await c.outcome('m-ml');
      expect(mock.lastUserText()).toBe(text);
      expect(out).toMatchObject({ type: 'turn.completed', result: text });
    },
    30_000,
  );

  test(
    'interrupt during a slow response → turn.interrupted + interrupt.acked; next turn works',
    async () => {
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      const streaming = mock.nextSlowStream();
      await rt.send('m-slow', 'SLOW please');
      await streaming;
      await rt.interrupt();
      await rt.interrupt(); // second request for the same turn: no-op
      expect(await c.outcome('m-slow')).toEqual({ type: 'turn.interrupted', messageId: 'm-slow' });
      await c.waitFor((e) => e.type === 'interrupt.acked');
      await rt.send('m-after', 'after the interrupt');
      expect(await c.outcome('m-after')).toMatchObject({ type: 'turn.completed', result: 'MOCK OK: after the interrupt' });
      const t = c.types();
      expect(t.filter((x) => x === 'interrupt.acked')).toHaveLength(1);
      expect(t.indexOf('turn.interrupted:m-slow')).toBeLessThan(t.indexOf('interrupt.acked'));
      expect(t).not.toContain('turn.completed:m-slow');
    },
    30_000,
  );

  test(
    'interrupt requested before the prompt ack is deferred and still interrupts the run',
    async () => {
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      const sent = rt.send('m-early', 'SLOW early interrupt');
      await rt.interrupt();
      await sent;
      expect(await c.outcome('m-early')).toEqual({ type: 'turn.interrupted', messageId: 'm-early' });
      await c.waitFor((e) => e.type === 'interrupt.acked');
    },
    30_000,
  );

  test(
    'provider error (HTTP 400) → turn.failed with the provider message',
    async () => {
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      await rt.send('m-400', 'FAIL400 please');
      const out = await c.outcome('m-400');
      expect(out.type).toBe('turn.failed');
      expect((out as { error: string }).error).toContain('mock upstream rejected request');
      expect(c.forTurn('m-400').map((e) => e.type)).toEqual(['turn.started', 'turn.failed']);
    },
    30_000,
  );

  test(
    'close with an open turn → aborts first (partial reply persisted), then exited (last); no process left in the group',
    async () => {
      const s = newSession();
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      const streaming = mock.nextSlowStream();
      await rt.send('m-open', 'SLOW until closed');
      await streaming;
      // The server enqueueing a chunk does not prove Pi consumed it. Synchronize on the
      // real RPC output before aborting so this checks persistence of received text.
      const streamedBy = Date.now() + 5_000;
      while (!rawLog(s).some((r) => r.dir === 'recv' && r.line.includes('text_delta') && r.line.includes('chunk0'))) {
        if (Date.now() > streamedBy) throw new Error('Pi did not emit the first content chunk');
        await Bun.sleep(10);
      }
      await rt.close({ graceMs: 3_000 });
      await c.done;
      // close() aborts first: pi itself settles the run (and answers the abort) before stdin ends.
      expect(c.types().slice(-3)).toEqual(['turn.interrupted:m-open', 'interrupt.acked', 'exited']);
      expect(c.events.at(-1)).toEqual({ type: 'exited', code: 0, signal: null });
      expect(groupAlive(rt.pid)).toBe(false);
      const raw = rawLog(s);
      const abortAt = raw.findIndex((r) => r.dir === 'send' && r.line.includes('"type":"abort"'));
      const settledAt = raw.findIndex((r) => r.dir === 'recv' && r.line.includes('"agent_settled"'));
      const stdinEndAt = raw.findIndex((r) => r.dir === 'info' && r.line === 'stdin closed');
      expect(abortAt).toBeGreaterThan(-1);
      expect(settledAt).toBeGreaterThan(abortAt);
      expect(stdinEndAt).toBeGreaterThan(settledAt);
      // pi persisted the partial assistant reply, not just an unanswered user message.
      const ready = c.events[0];
      if (ready?.type !== 'ready' || !ready.transcriptPath) throw new Error('no transcript path');
      const persisted = fs
        .readFileSync(ready.transcriptPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } });
      const assistant = persisted.filter((e) => e.type === 'message' && e.message?.role === 'assistant');
      expect(assistant.length).toBe(1);
      expect(assistant[0]?.message?.stopReason).toBe('aborted');
      expect(JSON.stringify(assistant[0]?.message?.content)).toContain('chunk0');
      await expect(rt.send('m-late', 'x')).rejects.toThrow(/closed/);
      await rt.close(); // idempotent
    },
    30_000,
  );

  test(
    'resume (new runtime, same spec + cwd) → ready with history; the next turn carries it',
    async () => {
      const s = newSession();
      const first = await start(launchOf(s));
      const c1 = new Collector(first);
      const ready1 = await c1.waitFor((e) => e.type === 'ready');
      await first.send('m-r1', 'remember PINEAPPLE');
      await c1.outcome('m-r1');
      await first.close();
      await c1.done;

      const second = await start(launchOf(s, true));
      const c2 = new Collector(second);
      const ready2 = await c2.waitFor((e) => e.type === 'ready');
      if (ready1.type !== 'ready' || ready2.type !== 'ready') throw new Error('unreachable');
      expect(ready2.providerSessionId).toBe(s.sessionId);
      expect(ready2.transcriptPath).toBe(ready1.transcriptPath as string);
      expect(fs.existsSync(ready2.transcriptPath as string)).toBe(true);
      expect(ready2.info?.messageCount as number).toBeGreaterThan(0);

      await second.send('m-r2', 'what did I ask you to remember?');
      expect(await c2.outcome('m-r2')).toMatchObject({ type: 'turn.completed' });
      const seen = mock.requests.at(-1) ?? [];
      expect(seen.some((m) => m.role === 'user' && m.text === 'remember PINEAPPLE')).toBe(true);
      expect(seen.some((m) => m.role === 'assistant' && m.text === 'MOCK OK: remember PINEAPPLE')).toBe(true);
    },
    40_000,
  );

  test(
    'resume from a different cwd → start() rejects (empty session) and leaves no pi process',
    async () => {
      const s = newSession();
      const first = await start(launchOf(s));
      const c1 = new Collector(first);
      await first.send('m-c1', 'hello cwd');
      await c1.outcome('m-c1');
      await first.close();

      const otherCwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'other-cwd-')));
      const moved: Session = { ...s, spec: { ...s.spec, cwd: otherCwd } };
      await expect(factory.start(launchOf(moved, true))).rejects.toThrow(/EMPTY session/);
      expect(processesMentioning(s.sessionId)).toEqual([]);
    },
    40_000,
  );

  test(
    'extension dialog → permission.requested, auto-cancelled so the turn still completes',
    async () => {
      const s = newSession();
      // A trusted (-a) project extension that blocks on a confirm dialog before each run.
      fs.mkdirSync(path.join(s.cwd, '.pi', 'extensions'), { recursive: true });
      fs.writeFileSync(
        path.join(s.cwd, '.pi', 'extensions', 'orc-ask.ts'),
        [
          'export default function (pi: any) {',
          '  pi.on("before_agent_start", async (event: any, ctx: any) => {',
          '    if (!String(event.prompt ?? "").includes("ASKME")) return;',
          '    const ok = await ctx.ui.confirm("orc-test-dialog", "allow?");',
          '    if (ok) throw new Error("dialog unexpectedly confirmed");',
          '  });',
          '}',
          '',
        ].join('\n'),
      );
      const rt = await start(launchOf(s));
      const c = new Collector(rt);
      await rt.send('m-ask', 'ASKME then answer');
      const perm = await c.waitFor((e) => e.type === 'permission.requested');
      expect(perm).toMatchObject({
        type: 'permission.requested',
        messageId: 'm-ask',
        detail: { type: 'extension_ui_request', method: 'confirm', title: 'orc-test-dialog' },
      });
      expect(await c.outcome('m-ask')).toMatchObject({ type: 'turn.completed', result: 'MOCK OK: ASKME then answer' });
      const raw = rawLog(s);
      expect(raw.some((r) => r.dir === 'send' && r.line.includes('"extension_ui_response"') && r.line.includes('"cancelled":true'))).toBe(true);
    },
    30_000,
  );

  test(
    'start() rejects: missing system prompt file (before spawn) and no usable model',
    async () => {
      const s = newSession({ systemPrompt: { mode: 'append', path: path.join(root, 'does-not-exist.md') } });
      await expect(factory.start(launchOf(s))).rejects.toThrow(/system prompt file missing/);
      expect(fs.existsSync(path.join(s.dir, 'provider.jsonl'))).toBe(false);

      const emptyAgent = fs.mkdtempSync(path.join(root, 'agent-empty-'));
      const u = newSession({ model: undefined });
      await expect(factory.start(launchOf(u, false, { env: piEnv(emptyAgent) }))).rejects.toThrow(/no usable model/);
      expect(processesMentioning(u.sessionId)).toEqual([]);
    },
    30_000,
  );
});
