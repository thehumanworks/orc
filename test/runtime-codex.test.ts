/**
 * codex runtime tests.
 *
 * 1. JSON-RPC client unit tests.
 * 2. Pure mapping tests: captured `codex app-server` 0.162.1 lines (test/fixtures/codex/*.jsonl,
 *    recorded against a stub Responses API and against the real API without credentials)
 *    are replayed into CodexProtocol and the emitted ProviderEvents / written replies asserted.
 * 3. REAL-process contract tests against `codex app-server` with a per-test temp CODEX_HOME
 *    that routes the model to an in-process stub Responses API (never touches ~/.codex).
 *    Binary: ORC_TEST_CODEX_BIN, else `codex` on PATH, else the probe install below; the
 *    suite is skipped (visibly) when none exists. The pin test fails on another version.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_PROTOCOL_VERIFIED_VERSION,
  CodexProtocol,
  CodexStartError,
  codexRuntime,
  codexStderrLogPath,
  mapCodexStartError,
} from '../src/runtime/providers/codex.ts';
import { JsonRpcClient, RpcClosedError, RpcError, RpcTimeoutError } from '../src/runtime/providers/codex-rpc.ts';
import type { ProviderEvent, ProviderRuntime, SpawnSpec } from '../src/runtime/types.ts';
import { makeStubCodexHome, startCodexStub, type CodexStub } from './fixtures/codex-stub.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'codex');
const PROBE_CODEX_BIN =
  '/tmp/claude-0/-home-claude/b00ce3a9-453c-561e-a590-e55f008719e0/scratchpad/cx/node_modules/.bin/codex';
const CODEX_BIN: string | null =
  process.env.ORC_TEST_CODEX_BIN ?? Bun.which('codex') ?? (fs.existsSync(PROBE_CODEX_BIN) ? PROBE_CODEX_BIN : null);
const HAVE_CODEX = CODEX_BIN !== null && fs.existsSync(CODEX_BIN);

/** Resolves with the rejection reason of `p`; fails the test if `p` resolves. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rejectionOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the promise to reject');
}

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// =====================================================================================
// 1. JSON-RPC client
// =====================================================================================

describe('codex-rpc JsonRpcClient', () => {
  function client() {
    const written: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const notifications: [string, unknown][] = [];
    const requests: unknown[] = [];
    const c = new JsonRpcClient({
      write: (l) => written.push(JSON.parse(l)),
      onNotification: (m, p) => notifications.push([m, p]),
      onServerRequest: (r) => requests.push(r),
      onStray: (_l, why) => notes.push(why),
    });
    return { c, written, notes, notifications, requests };
  }

  test('requests get sequential ids and resolve on their response', async () => {
    const { c, written } = client();
    const p0 = c.request<{ a: number }>('m0', { x: 1 }, { timeoutMs: 1_000 });
    const p1 = c.request('m1', undefined, { timeoutMs: 1_000 });
    expect(written).toEqual([{ method: 'm0', id: 0, params: { x: 1 } }, { method: 'm1', id: 1 }]);
    c.handleLine('{"id":1,"result":{}}');
    c.handleLine('{"id":0,"result":{"a":7}}');
    expect(await p0).toEqual({ a: 7 });
    expect(await p1).toEqual({});
    expect(c.pendingCount).toBe(0);
  });

  test('error responses reject with RpcError carrying code and method', async () => {
    const { c } = client();
    const p = c.request('thread/resume', {}, { timeoutMs: 1_000 });
    c.handleLine('{"error":{"code":-32600,"message":"no rollout found for thread id x"},"id":0}');
    const e = await rejectionOf(p);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32600);
    expect(e.method).toBe('thread/resume');
    expect(e.message).toContain('no rollout found');
  });

  test('a request with no response times out (never hangs) and a late response is stray', async () => {
    const { c, notes } = client();
    const t0 = Date.now();
    const e = await rejectionOf(c.request('slow', {}, { timeoutMs: 50 }));
    expect(e).toBeInstanceOf(RpcTimeoutError);
    expect(e.message).toContain('slow timed out after 50ms');
    expect(Date.now() - t0).toBeLessThan(2_000);
    c.handleLine('{"id":0,"result":{}}');
    expect(notes).toEqual(['response for unknown or expired id']);
  });

  test('onSettled runs synchronously, before later lines are dispatched', () => {
    const order: string[] = [];
    const c = new JsonRpcClient({
      write: () => {},
      onNotification: (m) => order.push(`notify:${m}`),
      onServerRequest: () => {},
    });
    void c.request('turn/start', {}, { timeoutMs: 1_000, onSettled: () => order.push('settled:turn/start') });
    c.handleLine('{"id":0,"result":{"turn":{"id":"t"}}}');
    c.handleLine('{"method":"turn/started","params":{}}');
    expect(order).toEqual(['settled:turn/start', 'notify:turn/started']);
  });

  test('close() rejects pending and later requests with RpcClosedError', async () => {
    const { c } = client();
    const p = c.request('a', {}, { timeoutMs: 5_000 });
    c.close(new Error('codex app-server exited (code 0)'));
    expect(await rejectionOf(p)).toBeInstanceOf(RpcClosedError);
    const later = await rejectionOf(c.request('b', {}, { timeoutMs: 5_000 }));
    expect(later).toBeInstanceOf(RpcClosedError);
    expect(later.message).toContain('exited');
    expect(c.notify('x')).toBe(false);
  });

  test('a write failure rejects the request immediately', async () => {
    const c = new JsonRpcClient({
      write: () => {
        throw new Error('EPIPE');
      },
      onNotification: () => {},
      onServerRequest: () => {},
    });
    const e = await rejectionOf(c.request('a', {}, { timeoutMs: 5_000 }));
    expect(e).toBeInstanceOf(RpcClosedError);
    expect(e.message).toContain('EPIPE');
    expect(c.pendingCount).toBe(0);
  });

  test('dispatches notifications, server requests and strays', () => {
    const { c, notes, notifications, requests } = client();
    c.handleLine('{"method":"warning","params":{"message":"m"}}');
    c.handleLine('{"method":"item/tool/call","id":5,"params":{"a":1}}');
    c.handleLine('not json');
    c.handleLine('[1,2]');
    c.handleLine('{"foo":1}');
    c.handleLine('   ');
    expect(notifications).toEqual([['warning', { message: 'm' }]]);
    expect(requests).toEqual([{ method: 'item/tool/call', id: 5, params: { a: 1 } }]);
    expect(notes).toEqual(['not JSON', 'not an object', 'neither request, notification nor response']);
  });
});

// =====================================================================================
// 2. Mapping: replay captured lines into CodexProtocol
// =====================================================================================

interface CapturedEntry {
  dir: 'send' | 'recv';
  msg: Record<string, unknown> & { id?: string | number; method?: string };
}

/**
 * Scripted fake app-server. When the protocol writes a request/notification with method M,
 * the replay advances to the next captured `send` with method M (captured requests the
 * client never makes, e.g. turn/steer, are skipped and their responses dropped), maps the
 * captured id to the client's id, and delivers captured `recv` lines up to the next
 * captured client request/notification.
 */
