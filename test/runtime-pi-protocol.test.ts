/**
 * Pure tests of the pi rpc mapper (src/runtime/providers/pi-protocol.ts) against protocol
 * lines recorded from pi 1.2.0 (test/fixtures/pi-rpc/*.jsonl, captured by the S4 probe
 * against a local mock model; system-prompt echoes trimmed) plus synthetic edge cases.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  JsonlSplitter,
  PI_INTERNAL_ID_PREFIX,
  PiTurnMapper,
  buildPiArgs,
  encodePiCommand,
  parsePiLine,
  type PiRecord,
} from '../src/runtime/providers/pi-protocol.ts';
import type { ProviderEvent, SpawnSpec } from '../src/runtime/types.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'pi-rpc');

interface Replay {
  events: ProviderEvent[];
  writes: PiRecord[];
  mapper: PiTurnMapper;
}

/**
 * Replay a recorded session through a fresh mapper: `send` prompt/abort lines drive
 * beginTurn/requestInterrupt, `recv` lines are fed verbatim (the recorded abort response id
 * is rewritten to the id the mapper generated), `info close-stdin` → process exit.
 */
function replay(name: string): Replay {
  const m = new PiTurnMapper();
  const events: ProviderEvent[] = [];
  const writes: PiRecord[] = [];
  const idMap = new Map<string, string>();
  const lines = fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const { dir, line } = JSON.parse(l) as { dir: string; line: string };
    if (dir === 'info') {
      if (line === 'close-stdin') events.push(...m.finishOnExit());
      continue;
    }
    const rec = JSON.parse(line) as PiRecord;
    if (dir === 'send') {
      if (rec.type === 'prompt') {
        const cmd = m.beginTurn(rec.id as string, rec.message as string);
        expect(cmd).toEqual({ id: rec.id, type: 'prompt', message: rec.message });
      } else if (rec.type === 'abort') {
        const r = m.requestInterrupt();
        events.push(...r.events);
        writes.push(...r.writes);
        const ours = r.writes.find((w) => w.type === 'abort');
        if (ours) idMap.set(rec.id as string, ours.id as string);
      }
      continue;
    }
    if (rec.type === 'response' && typeof rec.id === 'string' && idMap.has(rec.id)) {
      rec.id = idMap.get(rec.id);
    }
    const r = m.handleRecord(rec);
    events.push(...r.events);
    writes.push(...r.writes);
  }
  return { events, writes, mapper: m };
}

const types = (evs: ProviderEvent[]) => evs.map((e) => e.type);

/** Synthetic records. */
const ack = (id: string, disposition = 'started'): PiRecord => ({
  id,
  type: 'response',
  command: 'prompt',
  success: true,
  data: { disposition },
});
const assistantEnd = (
  content: unknown[],
  stopReason = 'stop',
  extra: Record<string, unknown> = {},
): PiRecord => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content,
    stopReason,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
    ...extra,
  },
});
const settled = (aborted = false): PiRecord => ({ type: 'agent_settled', aborted });

function feed(m: PiTurnMapper, recs: PiRecord[]): { events: ProviderEvent[]; writes: PiRecord[] } {
  const events: ProviderEvent[] = [];
  const writes: PiRecord[] = [];
  for (const r of recs) {
    const out = m.handleRecord(r);
    events.push(...out.events);
    writes.push(...out.writes);
  }
  return { events, writes };
}

