/**
 * S5 cutover — the daemon's session routes and the `--host` CLI on the actor runtime
 * (wire api v2): spawn/get/send (idempotency key, wake:false)/read raw + fallback as the
 * session journal/raw run logs/kill, over a live loopback socket and the fake provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { httpStatusFor, serveDaemon } from '../src/daemon/server.ts';
import { PolicyViolationError } from '../src/policy.ts';
import { SessionNotControllableError } from '../src/session.ts';
import { SessionStartError, SessionStoppedError } from '../src/runtime/client.ts';
import { remoteSendExitCode } from '../src/cli/index.ts';
import { DaemonClient } from '../src/daemon/client.ts';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { writeRun, WORKFLOW_SCHEMA_VERSION } from '../src/runs.ts';
import { killSessionProcesses, mkTmp, plainCliEnv } from './runtime-helpers.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 45_000;
const prevHome = process.env.ORC_HOME;
const prevFake = process.env[FAKE_PROVIDER_ENV];
const root = mkTmp('orc-daemon-actor-');
const home = path.join(root, 'orc');
const work = path.join(root, 'work');
const sids: string[] = [];
let server: Bun.Server<undefined>;
let base = '';
const headers = { 'x-orc-secret': 's3cret', 'content-type': 'application/json' };

beforeAll(() => {
  process.env.ORC_HOME = home;
  process.env[FAKE_PROVIDER_ENV] = '1';
  fs.mkdirSync(work, { recursive: true });
  server = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: 's3cret',
    allowlist: [],
    whois: async () => null,
    version: 'test',
    hostName: 'testhost',
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  fs.rmSync(root, { recursive: true, force: true });
}, TEARDOWN_TIMEOUT_MS);

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function orcRemote(args: string[], port = server.port): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, '--host', `127.0.0.1:${port}`, ...args], {
    cwd: work,
    env: plainCliEnv({ ...process.env, ORC_DAEMON_SECRET: 's3cret' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe('daemon session routes on the actor runtime', () => {
  test(
    'spawn/get/send/read/logs/kill speak journal, not pane',
    async () => {
      const spawned = await call('POST', '/sessions', { provider: 'claude', cwd: work, prompt: 'hi daemon' });
      expect(spawned.status).toBe(200);
      const id: string = spawned.json.id;
      sids.push(spawned.json.sessionId);
      expect(spawned.json.runtime).toBe('actor');

      const waited = await call('POST', `/sessions/${id}/wait`, { for: 'done', timeoutMs: 10_000 });
      expect(waited.json).toMatchObject({ state: 'done', timedOut: false });

      const got = await call('GET', `/sessions/${id}`);
      expect(got.json).toMatchObject({ id, status: 'running', state: 'done', suspended: false, stopped: false });

      const s1 = await call('POST', `/sessions/${id}/send`, { prompt: 'again', idempotencyKey: 'dk-1' });
      expect(s1.json).toEqual({ ok: true, id, phase: 'acknowledged', messageId: 'dk-1', replayed: false });
      const s2 = await call('POST', `/sessions/${id}/send`, { prompt: 'again', messageId: 'dk-1' });
      expect(s2.json).toMatchObject({ phase: 'acknowledged', replayed: true });
      const bad = await call('POST', `/sessions/${id}/send`, { prompt: 'x', wake: 'no' });
      expect(bad.status).toBe(400);
      // Same idempotency key, different prompt → 409 (not a 500).
      const conflict = await call('POST', `/sessions/${id}/send`, { prompt: 'something else', messageId: 'dk-1' });
      expect(conflict.status).toBe(409);
      // Invalid option combination → 400 (not a 500).
      const badSpawn = await call('POST', '/sessions', { provider: 'claude', cwd: work, agent: 'x', systemPrompt: 'y' });
      expect(badSpawn.status).toBe(400);

      const raw = await call('GET', `/sessions/${id}/read?raw=1`);
      expect(raw.json.kind).toBe('raw');
      expect(raw.json.pane).toBeUndefined();
      expect(raw.json.journal.some((e: { type: string }) => e.type === 'turn.completed')).toBe(true);
      const fb = await call('GET', `/sessions/${id}/read`);
      expect(fb.json.kind).toBe('fallback');
      expect(Array.isArray(fb.json.journal)).toBe(true);

      await writeRun({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        revision: 1,
        id: 'dlogs',
        name: 'logs',
        startedAt: new Date().toISOString(),
        status: 'done',
        steps: [{ id: 's', sessionId: id, provider: 'claude', state: 'done', ok: true, commitsAhead: 0 }],
      });
      const logs = await call('GET', '/workflows/runs/dlogs/logs?raw=1');
      expect(logs.json.kind).toBe('raw');
      expect(logs.json.logs[0].step).toBe('s');
      expect(logs.json.logs[0].journal.length).toBeGreaterThan(0);

      // The --host CLI renders the v2 shapes.
      const rr = await orcRemote(['read', id, '--raw', '--json']);
      expect(rr.code).toBe(0);
      expect(JSON.parse(rr.out).journal.length).toBeGreaterThan(0);
      const rs = await orcRemote(['send', id, 'via host', '--idempotency-key', 'rk-1', '--json']);
      expect(rs.code).toBe(0);
      expect(JSON.parse(rs.out)).toMatchObject({ phase: 'acknowledged', messageId: 'rk-1' });
      const st = await orcRemote(['state', id, '--json']);
      expect(JSON.parse(st.out)).toMatchObject({ id, status: 'running', suspended: false, stopped: false });
      const at = await orcRemote(['attach', id, '--json']);
      expect(JSON.parse(at.out)).toEqual({ id, host: '127.0.0.1', command: `tailscale ssh 127.0.0.1 orc attach ${id}` });

      const client = new DaemonClient({ host: '127.0.0.1', port: server.port! }, 's3cret');
      expect((await client.health()).api).toBe(2);
      const queued = await client.send(id, 'no wake needed', { wake: false });
      expect(['acknowledged', 'queued']).toContain(queued.phase!);

      const killed = await call('POST', `/sessions/${id}/kill`, {});
      expect(killed.json).toEqual({ ok: true, id, purged: false });
      const after = await call('GET', `/sessions/${id}`);
      expect(after.json).toMatchObject({ status: 'dead', stopped: true, state: 'failed' });
      const refused = await call('POST', `/sessions/${id}/send`, { prompt: 'nope' });
      expect(refused.status).toBe(409);
      expect(refused.json.error).toMatch(/orc resume/);
    },
    T,
  );

  test(
    'the --host CLI tolerates a v1 (pre-actor) daemon: `submitted` sends succeed, pane reads print',
    async () => {
      const v1 = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname.endsWith('/send')) return Response.json({ ok: true, id: 'abc', phase: 'submitted', messageId: 'k1' });
          if (u.pathname.endsWith('/read')) {
            return Response.json(
              u.searchParams.get('raw') ? { kind: 'raw', id: 'abc', pane: 'RAW PANE' } : { kind: 'fallback', id: 'abc', pane: 'FB PANE\n' },
            );
          }
          return Response.json({ error: 'not found' }, { status: 404 });
        },
      });
      try {
        const sent = await orcRemote(['send', 'abc', 'hi', '--idempotency-key', 'k1'], v1.port);
        expect(sent.code).toBe(0);
        expect(sent.out).toContain('abc');
        const sentJson = await orcRemote(['send', 'abc', 'hi', '--json'], v1.port);
        expect(sentJson.code).toBe(0);
        expect(JSON.parse(sentJson.out)).toMatchObject({ phase: 'submitted' });
        const raw = await orcRemote(['read', 'abc', '--raw'], v1.port);
        expect(raw).toMatchObject({ code: 0, out: 'RAW PANE\n' });
        expect(JSON.parse((await orcRemote(['read', 'abc', '--raw', '--json'], v1.port)).out)).toEqual({ id: 'abc', pane: 'RAW PANE' });
        const fb = await orcRemote(['read', 'abc'], v1.port);
        expect(fb).toMatchObject({ code: 0, out: 'FB PANE\n' });
        expect(JSON.parse((await orcRemote(['read', 'abc', '--json'], v1.port)).out)).toEqual({
          id: 'abc',
          fallback: true,
          pane: 'FB PANE\n',
        });
      } finally {
        v1.stop(true);
      }
    },
    T,
  );
});

describe('daemon error → HTTP status mapping', () => {
  test('policy 403; stopped / message conflict / legacy 409; unknown 404; start failure 502; else 500', () => {
    expect(httpStatusFor(new PolicyViolationError('nope'))).toBe(403);
    expect(httpStatusFor(new SessionNotControllableError('x', 'ORC_SESSION_STOPPED'))).toBe(409);
    expect(httpStatusFor(new SessionNotControllableError('x', 'ORC_MESSAGE_CONFLICT'))).toBe(409);
    expect(httpStatusFor(new SessionNotControllableError('x', 'ORC_SESSION_LEGACY'))).toBe(409);
    expect(httpStatusFor(new SessionNotControllableError('x', 'ORC_SESSION_UNKNOWN'))).toBe(404);
    expect(httpStatusFor(new SessionStoppedError('sid-12345678'))).toBe(409);
    expect(httpStatusFor(new SessionStartError('sid-12345678', 'boom', 1))).toBe(502);
    expect(httpStatusFor(new Error('boom'))).toBe(500);
  });

  test('remote send exit codes accept v1 phases', () => {
    expect(remoteSendExitCode(undefined)).toBe(0);
    expect(remoteSendExitCode('submitted')).toBe(0);
    expect(remoteSendExitCode('acknowledged')).toBe(0);
    expect(remoteSendExitCode('queued')).toBe(0);
    expect(remoteSendExitCode('unknown')).toBe(3);
    expect(remoteSendExitCode('failed')).toBe(1);
    expect(remoteSendExitCode('prepared')).toBe(1);
  });
});
