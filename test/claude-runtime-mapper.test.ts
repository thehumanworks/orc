/**
 * Offline unit tests for the claude runtime's pure parts: the stdout line → ProviderEvent
 * mapper (replayed over REDACTED captures of claude 2.1.299 in
 * test/fixtures/claude-stream/), argv construction and env stripping.
 *
 * Fixture format: one JSON object per line `{t, dir: 'in'|'out'|'err', line}` — `in` is
 * what the probe wrote to claude's stdin (`<EOF>` = stdin closed), `out` is claude stdout.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildClaudeArgv,
  buildClaudeEnv,
  CLAUDE_PERMISSION_DENY_MESSAGE,
  ClaudeStreamMapper,
  redactClaudeLine,
} from '../src/runtime/providers/claude.ts';
import { parseClaudeLine } from '../src/runtime/providers/claude-protocol.ts';
import type { ProviderEvent, SpawnSpec } from '../src/runtime/types.ts';

const FIX = path.join(import.meta.dir, 'fixtures', 'claude-stream');

interface Rec {
  t: number;
  dir: 'in' | 'out' | 'err';
  line: string;
}

function load(name: string): Rec[] {
  return fs
    .readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Rec);
}

/** Drive a mapper exactly as the runtime would: `in` lines → bookkeeping, `out` → map. */
function replay(name: string, opts: { resume?: boolean } = {}) {
  const mapper = new ClaudeStreamMapper({ providerSessionId: 'sid-under-test', resume: opts.resume ?? false });
  const events: ProviderEvent[] = [];
  const replies: Record<string, unknown>[] = [];
  const fatals: string[] = [];
  const sent: string[] = [];
  let anon = 0;
  for (const rec of load(name)) {
    if (rec.dir === 'in') {
      if (rec.line === '<EOF>') continue;
      const o = JSON.parse(rec.line) as { type: string; uuid?: string; request_id?: string; request?: { subtype: string } };
      if (o.type === 'user') {
        // The probe sometimes omitted uuid; orc never does, but the mapper must cope.
        const id = o.uuid ?? `anon-${++anon}`;
        mapper.beginTurn(id);
        sent.push(id);
      } else if (o.type === 'control_request' && o.request_id && o.request) {
        mapper.noteControlRequest(o.request_id, o.request.subtype);
      }
      continue;
    }
    if (rec.dir !== 'out') continue;
    const r = mapper.handleLine(rec.line);
    events.push(...r.events);
    replies.push(...r.replies);
    if (r.fatal) fatals.push(r.fatal);
  }
  return { mapper, events, replies, fatals, sent };
}

const OUTCOMES = new Set(['turn.completed', 'turn.failed', 'turn.interrupted']);
type Outcome = Extract<ProviderEvent, { type: 'turn.completed' | 'turn.failed' | 'turn.interrupted' }>;

function outcomesFor(events: ProviderEvent[], id: string): Outcome[] {
  return events.filter((e): e is Outcome => OUTCOMES.has(e.type) && (e as Outcome).messageId === id);
}

/** Per sent turn: exactly one turn.started, exactly one outcome, started before outcome. */
function expectWellFormedTurns(events: ProviderEvent[], sent: string[]): void {
  for (const id of sent) {
    const startedIdx = events.findIndex((e) => e.type === 'turn.started' && e.messageId === id);
    const outs = outcomesFor(events, id);
    expect(events.filter((e) => e.type === 'turn.started' && e.messageId === id).length).toBe(1);
    expect(outs.length).toBe(1);
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(startedIdx).toBeLessThan(events.indexOf(outs[0] as ProviderEvent));
  }
}