describe('pi mapper: recorded pi 1.2.0 sessions', () => {
  test('normal turn → turn.started, assistant.text, turn.completed with result + usage', () => {
    const { events, writes, mapper } = replay('mock-normal');
    expect(events).toEqual([
      { type: 'turn.started', messageId: 'p1' },
      { type: 'assistant.text', messageId: 'p1', text: 'ok' },
      {
        type: 'turn.completed',
        messageId: 'p1',
        result: 'ok',
        usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
      },
    ]);
    expect(writes).toEqual([]);
    expect(mapper.openMessageId).toBeNull();
  });

  test('two sequential turns each get exactly one outcome', () => {
    const { events } = replay('two-turns');
    expect(events.map((e) => `${e.type}:${'messageId' in e ? e.messageId : ''}`)).toEqual([
      'turn.started:msg-1',
      'assistant.text:msg-1',
      'turn.completed:msg-1',
      'turn.started:msg-2',
      'assistant.text:msg-2',
      'turn.completed:msg-2',
    ]);
  });

  test('abort mid-stream → partial text, turn.interrupted, then interrupt.acked', () => {
    const { events, writes } = replay('mock-abort');
    expect(writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'abort' }]);
    expect(events).toEqual([
      { type: 'turn.started', messageId: 'p1' },
      { type: 'assistant.text', messageId: 'p1', text: 'slow ' },
      { type: 'turn.interrupted', messageId: 'p1' },
      { type: 'interrupt.acked' },
    ]);
  });

  test('provider HTTP 400 → turn.failed with the provider error text', () => {
    const { events } = replay('mock-error');
    expect(types(events)).toEqual(['turn.started', 'turn.failed']);
    const failed = events[1] as Extract<ProviderEvent, { type: 'turn.failed' }>;
    expect(failed.messageId).toBe('p1');
    expect(failed.error).toContain('mock upstream rejected request');
  });

  test('auto-retry cycles are not outcomes; exhausted retries → one turn.failed(finalError)', () => {
    const { events } = replay('mock-retry');
    expect(types(events)).toEqual(['turn.started', 'turn.failed']);
    const failed = events[1] as Extract<ProviderEvent, { type: 'turn.failed' }>;
    expect(failed.error).toBe('503: {"message":"mock overloaded","type":"overloaded_error"}');
  });

  test('rejected prompt (no API key) → turn.failed without turn.started', () => {
    const { events, mapper } = replay('unauth');
    expect(types(events)).toEqual(['turn.failed']);
    expect((events[0] as { error: string }).error).toStartWith('No API key found for the selected model.');
    expect(mapper.openMessageId).toBeNull();
  });

  test('stdin closed mid-run (pi emits nothing more) → exit closes the turn as interrupted', () => {
    const { events, mapper } = replay('mock-stdinclose');
    expect(events).toEqual([
      { type: 'turn.started', messageId: 'p1' },
      { type: 'turn.interrupted', messageId: 'p1' },
    ]);
    expect(mapper.openMessageId).toBeNull();
  });
});

