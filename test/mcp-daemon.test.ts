/**
 * The daemon's `/mcp` endpoint over a live loopback socket, driven by the official MCP
 * client (Streamable HTTP, both protocol eras): the daemon's authentication (401), the
 * Host/Origin guard (403), tools filtered by each bearer token's scopes, an out-of-scope
 * call answered with an error result, real calls on the fake provider, daemon-mode path
 * rules, and a `wait` that outlives Bun's default 10 s idle timeout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveDaemon } from '../src/daemon/server.ts';
import type { Scope } from '../src/daemon/auth.ts';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { readRegistry } from '../src/registry.ts';
import { orcInstructions } from '../src/mcp/instructions.ts';
import { killSessionProcesses, mkTmp, TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';

const T = 60_000;
const prevHome = process.env.ORC_HOME;
const prevFake = process.env[FAKE_PROVIDER_ENV];
const root = mkTmp('orc-mcp-daemon-');
const home = path.join(root, 'orc');
const work = path.join(root, 'work');

const TOKENS = new Map<string, readonly Scope[]>([
  ['reader', ['sessions:read']],
  ['writer', ['sessions:read', 'sessions:write']],
  ['wf-reader', ['workflows:read']],
  ['root', ['admin']],
]);

let server: Bun.Server<undefined>;
let mcpUrl: URL;
const clients: Client[] = [];

beforeAll(() => {
  process.env.ORC_HOME = home;
  process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ rules: [{ match: 'SLOW', action: 'reply', delayMs: 12_000 }] });
  fs.mkdirSync(work, { recursive: true });
  server = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: null,
    tokens: TOKENS,
    allowlist: [],
    whois: async () => null,
    version: 'test',
    hostName: 'testhost',
  });
  mcpUrl = new URL(`http://127.0.0.1:${server.port}/mcp`);
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server.stop(true);
  await killSessionProcesses((await readRegistry().catch(() => [])).map((r) => r.sessionId));
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  fs.rmSync(root, { recursive: true, force: true });
}, TEARDOWN_TIMEOUT_MS);

async function connect(token: string, mode: 'legacy' | 'auto' = 'legacy'): Promise<Client> {
  const client = new Client({ name: 'orc-mcp-daemon-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

interface Result {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, { timeout: 90_000 })) as Result;
}
const text = (r: Result): string => r.content.map((c) => c.text ?? '').join('\n');

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});
const post = (headers: Record<string, string>, body = INITIALIZE) =>
  fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });

describe('daemon /mcp: authentication and the Host/Origin guard', () => {
  test('no credentials → 401; a wrong token → 401', async () => {
    const none = await post({});
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: string }).error).toMatch(/authentication required/);
    const wrong = await post({ authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    const viaClient = new Client({ name: 'x', version: '1' });
    await expect(viaClient.connect(new StreamableHTTPClientTransport(mcpUrl))).rejects.toThrow();
  }, T);

  test('a foreign Origin or Host → 403 (before authentication); a same-host Origin is served', async () => {
    const origin = await post({ authorization: 'Bearer root', origin: 'http://evil.example' });
    expect(origin.status).toBe(403);
    expect(await origin.json()).toMatchObject({ jsonrpc: '2.0', error: { message: 'Invalid Origin: evil.example' } });
    const host = await post({ authorization: 'Bearer root', host: `evil.example:${server.port}` });
    expect(host.status).toBe(403);
    expect(await host.json()).toMatchObject({ error: { message: 'Invalid Host: evil.example' } });
    // The guard runs before authentication: a rebinding page learns nothing about credentials.
    expect((await post({ origin: 'http://evil.example' })).status).toBe(403);
    const same = await post({ authorization: 'Bearer root', origin: `http://localhost:${server.port}` });
    expect(same.status).toBe(200);
  }, T);

  test('a malformed Host is a JSON 400, never an exception page (on /mcp and on REST routes)', async () => {
    /** One raw HTTP/1.1 request: fetch() refuses to send these Host values. */
    const raw = (host: string, reqPath: string): Promise<string> =>
      new Promise((resolve) => {
        const sock = net.connect(server.port!, '127.0.0.1', () => {
          sock.write(`POST ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
        });
        let buf = '';
        sock.on('data', (d) => (buf += d.toString()));
        sock.on('end', () => resolve(buf));
        sock.on('error', (e) => resolve(`ERROR ${e.message}`));
      });
    for (const host of ['::1', 'localhost@evil.example', '127.0.0.1/mcp', '127.0.0.1 evil', 'ⓛocalhost']) {
      for (const reqPath of ['/mcp', '/sessions']) {
        const res = await raw(host, reqPath);
        const [head, body] = res.split('\r\n\r\n');
        expect([host, reqPath, head!.split('\r\n')[0]]).toEqual([host, reqPath, 'HTTP/1.1 400 Bad Request']);
        expect(head!.toLowerCase()).toContain('content-type: application/json');
        expect(JSON.parse(body!)).toEqual({ error: 'invalid request URL' });
        expect(res).not.toContain('<html');
      }
    }
  }, T);

  test('an oversized body → 413', async () => {
    const big = await post({ authorization: 'Bearer root' }, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
  }, T);
});

describe('daemon /mcp: tools by scope', () => {
  test('tools/list shows only what each token may call', async () => {
    const names = async (token: string) => (await (await connect(token)).listTools()).tools.map((t) => t.name);
    expect(await names('reader')).toEqual(['guide', 'wait', 'read', 'state', 'list', 'settings']);
    expect(await names('writer')).toEqual(['guide', 'spawn', 'send', 'wait', 'read', 'state', 'list', 'resume', 'settings']);
    expect(await names('wf-reader')).toEqual(['guide', 'workflow_list', 'workflow_status', 'workflow_logs']);
    const all = await names('root');
    expect(all).toHaveLength(19);
    expect(all).toContain('kill');
    expect(all).toContain('workflow_cleanup');
  }, T);

  test('daemon-mode tools take no host, and the instructions are the daemon variant', async () => {
    const c = await connect('root');
    expect(c.getInstructions()).toBe(orcInstructions('daemon'));
    const tools = (await c.listTools()).tools;
    for (const t of tools) expect(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})).not.toContain('host');
    for (const name of ['spawn', 'workflow_run', 'workflow_resume', 'workflow_retry']) {
      expect([name, (tools.find((t) => t.name === name)!.inputSchema as { required?: string[] }).required]).toEqual([
        name,
        expect.arrayContaining(['cwd']),
      ]);
    }
  }, T);

  test('an out-of-scope call is an error result naming the missing scope, not a crash', async () => {
    const reader = await connect('reader');
    const kill = await callTool(reader, 'kill', { id: 'abc' });
    expect(kill.isError).toBe(true);
    expect(text(kill)).toContain("forbidden: 'kill' needs the daemon scope 'admin'");
    const spawn = await callTool(reader, 'spawn', { provider: 'claude', cwd: work });
    expect(spawn.isError).toBe(true);
    expect(text(spawn)).toContain("'sessions:write'");
    // The connection still works afterwards.
    expect((await callTool(reader, 'list')).isError).toBeFalsy();
    // Nothing was spawned.
    expect(await readRegistry()).toEqual([]);
  }, T);

  test('a 2026-07-28 client gets the same scoped view', async () => {
    const modern = await connect('reader', 'auto');
    expect(modern.getProtocolEra()).toBe('modern');
    expect(modern.getInstructions()).toBe(orcInstructions('daemon'));
    expect((await modern.listTools()).tools.map((t) => t.name)).toEqual(['guide', 'wait', 'read', 'state', 'list', 'settings']);
    const denied = await callTool(modern, 'kill', { id: 'abc' });
    expect(denied.isError).toBe(true);
  }, T);
});

describe('daemon /mcp: real calls on the daemon host', () => {
  test('spawn (absolute cwd) → wait → read → kill; a relative cwd is refused', async () => {
    const writer = await connect('writer');
    const rel = await callTool(writer, 'spawn', { provider: 'claude', cwd: 'work', prompt: 'x' });
    expect(rel.isError).toBe(true);
    expect(text(rel)).toContain('absolute path on the daemon host');
    const missing = await callTool(writer, 'spawn', { provider: 'claude', cwd: path.join(root, 'nope'), prompt: 'x' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('does not exist on the daemon host');

    const sp = await callTool(writer, 'spawn', { provider: 'claude', cwd: work, prompt: 'hello daemon mcp' });
    expect(sp.isError).toBeFalsy();
    const id = sp.structuredContent!.id as string;
    expect(sp.structuredContent!.cwd).toBe(fs.realpathSync(work));
    const w = await callTool(writer, 'wait', { ids: [id] });
    expect(w.structuredContent).toMatchObject({ reached: [id] });
    expect(text(await callTool(writer, 'read', { id }))).toContain('echo: hello daemon mcp');
    // list with no workspace covers every workspace on the daemon.
    const listed = await callTool(writer, 'list');
    expect((listed.structuredContent!.sessions as { id: string }[]).map((s) => s.id)).toContain(id);

    const admin = await connect('root');
    const k = await callTool(admin, 'kill', { id, purge: true });
    expect(k.structuredContent).toMatchObject({ ok: true, id, purged: true });
  }, T);

  test('a wait longer than 10 s is not cut by an idle timeout', async () => {
    const writer = await connect('writer');
    const sp = await callTool(writer, 'spawn', { provider: 'pi', cwd: work, prompt: 'SLOW please' });
    const id = sp.structuredContent!.id as string;
    const started = Date.now();
    const w = await callTool(writer, 'wait', { ids: [id], for: 'done', timeout_seconds: 40 });
    const elapsed = Date.now() - started;
    expect(w.isError).toBeFalsy();
    expect(w.structuredContent).toMatchObject({ reached: [id], pending: [] });
    expect(elapsed).toBeGreaterThan(10_500);
    expect(text(await callTool(writer, 'read', { id }))).toContain('echo: SLOW please');
    expect((await callTool(await connect('root'), 'kill', { id, purge: true })).isError).toBeFalsy();
  }, T);
});