describe('ClaudeStreamMapper over captured claude 2.1.299 output', () => {
  test('normal turns: ack from command_lifecycle, text, completed with usage + per-turn cost', () => {
    const { events, sent, mapper } = replay('normal-turns');
    expect(sent.length).toBe(3);
    expectWellFormedTurns(events, sent);
    const [m1, m2, m3] = sent as [string, string, string];
    // Turn 1 (uuid sent): ack comes from command_lifecycle{started} — the FIRST event.
    expect(events[0]).toEqual({ type: 'turn.started', messageId: m1 });
    expect(events[1]).toEqual({ type: 'assistant.text', messageId: m1, text: 'ok' });
    const c1 = outcomesFor(events, m1)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    expect(c1.type).toBe('turn.completed');
    expect(c1.result).toBe('ok');
    expect(c1.usage?.outputTokens).toBeGreaterThan(0);
    expect(c1.usage?.cacheWriteTokens).toBeGreaterThan(0);
    // Fresh process: first result's cumulative total IS the turn cost.
    expect(c1.costUsd).toBeCloseTo(0.0041304, 10);
    // Turn 2 was sent WITHOUT a uuid (no lifecycle, echo has a CLI uuid): still exactly one
    // started + one outcome, correlated to the open turn.
    const c2 = outcomesFor(events, m2)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    expect(c2.type).toBe('turn.completed');
    expect(c2.costUsd).toBeCloseTo(0.00516324 - 0.0041304, 10);
    // Turn 3 used string content (not blocks).
    const c3 = outcomesFor(events, m3)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    expect(c3.costUsd).toBeCloseTo(0.00538519 - 0.00516324, 10);
    // No ready (the probe never sent initialize); no stray event types.
    expect(events.some((e) => e.type === 'ready')).toBe(false);
    expect(mapper.openMessageId).toBeUndefined();
    // initInfo from the first per-turn system/init (brief §9).
    const info = mapper.initInfo;
    expect(info?.capabilities).toContain('interrupt_receipt_v1');
    expect(info?.skillsCount).toBeGreaterThan(0);
    expect(info?.agents).toContain('general-purpose');
    expect(info?.apiKeySource).toBe('none');
    expect(info?.model).toBe('claude-haiku-5-5');
    expect(info?.claudeCodeVersion).toBe('2.1.299');
  });

  test('resumed process: first result cost is undefined, later ones are deltas', () => {
    const { events, sent } = replay('normal-turns', { resume: true });
    const [m1, m2] = sent as [string, string];
    const c1 = outcomesFor(events, m1)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    const c2 = outcomesFor(events, m2)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    expect(c1.type).toBe('turn.completed');
    expect('costUsd' in c1).toBe(false);
    expect(c2.costUsd).toBeCloseTo(0.00516324 - 0.0041304, 10);
  });

  test('initialize → ready (providerSessionId, info, initialize capabilities)', () => {
    const { events, sent, mapper } = replay('initialize-first');
    const ready = events[0] as Extract<ProviderEvent, { type: 'ready' }>;
    expect(ready.type).toBe('ready');
    expect(ready.providerSessionId).toBe('sid-under-test');
    expect(ready.capabilities).toEqual(['ui_surface_v1']);
    expect(ready.info?.claude_code_version).toBe('2.1.299');
    expect(ready.info?.session_state).toBe('idle');
    expect(ready.info?.current_permission_mode).toBe('bypassPermissions');
    expect(typeof ready.info?.pid).toBe('number');
    expect(ready.info).not.toHaveProperty('account');
    expect(mapper.isReady).toBe(true);
    expectWellFormedTurns(events, sent);
    expect(events.filter((e) => e.type === 'ready').length).toBe(1);
  });

  test('interrupt matrix: mid-turn → interrupted; idle → ack only; race → completes', () => {
    const { events, sent } = replay('interrupt-matrix');
    expect(sent.length).toBe(3);
    expectWellFormedTurns(events, sent);
    const [mLong, mRace, mAfter] = sent as [string, string, string];

    // Mid-turn interrupt: ack, then the interrupted outcome; no text, no completed/failed.
    expect(outcomesFor(events, mLong).map((e) => e.type)).toEqual(['turn.interrupted']);
    expect(events.some((e) => e.type === 'assistant.text' && e.messageId === mLong)).toBe(false);
    const firstAck = events.findIndex((e) => e.type === 'interrupt.acked');
    const interrupted = events.findIndex((e) => e.type === 'turn.interrupted');
    expect(firstAck).toBeGreaterThan(-1);
    expect(firstAck).toBeLessThan(interrupted);

    // 3 interrupts were sent (mid-turn, idle, race) → 3 acks, but only ONE interrupted.
    expect(events.filter((e) => e.type === 'interrupt.acked').length).toBe(3);
    expect(events.filter((e) => e.type === 'turn.interrupted').length).toBe(1);

    // Race (interrupt right behind the send; still_queued:[mRace]) → still completes.
    const race = outcomesFor(events, mRace)[0] as Extract<Outcome, { type: 'turn.completed' }>;
    expect(race.type).toBe('turn.completed');
    expect(race.result).toBe('ok, race');
    expect(outcomesFor(events, mAfter)[0]?.type).toBe('turn.completed');
    // The interrupted result reported total 0 → the race turn's cost is its full total.
    expect(race.costUsd).toBeCloseTo(0.00126444, 10);
  });

  test('dirty env (stream_event, system/status, active_goal…) maps identically', () => {
    const { events, sent, replies, fatals } = replay('dirty-env');
    expect(sent.length).toBe(3);
    expectWellFormedTurns(events, sent);
    expect(sent.map((id) => outcomesFor(events, id)[0]?.type)).toEqual([
      'turn.interrupted',
      'turn.completed',
      'turn.completed',
    ]);
    // Mid-session initialize (probe) → exactly one ready; the bogus control request's
    // error response is ours-but-'other' → no event, no fatal.
    expect(events.filter((e) => e.type === 'ready').length).toBe(1);
    expect(fatals).toEqual([]);
    expect(replies).toEqual([]);
  });

  test('can_use_tool (only with --permission-prompt-tool stdio) → permission.requested + deny reply', () => {
    const { events, sent, replies } = replay('permission-stdio');
    const [m1] = sent as [string];
    const perm = events.find((e) => e.type === 'permission.requested') as Extract<
      ProviderEvent,
      { type: 'permission.requested' }
    >;
    expect(perm.messageId).toBe(m1);
    expect((perm.detail as { tool_name?: string }).tool_name).toBe('Bash');
    expect(replies.length).toBe(1);
    const reply = replies[0] as { type: string; response: { subtype: string; request_id: string; response: unknown } };
    expect(reply.type).toBe('control_response');
    expect(reply.response.subtype).toBe('success');
    expect(reply.response.request_id).toBe('56b67329-5cee-43d3-9d11-adfc1b0fa247');
    expect(reply.response.response).toEqual({ behavior: 'deny', message: CLAUDE_PERMISSION_DENY_MESSAGE, interrupt: false });
    // The CLI's echo of the probe's own answer (unknown request id) is ignored; turn completes.
    expectWellFormedTurns(events, sent);
    expect(outcomesFor(events, m1)[0]?.type).toBe('turn.completed');
  });

  test('resume with no conversation: pre-ready result is not an outcome; errors kept for start()', () => {
    const { events, mapper } = replay('resume-no-conversation');
    expect(events).toEqual([]);
    expect(mapper.isReady).toBe(false);
    expect(mapper.startupErrors.join(' ')).toContain('No conversation found with session ID');
  });
});