describe('pi mapper: synthetic edge cases', () => {
  test('handled disposition → started + completed (no run follows)', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', '/ext-cmd');
    expect(feed(m, [ack('m1', 'handled')]).events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
      { type: 'turn.completed', messageId: 'm1' },
    ]);
    expect(m.openMessageId).toBeNull();
  });

  test('queued disposition is a protocol bug → turn.failed', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    const { events } = feed(m, [ack('m1', 'queued')]);
    expect(types(events)).toEqual(['turn.failed']);
    expect(m.openMessageId).toBeNull();
  });

  test('stopReason "length" → turn.completed with the truncated text', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    const { events } = feed(m, [ack('m1'), assistantEnd([{ type: 'text', text: 'partial' }], 'length'), settled()]);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', messageId: 'm1', result: 'partial' });
  });

  test('tool loop: text per block, usage/cost summed, result = last assistant message', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    const { events } = feed(m, [
      ack('m1'),
      { type: 'message_end', message: { role: 'system', content: '', sections: { preamble: 'p' } } },
      assistantEnd(
        [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Let me look.' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: {} },
        ],
        'toolUse',
      ),
      { type: 'turn_end' },
      { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] } },
      assistantEnd([
        { type: 'text', text: 'Done: ' },
        { type: 'text', text: 'all good.' },
        { type: 'text', text: '  ' },
      ]),
      { type: 'agent_end', messages: [], willRetry: false },
      settled(),
    ]);
    expect(events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
      { type: 'assistant.text', messageId: 'm1', text: 'Let me look.' },
      { type: 'assistant.text', messageId: 'm1', text: 'Done: ' },
      { type: 'assistant.text', messageId: 'm1', text: 'all good.' },
      {
        type: 'turn.completed',
        messageId: 'm1',
        result: 'Done: all good.  ',
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 },
        costUsd: 0.5,
      },
    ]);
  });

  test('successful auto-retry clears the remembered error', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    const { events } = feed(m, [
      ack('m1'),
      assistantEnd([], 'error', { errorMessage: '503' }),
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1 },
      { type: 'auto_retry_end', success: false, finalError: 'stale' },
      { type: 'auto_retry_end', success: true, attempt: 2 },
      assistantEnd([{ type: 'text', text: 'recovered' }]),
      settled(),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', result: 'recovered' });
  });

  test('error after a requested interrupt → turn.interrupted (not failed)', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    feed(m, [ack('m1')]);
    expect(m.requestInterrupt().writes).toHaveLength(1);
    const { events } = feed(m, [assistantEnd([], 'error', { errorMessage: 'Request was aborted' }), settled(false)]);
    expect(events).toEqual([{ type: 'turn.interrupted', messageId: 'm1' }]);
  });

  test('interrupt before the prompt ack is deferred until the run exists', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    expect(m.requestInterrupt()).toEqual({ events: [], writes: [] });
    // A second request while one is pending is a no-op.
    expect(m.requestInterrupt()).toEqual({ events: [], writes: [] });
    const r = feed(m, [ack('m1')]);
    expect(r.events).toEqual([{ type: 'turn.started', messageId: 'm1' }]);
    expect(r.writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'abort' }]);
    const end = feed(m, [
      assistantEnd([], 'aborted'),
      settled(true),
      { id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'response', command: 'abort', success: true },
    ]);
    expect(end.events).toEqual([{ type: 'turn.interrupted', messageId: 'm1' }, { type: 'interrupt.acked' }]);
  });

  test('deferred interrupt + rejected prompt → turn.failed then interrupt.acked (nothing to abort)', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    m.requestInterrupt();
    const { events, writes } = feed(m, [
      { id: 'm1', type: 'response', command: 'prompt', success: false, error: 'No model selected.' },
    ]);
    expect(writes).toEqual([]);
    expect(events).toEqual([
      { type: 'turn.failed', messageId: 'm1', error: 'No model selected.' },
      { type: 'interrupt.acked' },
    ]);
  });

  test('repeat interrupt re-sends abort only after the previous one went unanswered for reabortAfterMs', () => {
    const m = new PiTurnMapper({ reabortAfterMs: 3_000 });
    m.beginTurn('m1', 'x');
    feed(m, [ack('m1')]);
    expect(m.requestInterrupt(1_000).writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'abort' }]);
    expect(m.requestInterrupt(2_000)).toEqual({ events: [], writes: [] });
    expect(m.requestInterrupt(3_999)).toEqual({ events: [], writes: [] });
    expect(m.requestInterrupt(4_000).writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:2`, type: 'abort' }]);
    expect(m.openTurnAbortIds()).toEqual([`${PI_INTERNAL_ID_PREFIX}abort:1`, `${PI_INTERNAL_ID_PREFIX}abort:2`]);
    // The window restarts from the latest abort.
    expect(m.requestInterrupt(6_000)).toEqual({ events: [], writes: [] });
    // Each abort written is acked once; the turn ends once.
    const { events } = feed(m, [
      assistantEnd([], 'aborted'),
      settled(true),
      { id: `${PI_INTERNAL_ID_PREFIX}abort:2`, type: 'response', command: 'abort', success: true },
      { id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'response', command: 'abort', success: true },
    ]);
    expect(events).toEqual([
      { type: 'turn.interrupted', messageId: 'm1' },
      { type: 'interrupt.acked' },
      { type: 'interrupt.acked' },
    ]);
    expect(m.isAbortPending(`${PI_INTERNAL_ID_PREFIX}abort:1`)).toBe(false);
  });

  test('an answered abort with the turn still open allows an immediate re-abort', () => {
    const m = new PiTurnMapper({ reabortAfterMs: 3_000 });
    m.beginTurn('m1', 'x');
    feed(m, [ack('m1')]);
    m.requestInterrupt(1_000);
    const r = feed(m, [{ id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'response', command: 'abort', success: true }]);
    expect(r.events).toEqual([{ type: 'interrupt.acked' }]);
    expect(m.openMessageId).toBe('m1');
    expect(m.requestInterrupt(1_100).writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:2`, type: 'abort' }]);
  });

  test('a deferred interrupt is not re-sent before the ack, however long it waits', () => {
    const m = new PiTurnMapper({ reabortAfterMs: 10 });
    m.beginTurn('m1', 'x');
    m.requestInterrupt(0);
    expect(m.requestInterrupt(10_000)).toEqual({ events: [], writes: [] });
    expect(m.handleRecord(ack('m1'), 10_001).writes).toEqual([{ id: `${PI_INTERNAL_ID_PREFIX}abort:1`, type: 'abort' }]);
    expect(m.requestInterrupt(10_005)).toEqual({ events: [], writes: [] });
    expect(m.requestInterrupt(10_011).writes).toHaveLength(1);
  });

  test('interrupt with no open turn is a no-op', () => {
    const m = new PiTurnMapper();
    expect(m.requestInterrupt()).toEqual({ events: [], writes: [] });
    expect(m.finishOnExit()).toEqual([]);
  });

  test('extension UI dialog → permission.requested + immediate cancel; fire-and-forget ignored', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    feed(m, [ack('m1')]);
    const req = { type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?', message: 'rm -rf' };
    expect(feed(m, [req])).toEqual({
      events: [{ type: 'permission.requested', messageId: 'm1', detail: req }],
      writes: [{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }],
    });
    expect(feed(m, [{ type: 'extension_ui_request', id: 'ui-2', method: 'notify', message: 'hi' }])).toEqual({
      events: [],
      writes: [],
    });
    // With no open turn the event carries no messageId key at all.
    const idle = new PiTurnMapper();
    const lone = { type: 'extension_ui_request', id: 'ui-9', method: 'select', options: ['a'] };
    const ev = feed(idle, [lone]).events[0] as Record<string, unknown>;
    expect(ev).toEqual({ type: 'permission.requested', detail: lone });
    expect('messageId' in ev).toBe(false);
    // Unknown methods might block: treated as dialogs.
    expect(feed(m, [{ type: 'extension_ui_request', id: 'ui-3', method: 'pickColor' }]).writes).toEqual([
      { type: 'extension_ui_response', id: 'ui-3', cancelled: true },
    ]);
  });

  test('unrelated responses, stray settles and non-JSON lines are ignored', () => {
    const m = new PiTurnMapper();
    expect(feed(m, [settled(), ack('nope')])).toEqual({ events: [], writes: [] });
    m.beginTurn('m1', 'x');
    expect(feed(m, [ack('other'), { id: 'g1', type: 'response', command: 'get_state', success: true }]).events).toEqual(
      [],
    );
    expect(m.handleLine('not json at all')).toEqual({ events: [], writes: [] });
    expect(m.handleLine('')).toEqual({ events: [], writes: [] });
    expect(m.nonJsonLines).toBe(1);
    // A duplicate ack does not re-open or re-start the turn.
    expect(m.handleLine(JSON.stringify(ack('m1'))).events).toEqual([{ type: 'turn.started', messageId: 'm1' }]);
    expect(m.handleLine(JSON.stringify(ack('m1'))).events).toEqual([]);
    // Assistant text with no open turn is dropped.
    const fresh = new PiTurnMapper();
    expect(feed(fresh, [assistantEnd([{ type: 'text', text: 'x' }])]).events).toEqual([]);
  });

  test('beginTurn guards: one open turn, valid ids', () => {
    const m = new PiTurnMapper();
    m.beginTurn('m1', 'x');
    expect(() => m.beginTurn('m2', 'y')).toThrow(/still open/);
    const n = new PiTurnMapper();
    expect(() => n.beginTurn('', 'y')).toThrow();
    expect(() => n.beginTurn(`${PI_INTERNAL_ID_PREFIX}x`, 'y')).toThrow();
  });
});