class Replay {
  readonly written: Array<Record<string, unknown>> = [];
  readonly events: ProviderEvent[] = [];
  readonly proto: CodexProtocol;
  private idx = 0;
  private readonly idMap = new Map<string | number, string | number>();
  private readonly dropped = new Set<string | number>();
  private inflight = 0;

  constructor(
    private readonly entries: CapturedEntry[],
    opts: { requestTimeoutMs?: number } = {},
  ) {
    this.proto = new CodexProtocol({
      write: (line) => this.onWrite(line),
      emit: (e) => this.events.push(e),
      requestTimeoutMs: opts.requestTimeoutMs ?? 2_000,
      handshakeTimeoutMs: 2_000,
    });
  }

  static load(name: string, opts?: { requestTimeoutMs?: number }): Replay {
    const lines = fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
    return new Replay(
      lines.map((l) => JSON.parse(l) as CapturedEntry),
      opts,
    );
  }

  /** Resolves once every scheduled delivery has run. */
  async idle(): Promise<void> {
    await waitUntil(() => this.inflight === 0, 2_000, 'replay idle');
  }

  /** Thread id assigned by the captured thread/start response. */
  async open(): Promise<string> {
    await this.proto.initialize({ name: 'orc', title: 'orc', version: 'test' });
    const r = await this.proto.startThread({ cwd: '/w', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    await this.idle();
    return r.thread.id;
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  private onWrite(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.written.push(msg);
    if (typeof msg.method !== 'string') return; // our reply to a server request
    let j = this.idx;
    while (j < this.entries.length && !(this.entries[j]!.dir === 'send' && this.entries[j]!.msg.method === msg.method)) j++;
    if (j >= this.entries.length) return; // no captured counterpart: nothing to deliver
    const batch: CapturedEntry[] = [];
    for (let k = this.idx; k < j; k++) {
      const e = this.entries[k]!;
      if (e.dir === 'recv') batch.push(e);
      else if (e.msg.method !== undefined && e.msg.id !== undefined) this.dropped.add(e.msg.id);
    }
    const captured = this.entries[j]!.msg;
    if (captured.id !== undefined && msg.id !== undefined) this.idMap.set(captured.id, msg.id as string | number);
    let k = j + 1;
    while (k < this.entries.length && !(this.entries[k]!.dir === 'send' && this.entries[k]!.msg.method !== undefined)) {
      if (this.entries[k]!.dir === 'recv') batch.push(this.entries[k]!);
      k++;
    }
    this.idx = k;
    this.inflight++;
    setTimeout(() => {
      try {
        for (const e of batch) this.deliver(e.msg);
      } finally {
        this.inflight--;
      }
    }, 0);
  }

  private deliver(msg: CapturedEntry['msg']): void {
    if (msg.method === undefined && msg.id !== undefined) {
      if (this.dropped.has(msg.id)) return;
      const mapped = this.idMap.get(msg.id);
      if (mapped === undefined) return;
      this.proto.handleLine(JSON.stringify({ ...msg, id: mapped }));
      return;
    }
    this.proto.handleLine(JSON.stringify(msg));
  }
}

/** A CodexProtocol wired to a capture buffer, for synthetic (hand-written) lines. */
function synthetic(opts: { requestTimeoutMs?: number } = {}) {
  const written: Array<Record<string, unknown>> = [];
  const events: ProviderEvent[] = [];
  const proto = new CodexProtocol({
    write: (l) => written.push(JSON.parse(l)),
    emit: (e) => events.push(e),
    requestTimeoutMs: opts.requestTimeoutMs ?? 2_000,
    handshakeTimeoutMs: 2_000,
  });
  const feed = (o: unknown) => proto.handleLine(JSON.stringify(o));
  const lastId = () => written.at(-1)!.id as number;
  /** Open a thread "T" and (optionally) a turn "U" for messageId m1. */
  async function openThread(): Promise<void> {
    const p = proto.startThread({});
    feed({ id: lastId(), result: { thread: { id: 'T', path: '/r.jsonl' } } });
    await p;
  }
  /** Ack a turn/start; `active` also delivers codex's `turn/started` (as codex does ~25ms later). */
  async function openTurn(messageId = 'm1', turnId = 'U', active = true): Promise<void> {
    const p = proto.send(messageId, 'hi');
    feed({ id: lastId(), result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    await p;
    if (active) feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: turnId, status: 'inProgress', items: [] } } });
  }
  return { proto, written, events, feed, lastId, openThread, openTurn };
}

describe('codex mapping: captured app-server lines → ProviderEvents', () => {
  test('stub turn: turn/start response → turn.started; agentMessage → assistant.text; completed → result + usage', async () => {
    const r = Replay.load('stub-turn-completed');
    const threadId = await r.open();
    expect(r.proto.threadId).toBe(threadId);
    await r.proto.send('orc-msg-1', 'Reply with the single word: ok');
    await r.idle();
    const turnStart = r.written.find((w) => w.method === 'turn/start')!;
    expect(turnStart.params).toEqual({
      threadId,
      input: [{ type: 'text', text: 'Reply with the single word: ok', text_elements: [] }],
      clientUserMessageId: 'orc-msg-1',
    });
    expect(r.events).toEqual([
      { type: 'turn.started', messageId: 'orc-msg-1' },
      { type: 'assistant.text', messageId: 'orc-msg-1', text: 'ok' },
      {
        type: 'turn.completed',
        messageId: 'orc-msg-1',
        result: 'ok',
        usage: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
      },
    ]);
    expect(r.proto.openTurnMessageId).toBeNull();
  });

  test('handshake writes initialize then initialized (no capabilities)', async () => {
    const r = Replay.load('stub-turn-completed');
    await r.open();
    expect(r.written[0]).toEqual({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'orc', title: 'orc', version: 'test' } },
    });
    expect(r.written[1]).toEqual({ method: 'initialized' });
    expect(r.written[2]!.method).toBe('thread/start');
  });

