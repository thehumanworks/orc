/**
 * S5 cutover — the daemon's session routes and the `--host` CLI on the actor runtime
 * (wire api v2): spawn/get/send (idempotency key, wake:false)/read raw + fallback as the
 * session journal/raw run logs/kill, over a live loopback socket and the fake provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { serveDaemon } from '../src/daemon/server.ts';
import { DaemonClient } from '../src/daemon/client.ts';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { writeRun, WORKFLOW_SCHEMA_VERSION } from '../src/runs.ts';
import { killSessionProcesses, mkTmp } from './runtime-helpers.ts';

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
});

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function orcRemote(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, '--host', `127.0.0.1:${server.port}`, ...args], {
    cwd: work,
    env: { ...process.env, ORC_DAEMON_SECRET: 's3cret' },
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
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.json.error).toMatch(/orc resume/);
    },
    T,
  );
});