describe('pi framing + argv', () => {
  test('JsonlSplitter splits on LF only, strips CR, keeps partial lines', () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}\r\n{"b":')).toEqual(['{"a":1}']);
    expect(s.push('"x\u2028y\u2029z"}\n')).toEqual(['{"b":"x\u2028y\u2029z"}']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toBe('tail');
    expect(parsePiLine('{"b":"x\u2028y"}\r')).toEqual({ b: 'x\u2028y' });
    expect(parsePiLine('[1,2]')).toBeNull();
  });

  test('encodePiCommand is one line and round-trips newlines, quotes, unicode, separators', () => {
    const text = 'line 1\nline "2"\r\n\ttab \\ back\u2028sep\u2029para café ✓ 🚀';
    const line = encodePiCommand({ id: 'm', type: 'prompt', message: text });
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\u2028');
    expect(line).not.toContain('\u2029');
    expect((JSON.parse(line) as { message: string }).message).toBe(text);
  });

  const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
    version: 1,
    sessionId: '4a1f0c2e-7b3d-4e5f-9a60-1234abcd0001',
    provider: 'pi',
    cwd: '/w',
    env: {},
    createdAt: '2026-10-14T00:00:00.000Z',
    ...over,
  });

  test('buildPiArgs: rpc mode, -a, model, prompt FILE path, session id + dir; resume identical', () => {
    const s = spec({
      model: 'anthropic/claude-x',
      systemPrompt: { mode: 'append', path: '/o/prompt.md' },
      sessionDir: '/o/pi-sessions',
      providerSessionId: '4a1f0c2e-7b3d-4e5f-9a60-1234abcd0001',
    });
    const fresh = buildPiArgs(s, false);
    expect(fresh).toEqual([
      '--mode',
      'rpc',
      '-a',
      '--model',
      'anthropic/claude-x',
      '--append-system-prompt',
      '/o/prompt.md',
      '--session-id',
      '4a1f0c2e-7b3d-4e5f-9a60-1234abcd0001',
      '--session-dir',
      '/o/pi-sessions',
    ]);
    expect(buildPiArgs(s, true)).toEqual(fresh);
    expect(fresh).not.toContain('-nc');
    expect(fresh).not.toContain('--no-mcp');
  });

  test('buildPiArgs: replace mode, no model, no session dir, resume uses providerSessionId', () => {
    const s = spec({ systemPrompt: { mode: 'replace', path: '/o/p.md' }, providerSessionId: 'prov-1' });
    expect(buildPiArgs(s, false)).toEqual([
      '--mode',
      'rpc',
      '-a',
      '--system-prompt',
      '/o/p.md',
      '--session-id',
      '4a1f0c2e-7b3d-4e5f-9a60-1234abcd0001',
    ]);
    expect(buildPiArgs(s, true).slice(-2)).toEqual(['--session-id', 'prov-1']);
  });
});