describe('ClaudeStreamMapper edge rules (synthetic lines)', () => {
  const mk = (resume = false) => new ClaudeStreamMapper({ providerSessionId: 'sid', resume });
  const res = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', ...o });

  test('unknown / malformed lines are ignored', () => {
    const m = mk();
    m.beginTurn('m1');
    const lines = [
      'not json at all',
      '[1,2,3]',
      'null',
      '"string"',
      '{"no_type":true}',
      '{"type":"keep_alive"}',
      '{"type":"stream_event","event":{"type":"content_block_delta"}}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
      '{"type":"active_goal"}',
      '{"type":"autocompact_state"}',
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"system","subtype":"permission_denied"}',
      '{"type":"control_cancel_request","request_id":"x"}',
      '{"type":"brand_new_type_from_the_future","payload":{"a":1}}',
      '{"type":"command_lifecycle","command_uuid":"m1","state":"queued"}',
      '{"type":"command_lifecycle","command_uuid":"other","state":"started"}',
      '{"type":"user","isReplay":true,"uuid":"other","message":{"content":"x"}}',
      '{"type":"user","uuid":"m1","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}',
      '{"type":"control_response","response":{"subtype":"success","request_id":"not-ours","response":{}}}',
    ];
    for (const l of lines) {
      const r = m.handleLine(l);
      expect(r.events).toEqual([]);
      expect(r.replies).toEqual([]);
      expect(r.fatal).toBeUndefined();
    }
    expect(m.openMessageId).toBe('m1');
  });

  test('isReplay echo is the fallback ack; ack emitted once', () => {
    const m = mk();
    m.beginTurn('m1');
    expect(m.handleLine('{"type":"user","isReplay":true,"uuid":"m1","message":{"content":"x"}}').events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
    ]);
    expect(m.handleLine('{"type":"command_lifecycle","command_uuid":"m1","state":"started"}').events).toEqual([]);
  });

  test('outcome rule: aborted_* → interrupted; success+is_error → failed; errors joined', () => {
    const m = mk();
    m.beginTurn('a');
    expect(m.handleLine(res({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', user_message_uuid: 'a' })).events.map((e) => e.type)).toEqual(['turn.started', 'turn.interrupted']);
    m.beginTurn('b');
    const apiErr = m.handleLine(res({ subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', terminal_reason: 'api_error', user_message_uuid: 'b' })).events;
    expect(apiErr[1]).toEqual({ type: 'turn.failed', messageId: 'b', error: 'API Error: 529 overloaded' });
    m.beginTurn('c');
    const maxTurns = m.handleLine(res({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['e1', 'e2'], user_message_uuid: 'c' })).events;
    expect(maxTurns[1]).toEqual({ type: 'turn.failed', messageId: 'c', error: 'e1; e2' });
    m.beginTurn('d');
    const bare = m.handleLine(res({ subtype: 'error_during_execution', is_error: true })).events;
    expect(bare[1]).toEqual({ type: 'turn.failed', messageId: 'd', error: 'error_during_execution' });
  });

  test('exactly one outcome: duplicate / foreign results are ignored', () => {
    const m = mk();
    m.beginTurn('m1');
    expect(m.handleLine(res({ subtype: 'success', is_error: false, result: 'x', user_message_uuid: 'zzz' })).events).toEqual([]);
    expect(m.openMessageId).toBe('m1');
    expect(m.handleLine(res({ subtype: 'success', is_error: false, result: 'x', user_message_uuid: 'm1' })).events.map((e) => e.type)).toEqual(['turn.started', 'turn.completed']);
    expect(m.handleLine(res({ subtype: 'success', is_error: false, result: 'x', user_message_uuid: 'm1' })).events).toEqual([]);
  });

  test('assistant: subagent lines, thinking/tool_use-only blocks and foreign turns are skipped', () => {
    const m = mk();
    m.beginTurn('m1');
    const a = (o: Record<string, unknown>) => JSON.stringify({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'm1', ...o });
    expect(m.handleLine(a({ message: { content: [{ type: 'thinking', thinking: '' }] } })).events).toEqual([]);
    expect(m.handleLine(a({ message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })).events).toEqual([]);
    expect(m.handleLine(a({ parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'sub' }] } })).events).toEqual([]);
    expect(m.handleLine(a({ user_message_uuid: 'other', message: { content: [{ type: 'text', text: 'no' }] } })).events).toEqual([]);
    expect(m.handleLine(a({ message: { content: [{ type: 'text', text: 'he' }, { type: 'thinking' }, { type: 'text', text: 'llo' }] } })).events).toEqual([
      { type: 'turn.started', messageId: 'm1' },
      { type: 'assistant.text', messageId: 'm1', text: 'hello' },
    ]);
  });

  test('negative cost delta → undefined; base still advances', () => {
    const m = mk();
    m.beginTurn('a');
    m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.5 }));
    m.beginTurn('b');
    const b = m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.25 })).events[1];
    expect(b).toEqual({ type: 'turn.completed', messageId: 'b' });
    m.beginTurn('c');
    const c = m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.75 })).events[1] as { costUsd?: number };
    expect(c.costUsd).toBeCloseTo(0.5, 10);
  });

  test('a foreign-uuid result does not advance the cost base (its spend lands in the next own delta)', () => {
    const m = mk();
    m.beginTurn('a');
    m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.1, user_message_uuid: 'a' }));
    m.beginTurn('b');
    expect(m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.3, user_message_uuid: 'stray' })).events).toEqual([]);
    const b = m.handleLine(res({ subtype: 'success', is_error: false, total_cost_usd: 0.4, user_message_uuid: 'b' })).events[1] as { costUsd?: number };
    expect(b.costUsd).toBeCloseTo(0.3, 10); // 0.4 - 0.1, includes the stray 0.2
  });

  test('initialize error is fatal; second turn while open throws; abortTurn clears', () => {
    const m = mk();
    m.noteControlRequest('i1', 'initialize');
    const r = m.handleLine('{"type":"control_response","response":{"subtype":"error","request_id":"i1","error":"boom"}}');
    expect(r.fatal).toContain('boom');
    expect(m.isReady).toBe(false);
    m.beginTurn('m1');
    expect(() => m.beginTurn('m2')).toThrow(/already open/);
    m.abortTurn('m1');
    expect(m.openMessageId).toBeUndefined();
    m.beginTurn('m2');
  });

  test('other inbound control_request subtypes get an error reply', () => {
    const m = mk();
    const r = m.handleLine('{"type":"control_request","request_id":"q1","request":{"subtype":"elicitation"}}');
    expect(r.events).toEqual([]);
    expect(r.replies).toEqual([
      { type: 'control_response', response: { subtype: 'error', request_id: 'q1', error: "orc: unsupported control request 'elicitation'" } },
    ]);
  });

  test('redactClaudeLine drops the initialize account, leaves other lines verbatim', () => {
    const line = '{"type":"control_response","response":{"subtype":"success","request_id":"i","response":{"pid":1,"account":{"email":"a@b.c"}}}}';
    const red = redactClaudeLine(line, parseClaudeLine(line));
    expect(red).not.toContain('a@b.c');
    expect(JSON.parse(red).response.response).toEqual({ pid: 1, account: '<redacted>' });
    const other = '{"type":"assistant","message":{"content":[{"type":"text","text":"my account is fine"}]}}';
    expect(redactClaudeLine(other, parseClaudeLine(other))).toBe(other);
  });
});