  test('approval request → permission.requested + {decision:"decline"}; usage summed over two model calls', async () => {
    const r = Replay.load('stub-approval-decline');
    await r.open();
    await r.proto.send('m1', 'RUN: create the file');
    await r.idle();
    expect(r.types()).toEqual(['turn.started', 'permission.requested', 'assistant.text', 'turn.completed']);
    const perm = r.events[1] as Extract<ProviderEvent, { type: 'permission.requested' }>;
    expect(perm.messageId).toBe('m1');
    expect((perm.detail as { method: string }).method).toBe('item/commandExecution/requestApproval');
    expect(r.written).toContainEqual({ id: 0, result: { decision: 'decline' } });
    expect(r.events[3]).toEqual({
      type: 'turn.completed',
      messageId: 'm1',
      result: 'done',
      usage: { inputTokens: 24, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 },
    });
  });

  test('turn/completed status "interrupted" without an orc interrupt → turn.interrupted', async () => {
    const r = Replay.load('stub-approval-cancel');
    await r.open();
    await r.proto.send('m1', 'RUN: x');
    await r.idle();
    expect(r.types()).toEqual(['turn.started', 'permission.requested', 'turn.interrupted']);
  });

  test('401 run: willRetry errors are silent; turn/completed failed → turn.failed with the error text', async () => {
    const r = Replay.load('401-turn-failed');
    await r.open();
    await r.proto.send('m1', 'hello');
    await r.idle();
    expect(r.types()).toEqual(['turn.started', 'turn.failed']);
    const failed = r.events[1] as Extract<ProviderEvent, { type: 'turn.failed' }>;
    expect(failed.messageId).toBe('m1');
    expect(failed.error).toContain('401 Unauthorized');
  });

  test('interrupt → turn/interrupt {threadId, turnId}; response → interrupt.acked; then turn.interrupted', async () => {
    const r = Replay.load('401-interrupt');
    const threadId = await r.open();
    await r.proto.send('m1', 'hello');
    await r.idle();
    expect(r.types()).toEqual(['turn.started']);
    await r.proto.interrupt();
    await r.idle();
    const req = r.written.find((w) => w.method === 'turn/interrupt')!;
    expect((req.params as { threadId: string }).threadId).toBe(threadId);
    expect(typeof (req.params as { turnId: string }).turnId).toBe('string');
    expect(r.types()).toEqual(['turn.started', 'interrupt.acked', 'turn.interrupted']);
    expect(r.written.some((w) => w.method === 'turn/steer')).toBe(false);
  });

  test('turn/start error response → turn.failed (no turn.started) and the turn is closed', async () => {
    const r = Replay.load('request-errors');
    await r.open();
    await r.proto.send('m1', 'x');
    await r.idle();
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.type).toBe('turn.failed');
    expect((r.events[0] as { error: string }).error).toContain('invalid thread id');
    expect(r.proto.openTurnMessageId).toBeNull();
  });

  test('thread/resume "no rollout found" maps to CodexStartError reason no-rollout', async () => {
    const r = Replay.load('resume-no-rollout');
    await r.proto.initialize({ name: 'orc', title: 'orc', version: 'test' });
    const e = await rejectionOf(r.proto.resumeThread({ threadId: '01a13b3f-48f3-7c32-abe2-1c2d25b7e438' }));
    expect(e).toBeInstanceOf(RpcError);
    const mapped = mapCodexStartError(e, { resume: true, threadId: 'T1', stderrPath: '/x' });
    expect(mapped).toBeInstanceOf(CodexStartError);
    expect(mapped.reason).toBe('no-rollout');
    expect(mapped.message).toContain('cannot resume thread T1: no rollout found');
    const writer = mapCodexStartError(
      new RpcError('thread/resume', { code: -32600, message: 'thread T1 already has an active writer' }),
      { resume: true, threadId: 'T1', stderrPath: '/x' },
    );
    expect(writer.reason).toBe('active-writer');
  });
});

describe('codex protocol state machine (synthetic lines)', () => {
  test('send() rejects while a turn is open; interrupt() is a no-op when idle', async () => {
    const s = synthetic();
    await s.openThread();
    const before = s.written.length;
    await s.proto.interrupt();
    expect(s.written.length).toBe(before);
    await s.openTurn();
    await expect(s.proto.send('m2', 'again')).rejects.toThrow('a turn is already open');
    // and before any thread exists
    const fresh = synthetic();
    await expect(fresh.proto.send('m', 't')).rejects.toThrow('no thread');
  });

  test('final_answer phase wins over a later commentary message; empty text is not emitted', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    const item = (id: string, text: string, phase: string | null, turnId = 'U') =>
      s.feed({ method: 'item/completed', params: { threadId: 'T', turnId, item: { type: 'agentMessage', id, text, phase } } });
    item('a', 'the answer', 'final_answer');
    item('b', '', null);
    item('x', 'other turn', null, 'OTHER');
    item('c', 'trailing note', 'commentary');
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U', status: 'completed', items: [], error: null } } });
    expect(s.events.map((e) => (e.type === 'assistant.text' ? e.text : e.type))).toEqual([
      'turn.started',
      'the answer',
      'trailing note',
      'turn.completed',
    ]);
    expect(s.events.at(-1)).toEqual({ type: 'turn.completed', messageId: 'm1', result: 'the answer' });
  });

  test('events for other turn ids are ignored; result falls back to the turn summary items', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    s.feed({ method: 'item/completed', params: { threadId: 'T', turnId: 'OTHER', item: { type: 'agentMessage', id: 'a', text: 'nope', phase: null } } });
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'OTHER', status: 'completed', items: [] } } });
    expect(s.events.map((e) => e.type)).toEqual(['turn.started']);
    s.feed({
      method: 'turn/completed',
      params: { threadId: 'T', turn: { id: 'U', status: 'completed', items: [{ type: 'agentMessage', id: 'z', text: 'from summary', phase: null }] } },
    });
    expect(s.events.at(-1)).toEqual({ type: 'turn.completed', messageId: 'm1', result: 'from summary' });
  });

  test('failed turn without turn.error uses the last non-retry error notification', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    s.feed({ method: 'error', params: { threadId: 'T', turnId: 'U', willRetry: true, error: { message: 'Reconnecting... 1/5' } } });
    s.feed({ method: 'error', params: { threadId: 'T', turnId: 'U', willRetry: false, error: { message: 'final boom' } } });
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U', status: 'failed', error: null, items: [] } } });
    expect(s.events.at(-1)).toEqual({ type: 'turn.failed', messageId: 'm1', error: 'final boom' });
  });

  test('turn/completed BEFORE the turn/start response is buffered: exactly [turn.started, turn.failed]', async () => {
    const s = synthetic();
    await s.openThread();
    const sendP = s.proto.send('m1', 'hi');
    const startId = s.lastId();
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'U', status: 'inProgress', items: [] } } });
    s.feed({
      method: 'turn/completed',
      params: { threadId: 'T', turn: { id: 'U', status: 'failed', items: [], error: { message: 'early boom' } } },
    });
    expect(s.events).toEqual([]);
    s.feed({ id: startId, result: { turn: { id: 'U', status: 'inProgress', items: [] } } });
    await sendP;
    expect(s.events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
      { type: 'turn.failed', messageId: 'm1', error: 'early boom' },
    ]);
    expect(s.proto.openTurnMessageId).toBeNull();
    expect(s.written.some((w) => w.method === 'turn/interrupt')).toBe(false);
    // the runtime accepts the next turn
    await s.openTurn('m2', 'V');
    expect(s.events.at(-1)).toEqual({ type: 'turn.started', messageId: 'm2' });
  });

  test('early text, usage and completion are replayed in order after turn.started', async () => {
    const s = synthetic();
    await s.openThread();
    const sendP = s.proto.send('m1', 'hi');
    const startId = s.lastId();
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'U', status: 'inProgress', items: [] } } });
    s.feed({ method: 'item/completed', params: { threadId: 'T', turnId: 'U', item: { type: 'agentMessage', id: 'a', text: 'early answer', phase: null } } });
    s.feed({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'T',
        turnId: 'U',
        tokenUsage: {
          last: { totalTokens: 9, inputTokens: 7, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
        },
      },
    });
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U', status: 'completed', items: [], error: null } } });
    s.feed({ id: startId, result: { turn: { id: 'U', status: 'inProgress', items: [] } } });
    await sendP;
    expect(s.events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
      { type: 'assistant.text', messageId: 'm1', text: 'early answer' },
      {
        type: 'turn.completed',
        messageId: 'm1',
        result: 'early answer',
        usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 2, cacheWriteTokens: 0 },
      },
    ]);
  });

  test('an early turn/started for a different turn than the ack names is interrupted as an orphan', async () => {
    const s = synthetic();
    await s.openThread();
    const sendP = s.proto.send('m1', 'hi');
    const startId = s.lastId();
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'STRAY', status: 'inProgress', items: [] } } });
    s.feed({ id: startId, result: { turn: { id: 'U', status: 'inProgress', items: [] } } });
    await sendP;
    expect(s.written.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'T', turnId: 'STRAY' } });
    expect(s.events).toEqual([{ type: 'turn.started', messageId: 'm1' }]);
    expect(s.proto.openTurnMessageId).toBe('m1');
  });

  test('turn/start timeout after codex already started the turn → that turn is interrupted, then turn.failed', async () => {
    const s = synthetic({ requestTimeoutMs: 40 });
    await s.openThread();
    const sendP = s.proto.send('m1', 'hi');
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'LATE', status: 'inProgress', items: [] } } });
    await sendP;
    expect(s.written.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'T', turnId: 'LATE' } });
    expect(s.events).toEqual([
      { type: 'turn.failed', messageId: 'm1', error: 'codex turn/start failed: codex turn/start timed out after 40ms' },
    ]);
  });

  test('turn/start timeout → turn.failed (send resolves; the turn closes)', async () => {
    const s = synthetic({ requestTimeoutMs: 40 });
    await s.openThread();
    await s.proto.send('m1', 'hi');
    expect(s.events).toEqual([{ type: 'turn.failed', messageId: 'm1', error: 'codex turn/start failed: codex turn/start timed out after 40ms' }]);
    expect(s.proto.openTurnMessageId).toBeNull();
  });

  test('a turn orc does not own (late turn/started) is interrupted', async () => {
    const s = synthetic();
    await s.openThread();
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'ORPHAN', status: 'inProgress', items: [] } } });
    expect(s.written.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'T', turnId: 'ORPHAN' } });
    expect(s.events).toEqual([]);
  });

  test('interrupt waits for turn/started: codex acks turn/start before the turn is active', async () => {
    const s = synthetic();
    await s.openThread();
    const sendP = s.proto.send('m1', 'hi');
    const startId = s.lastId();
    const intP = s.proto.interrupt();
    expect(s.written.some((w) => w.method === 'turn/interrupt')).toBe(false);
    s.feed({ id: startId, result: { turn: { id: 'U', status: 'inProgress', items: [] } } });
    await sendP;
    await Bun.sleep(20);
    // Acked but not yet active: an interrupt now would get "no active turn" and be lost.
    expect(s.written.some((w) => w.method === 'turn/interrupt')).toBe(false);
    s.feed({ method: 'turn/started', params: { threadId: 'T', turn: { id: 'U', status: 'inProgress', items: [] } } });
    await waitUntil(() => s.written.some((w) => w.method === 'turn/interrupt'), 1_000, 'turn/interrupt');
    expect(s.proto.interrupt()).toBe(intP); // concurrent calls share one request
    s.feed({ id: s.lastId(), result: {} });
    await intP;
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U', status: 'interrupted', items: [] } } });
    expect(s.events.map((e) => e.type)).toEqual(['turn.started', 'interrupt.acked', 'turn.interrupted']);
  });

  test('"no active turn" while orc still has the turn open is retried until it lands', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    const intP = s.proto.interrupt();
    await waitUntil(() => s.written.filter((w) => w.method === 'turn/interrupt').length === 1, 1_000, 'interrupt #1');
    s.feed({ id: s.lastId(), error: { code: -32600, message: 'no active turn to interrupt' } });
    await waitUntil(() => s.written.filter((w) => w.method === 'turn/interrupt').length === 2, 1_000, 'interrupt #2');
    s.feed({ id: s.lastId(), result: {} });
    await intP;
    expect(s.events.map((e) => e.type)).toEqual(['turn.started', 'interrupt.acked']);
  });

  test('the wait for turn/started is bounded: interrupt is still sent after requestTimeoutMs', async () => {
    const s = synthetic({ requestTimeoutMs: 60 });
    await s.openThread();
    await s.openTurn('m1', 'U', false);
    const intP = s.proto.interrupt();
    await waitUntil(() => s.written.some((w) => w.method === 'turn/interrupt'), 1_000, 'turn/interrupt');
    s.feed({ id: s.lastId(), result: {} });
    await intP;
    expect(s.events.map((e) => e.type)).toEqual(['turn.started', 'interrupt.acked']);
  });

  test('turn/interrupt timeout rejects interrupt() (never hangs)', async () => {
    const s = synthetic({ requestTimeoutMs: 50 });
    await s.openThread();
    await s.openTurn();
    expect(await rejectionOf(s.proto.interrupt())).toBeInstanceOf(RpcTimeoutError);
  });

  test('"no active turn to interrupt" after the turn already completed is not an error', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    const intP = s.proto.interrupt();
    await waitUntil(() => s.written.some((w) => w.method === 'turn/interrupt'), 1_000, 'turn/interrupt');
    const id = s.lastId();
    s.feed({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U', status: 'completed', items: [] } } });
    s.feed({ id, error: { code: -32600, message: 'no active turn to interrupt' } });
    await intP;
    expect(s.events.map((e) => e.type)).toEqual(['turn.started', 'turn.completed']);
  });

  test('connection closed mid-turn: no outcome event, pending send resolves, later sends reject', async () => {
    const s = synthetic();
    await s.openThread();
    const p = s.proto.send('m1', 'hi');
    s.proto.connectionClosed(new Error('codex app-server exited (code 0)'));
    await p;
    expect(s.events).toEqual([]);
    expect(s.proto.openTurnMessageId).toBeNull();
    await expect(s.proto.send('m2', 'x')).rejects.toThrow('connection closed');
    await s.proto.interrupt(); // no-op, no throw
  });

  test('server requests: safe replies per method; unknown → -32601 with no event', async () => {
    const s = synthetic();
    await s.openThread();
    await s.openTurn();
    const req = (id: number, method: string) => s.feed({ method, id, params: { threadId: 'T', turnId: 'U' } });
    req(10, 'item/fileChange/requestApproval');
    req(11, 'item/permissions/requestApproval');
    req(12, 'item/tool/requestUserInput');
    req(13, 'mcpServer/elicitation/request');
    req(14, 'execCommandApproval');
    req(15, 'item/tool/call');
    req(16, 'account/chatgptAuthTokens/refresh');
    const replies = s.written.filter((w) => w.method === undefined);
    expect(replies).toEqual([
      { id: 10, result: { decision: 'decline' } },
      { id: 11, result: { permissions: {}, scope: 'turn' } },
      { id: 12, result: { answers: {} } },
      { id: 13, result: { action: 'decline', content: null, _meta: null } },
      { id: 14, result: { decision: { denied: { rejection: expect.stringContaining('declined') } } } },
      { id: 15, result: { contentItems: [], success: false } },
      { id: 16, error: { code: -32601, message: "orc does not handle server request 'account/chatgptAuthTokens/refresh'" } },
    ]);
    const perms = s.events.filter((e) => e.type === 'permission.requested');
    expect(perms).toHaveLength(5);
    expect(perms.every((e) => e.type === 'permission.requested' && e.messageId === 'm1')).toBe(true);
  });
});