describe('claude argv', () => {
  const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
    version: 1,
    sessionId: '11111111-2222-4333-8444-555555555555',
    provider: 'claude',
    cwd: '/tmp',
    env: {},
    createdAt: '2026-10-14T00:00:00.000Z',
    ...over,
  });
  const BASE = [
    'claude',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'user,project,local',
  ];

  test('fresh: --session-id, optional model/agent/append prompt file; never --bare', () => {
    expect(buildClaudeArgv(spec(), false)).toEqual([...BASE, '--session-id', '11111111-2222-4333-8444-555555555555']);
    const full = buildClaudeArgv(
      spec({ model: 'haiku', agentName: 'reviewer', systemPrompt: { mode: 'append', path: '/abs/sp.md' } }),
      false,
      '/bin/claude',
    );
    expect(full).toEqual([
      '/bin/claude',
      ...BASE.slice(1),
      '--session-id',
      '11111111-2222-4333-8444-555555555555',
      '--model',
      'haiku',
      '--agent',
      'reviewer',
      '--append-system-prompt-file',
      '/abs/sp.md',
    ]);
    expect(full).not.toContain('--bare');
  });

  test('replace mode uses --system-prompt-file', () => {
    const argv = buildClaudeArgv(spec({ systemPrompt: { mode: 'replace', path: '/abs/sp.md' } }), false);
    expect(argv.slice(-2)).toEqual(['--system-prompt-file', '/abs/sp.md']);
  });

  test('resume: --resume <providerSessionId>, never together with --session-id', () => {
    const argv = buildClaudeArgv(spec({ providerSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), true);
    expect(argv).toEqual([...BASE, '--resume', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    expect(argv).not.toContain('--session-id');
    // claude: provider session id === orc session id when not recorded.
    expect(buildClaudeArgv(spec(), true).slice(-2)).toEqual(['--resume', '11111111-2222-4333-8444-555555555555']);
  });
});

describe('claude env policy (tightened keep-list; supersedes decision 7 regex)', () => {
  test('strips inherited CLAUDE_CODE_* (incl. host feature toggles) except auth/proxy/limits/timeouts/opt-outs + ORC_CLAUDE_KEEP_ENV', () => {
    const base: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://proxy:1',
      NO_PROXY: 'localhost',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://x',
      CLAUDECODE: '1',
      UNDEFINED_VAR: undefined,
      // stripped
      CLAUDE_CODE_ENTRYPOINT: 'remote_cowork',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: 'true',
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_TEE_SDK_STDOUT: 'true',
      CLAUDE_CODE_ACCOUNT_UUID: 'acct',
      CLAUDE_CODE_USER_EMAIL: 'x@y.z',
      CLAUDE_CODE_ORGANIZATION_UUID: 'org',
      CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: '1',
      CLAUDE_CODE_FOO: 'listed-in-keep',
      CLAUDE_CODE_BAR: 'listed-in-keep',
      CLAUDE_CODE_BAZ: 'not-listed',
      // stripped: host feature toggles (formerly kept by the broad USE_/MAX_/DISABLE_ prefixes)
      CLAUDE_CODE_USE_CCR_V2: '1',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2',
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '100',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
      CLAUDE_CODE_DISABLE_BUILTIN_ANTMCP: '1',
      // kept by regex
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_OAUTH_401_WAIT_MS: '10',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      CLAUDE_CODE_MAX_RETRIES: '3',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_EXTRA_BODY: '{}',
      CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
      CLAUDE_CODE_CLIENT_CERT: '/c',
      CLAUDE_CODE_API_TIMEOUT_MS: '1000',
      CLAUDE_CODE_SYNC_PLUGINS_INSTALL_TIMEOUT_MS: '5',
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '2',
      ORC_CLAUDE_KEEP_ENV: ' CLAUDE_CODE_FOO , CLAUDE_CODE_BAR,',
    };
    const env = buildClaudeEnv(base, { ORC_SESSION_ID: 's1', ORC_PARENT_SESSION_ID: 'p1', CLAUDE_CODE_EXPLICIT: 'from-spec' });

    for (const k of [
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES',
      'CLAUDE_CODE_REMOTE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_TEE_SDK_STDOUT',
      'CLAUDE_CODE_ACCOUNT_UUID',
      'CLAUDE_CODE_USER_EMAIL',
      'CLAUDE_CODE_ORGANIZATION_UUID',
      'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS',
      'CLAUDE_CODE_BAZ',
      'CLAUDE_CODE_USE_CCR_V2',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_DISABLE_WORKFLOWS',
      'CLAUDE_CODE_DISABLE_BUILTIN_ANTMCP',
      'UNDEFINED_VAR',
    ]) {
      expect(env).not.toHaveProperty(k);
    }
    for (const k of [
      'PATH',
      'HOME',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDECODE',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_401_WAIT_MS',
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_DISABLE_TELEMETRY',
      'CLAUDE_CODE_DISABLE_AUTOUPDATER',
      'CLAUDE_CODE_DISABLE_ERROR_REPORTING',
      'CLAUDE_CODE_EXTRA_BODY',
      'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_API_TIMEOUT_MS',
      'CLAUDE_CODE_SYNC_PLUGINS_INSTALL_TIMEOUT_MS',
      'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
      'CLAUDE_CODE_FOO',
      'CLAUDE_CODE_BAR',
    ]) {
      expect(env[k]).toBe(base[k] as string);
    }
    // spec.env is applied AFTER stripping (even a CLAUDE_CODE_* the spec sets explicitly).
    expect(env.ORC_SESSION_ID).toBe('s1');
    expect(env.ORC_PARENT_SESSION_ID).toBe('p1');
    expect(env.CLAUDE_CODE_EXPLICIT).toBe('from-spec');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});