// =====================================================================================
// 3. Real `codex app-server` contract tests (stub Responses API)
// =====================================================================================

class Collector {
  readonly events: ProviderEvent[] = [];
  readonly done: Promise<void>;
  constructor(rt: ProviderRuntime) {
    this.done = (async () => {
      for await (const e of rt.events()) this.events.push(e);
    })();
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
  async waitFor(pred: (e: ProviderEvent) => boolean, what: string, ms = 20_000): Promise<ProviderEvent> {
    let found: ProviderEvent | undefined;
    await waitUntil(
      () => (found = this.events.find(pred)) !== undefined,
      ms,
      `${what} (events so far: ${JSON.stringify(this.types())})`,
    ).catch((e) => {
      throw new Error(`${(e as Error).message}; seen ${JSON.stringify(this.events).slice(0, 2_000)}`);
    });
    return found!;
  }
  outcome(messageId: string, ms?: number): Promise<ProviderEvent> {
    return this.waitFor(
      (e) =>
        (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') &&
        e.messageId === messageId,
      `outcome of ${messageId}`,
      ms,
    );
  }
  forMessage(messageId: string): ProviderEvent[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === messageId);
  }
}

/** Non-zombie members of process group `pgid` (zombies are dead; this sandbox's init never reaps them). */
function liveGroupMembers(pgid: number): string[] {
  const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,stat=']).stdout.toString();
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && f[1] === String(pgid) && !f[2]!.startsWith('Z'))
    .map((f) => f[0]!);
}

/** Live (non-zombie) `codex app-server` processes. */
function codexAppServerPids(): string[] {
  const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,stat=,args=']).stdout.toString();
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && !f[1]!.startsWith('Z') && f.slice(2).join(' ').includes('codex app-server'))
    .map((f) => f[0]!);
}

describe.skipIf(!HAVE_CODEX)('codex app-server contract (real process, stub Responses API)', () => {
  let stub: CodexStub;
  const live: ProviderRuntime[] = [];
  const tmpDirs: string[] = [];

  beforeAll(() => {
    stub = startCodexStub();
  });
  afterEach(async () => {
    await Promise.all(live.splice(0).map((rt) => rt.close({ graceMs: 500 }).catch(() => {})));
  });
  afterAll(() => {
    stub.stop();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  interface Env {
    home: string;
    cwd: string;
    state: string;
    rawLogPath: string;
    env: Record<string, string>;
    spec: SpawnSpec;
  }

  function mkEnv(over: Partial<SpawnSpec> = {}): Env {
    const home = makeStubCodexHome(stub.port);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-cwd-')));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-state-'));
    tmpDirs.push(home, cwd, state);
    const env = { ...(process.env as Record<string, string>), CODEX_HOME: home, ORC_CODEX_BIN: CODEX_BIN! };
    const spec: SpawnSpec = {
      version: 1,
      sessionId: crypto.randomUUID(),
      provider: 'codex',
      cwd,
      env: {},
      createdAt: new Date().toISOString(),
      ...over,
    };
    return { home, cwd, state, rawLogPath: path.join(state, 'provider.jsonl'), env, spec };
  }

  async function start(e: Env, resume = false): Promise<{ rt: ProviderRuntime; c: Collector; ready: Extract<ProviderEvent, { type: 'ready' }> }> {
    const rt = await codexRuntime.start({ spec: e.spec, resume, env: e.env, rawLogPath: e.rawLogPath });
    live.push(rt);
    const c = new Collector(rt);
    const ready = (await c.waitFor((ev) => ev.type === 'ready', 'ready')) as Extract<ProviderEvent, { type: 'ready' }>;
    return { rt, c, ready };
  }

  async function closeAndCheck(rt: ProviderRuntime, c: Collector): Promise<void> {
    await rt.close({ graceMs: 2_000 });
    await c.done; // iterator ended
    expect(c.events.at(-1)!.type).toBe('exited');
    expect(c.types().filter((t) => t === 'exited')).toHaveLength(1);
    expect(liveGroupMembers(rt.pid)).toEqual([]);
    const i = live.indexOf(rt);
    if (i >= 0) live.splice(i, 1);
  }

  test(
    `pinned to codex ${CODEX_PROTOCOL_VERIFIED_VERSION}`,
    async () => {
      const e = mkEnv();
      const { rt, c, ready } = await start(e);
      expect(ready.info?.cliVersion).toBe(CODEX_PROTOCOL_VERIFIED_VERSION);
      expect(String(ready.info?.userAgent)).toContain(`/${CODEX_PROTOCOL_VERIFIED_VERSION} `);
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'fresh start → ready; two turns; transcript appears; raw log + stderr log written; close → exited, group empty',
    async () => {
      const e = mkEnv();
      const { rt, c, ready } = await start(e);
      expect(rt.provider).toBe('codex');
      expect(ready.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ready.transcriptPath!.startsWith(path.join(fs.realpathSync(e.home), 'sessions'))).toBe(true);
      expect(ready.transcriptPath).toContain(ready.providerSessionId);
      expect(ready.info).toMatchObject({
        mode: 'fresh',
        codexHome: fs.realpathSync(e.home),
        approvalPolicy: 'never',
        sandbox: 'dangerFullAccess',
        cwd: e.cwd,
        model: 'gpt-fake',
      });

      await rt.send('m1', 'Reply with exactly one word: PONG');
      const o1 = await c.outcome('m1');
      expect(c.forMessage('m1')).toEqual([
        { type: 'turn.started', messageId: 'm1' },
        { type: 'assistant.text', messageId: 'm1', text: 'PONG' },
        {
          type: 'turn.completed',
          messageId: 'm1',
          result: 'PONG',
          usage: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
        },
      ]);
      expect(o1.type).toBe('turn.completed');
      expect(fs.existsSync(ready.transcriptPath!)).toBe(true);

      await rt.send('m2', 'Reply with exactly one word: SECOND');
      const o2 = await c.outcome('m2');
      expect(o2).toMatchObject({ type: 'turn.completed', result: 'SECOND' });
      expect(c.forMessage('m2').map((x) => x.type)).toEqual(['turn.started', 'assistant.text', 'turn.completed']);

      await closeAndCheck(rt, c);
      const raw = fs.readFileSync(e.rawLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(raw.some((r) => r.dir === 'send' && JSON.parse(r.line).method === 'turn/start')).toBe(true);
      expect(raw.some((r) => r.dir === 'recv' && JSON.parse(r.line).method === 'turn/completed')).toBe(true);
      expect(raw.every((r) => ['send', 'recv', 'info'].includes(r.dir) && typeof r.ts === 'string')).toBe(true);
      expect(fs.existsSync(codexStderrLogPath(e.rawLogPath))).toBe(true);
      expect(fs.statSync(e.rawLogPath).mode & 0o777).toBe(0o600);
    },
    60_000,
  );

  test(
    'multi-line prompt with quotes and unicode round-trips exactly',
    async () => {
      const e = mkEnv();
      const { rt, c } = await start(e);
      const prompt = 'line one\n  "double" and \'single\' quotes\n\ttab, backslash \\ and $HOME `cmd`\nunicode: ✓ 日本語 🚀 — é\n\nlast line';
      const before = stub.requests.length;
      await rt.send('m1', prompt);
      await c.outcome('m1');
      const seen = stub.requests.slice(before).map((r) => r.prompt);
      expect(seen).toEqual([prompt]);
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'systemPrompt append → developerInstructions reaches the model request',
    async () => {
      const e = mkEnv();
      const promptFile = path.join(e.state, 'system-prompt.md');
      const persona = 'ORC-PERSONA-APPEND\nYou are a careful reviewer.\n"quotes" ✓';
      fs.writeFileSync(promptFile, persona);
      e.spec.systemPrompt = { mode: 'append', path: promptFile };
      const { rt, c } = await start(e);
      const before = stub.requests.length;
      await rt.send('m1', 'hello');
      await c.outcome('m1');
      const req = stub.requests[before]!;
      expect(req.developerTexts).toContain(persona);
      expect(req.developerTexts[0]).not.toBe(persona); // built-in base prompt still first
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'systemPrompt replace → baseInstructions replaces the built-in base prompt',
    async () => {
      const e = mkEnv();
      const promptFile = path.join(e.state, 'system-prompt.md');
      const base = 'ORC-BASE-REPLACE: you are a minimal test agent.';
      fs.writeFileSync(promptFile, base);
      e.spec.systemPrompt = { mode: 'replace', path: promptFile };
      const { rt, c } = await start(e);
      const before = stub.requests.length;
      await rt.send('m1', 'hello');
      await c.outcome('m1');
      const req = stub.requests[before]!;
      expect(req.developerTexts[0]).toBe(base);
      expect(req.developerTexts.some((t) => t.includes('You are a coding agent running in the Codex CLI'))).toBe(false);
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'spec.model is passed to thread/start',
    async () => {
      const e = mkEnv({ model: 'gpt-fake-override' });
      const { rt, c, ready } = await start(e);
      expect(ready.info?.model).toBe('gpt-fake-override');
      const before = stub.requests.length;
      await rt.send('m1', 'hello');
      await c.outcome('m1');
      expect(stub.requests[before]!.body.model).toBe('gpt-fake-override');
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'interrupt during a slow response → interrupt.acked + turn.interrupted; send() refused while open; next turn works',
    async () => {
      const e = mkEnv();
      const { rt, c } = await start(e);
      await rt.interrupt(); // idle → no-op
      await rt.send('m1', 'STUB:SLOW please');
      await c.waitFor((x) => x.type === 'turn.started' && x.messageId === 'm1', 'turn.started m1');
      await expect(rt.send('m-dup', 'nope')).rejects.toThrow('a turn is already open');
      await rt.interrupt();
      const o = await c.outcome('m1');
      expect(o.type).toBe('turn.interrupted');
      expect(c.types()).toEqual(['ready', 'turn.started', 'interrupt.acked', 'turn.interrupted']);
      await rt.send('m2', 'Reply with exactly one word: AFTER');
      expect(await c.outcome('m2')).toMatchObject({ type: 'turn.completed', result: 'AFTER' });
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'model error → turn.failed with the provider error text; the connection stays usable',
    async () => {
      const e = mkEnv();
      const { rt, c } = await start(e);
      await rt.send('m1', 'STUB:FAIL');
      const o = await c.outcome('m1');
      expect(o.type).toBe('turn.failed');
      expect((o as { error: string }).error).toContain('stub-forced failure');
      expect(c.forMessage('m1').map((x) => x.type)).toEqual(['turn.started', 'turn.failed']);
      await rt.send('m2', 'hello');
      expect(await c.outcome('m2')).toMatchObject({ type: 'turn.completed', result: 'ok' });
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'several agentMessage items → one assistant.text each; result is the last',
    async () => {
      const e = mkEnv();
      const { rt, c } = await start(e);
      await rt.send('m1', 'STUB:MULTI');
      const o = await c.outcome('m1');
      expect(c.forMessage('m1').filter((x) => x.type === 'assistant.text').map((x) => (x as { text: string }).text)).toEqual([
        'first part',
        'final part',
      ]);
      expect(o).toMatchObject({ type: 'turn.completed', result: 'final part' });
      await closeAndCheck(rt, c);
    },
    60_000,
  );

  test(
    'resume after a turn → same thread id + transcript; history continues',
    async () => {
      const e = mkEnv();
      const a = await start(e);
      await a.rt.send('m1', 'Reply with exactly one word: REMEMBERME');
      expect(await a.c.outcome('m1')).toMatchObject({ type: 'turn.completed', result: 'REMEMBERME' });
      await closeAndCheck(a.rt, a.c);

      e.spec.providerSessionId = a.ready.providerSessionId;
      const b = await start(e, true);
      expect(b.ready.providerSessionId).toBe(a.ready.providerSessionId);
      expect(b.ready.transcriptPath).toBe(a.ready.transcriptPath);
      expect(b.ready.info).toMatchObject({ mode: 'resume', approvalPolicy: 'never', sandbox: 'dangerFullAccess' });
      const before = stub.requests.length;
      await b.rt.send('m2', 'STUB:RECALL what did you say first?');
      expect(await b.c.outcome('m2')).toMatchObject({ type: 'turn.completed', result: 'REMEMBERME' });
      const req = stub.requests[before]!;
      expect(req.userHistory.some((t) => t.includes('Reply with exactly one word: REMEMBERME'))).toBe(true);
      await closeAndCheck(b.rt, b.c);
    },
    90_000,
  );

  test(
    'resume before any turn → start() rejects with a clear no-rollout error and leaves no process',
    async () => {
      const e = mkEnv();
      const a = await start(e);
      await closeAndCheck(a.rt, a.c);
      e.spec.providerSessionId = a.ready.providerSessionId;
      const pidsBefore = codexAppServerPids();
      const err = await rejectionOf(
        codexRuntime.start({ spec: e.spec, resume: true, env: e.env, rawLogPath: e.rawLogPath }),
        );
      expect(err).toBeInstanceOf(CodexStartError);
      expect(err.reason).toBe('no-rollout');
      expect(err.message).toContain(`cannot resume thread ${a.ready.providerSessionId}: no rollout found`);
      // The failed start still logged its protocol lines, and left no app-server behind.
      expect(fs.readFileSync(e.rawLogPath, 'utf8')).toContain('no rollout found');
      expect(codexAppServerPids().filter((p) => !pidsBefore.includes(p))).toEqual([]);
    },
    60_000,
  );

  test(
    'close() mid-turn → exited with no outcome; the thread resumes and runs a new turn',
    async () => {
      const e = mkEnv();
      const a = await start(e);
      await a.rt.send('m1', 'Reply with exactly one word: FIRST');
      await a.c.outcome('m1');
      await a.rt.send('m2', 'STUB:SLOW');
      await a.c.waitFor((x) => x.type === 'turn.started' && x.messageId === 'm2', 'turn.started m2');
      await closeAndCheck(a.rt, a.c);
      expect(a.c.forMessage('m2').map((x) => x.type)).toEqual(['turn.started']);

      e.spec.providerSessionId = a.ready.providerSessionId;
      const b = await start(e, true);
      await b.rt.send('m3', 'Reply with exactly one word: RESUMED');
      expect(await b.c.outcome('m3')).toMatchObject({ type: 'turn.completed', result: 'RESUMED' });
      await closeAndCheck(b.rt, b.c);
    },
    90_000,
  );

  test(
    'unreadable system prompt or bad binary → start() rejects without spawning a lingering process',
    async () => {
      const e = mkEnv();
      e.spec.systemPrompt = { mode: 'append', path: path.join(e.state, 'missing.md') };
      const err1 = await rejectionOf(codexRuntime.start({ spec: e.spec, resume: false, env: e.env, rawLogPath: e.rawLogPath }));
      expect(err1).toBeInstanceOf(CodexStartError);
      expect(err1.reason).toBe('config');
      const e2 = mkEnv();
      const err2 = await rejectionOf(
        codexRuntime.start({ spec: e2.spec, resume: false, env: { ...e2.env, ORC_CODEX_BIN: path.join(e2.state, 'no-such-codex') }, rawLogPath: e2.rawLogPath }),
        );
      expect(err2).toBeInstanceOf(CodexStartError);
      expect(err2.reason).toBe('spawn');
      expect(err2.message).toContain('ORC_CODEX_BIN');
    },
    30_000,
  );
});

if (!HAVE_CODEX) {
  const why = `codex contract tests SKIPPED: no codex binary (${CODEX_BIN ?? 'none on PATH'}); set ORC_TEST_CODEX_BIN to a codex ${CODEX_PROTOCOL_VERIFIED_VERSION} binary`;
  console.warn(`[runtime-codex] ${why}`);
  test.skip(why, () => {});
}
