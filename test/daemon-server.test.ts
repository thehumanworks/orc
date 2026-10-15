import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveDaemon } from '../src/daemon/server.ts';
import { writeRegistry } from '../src/registry.ts';
import type { Identity } from '../src/daemon/trust.ts';
import type { Scope } from '../src/daemon/auth.ts';
import type { SessionRecord } from '../src/types.ts';

/**
 * Live-socket integration: a real `Bun.serve` on 127.0.0.1, started/stopped in-process,
 * with an INJECTED whois (loopback can't be whois-resolved for real). This exercises the
 * gate end-to-end over HTTP — the open /health, 401 unauthenticated/invalid, 403
 * insufficient scope, secret/bearer allow, AND (via mocked whois) the identity path —
 * WITHOUT spawning real agents.
 */

let home: string;
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-daemon-'));
  process.env.ORC_HOME = path.join(home, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
});
afterAll(async () => {
  delete process.env.ORC_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

const servers: Bun.Server<undefined>[] = [];
function start(opts: {
  secret?: string | null;
  tokens?: ReadonlyMap<string, readonly Scope[]>;
  allowlist?: string[];
  whois?: (ip: string | null) => Promise<Identity | null>;
}): Bun.Server<undefined> {
  const s = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: opts.secret ?? null,
    tokens: opts.tokens,
    allowlist: opts.allowlist ?? [],
    whois: opts.whois ?? (async () => null),
    version: 'test',
    hostName: 'testhost',
  });
  servers.push(s);
  return s;
}
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const url = (s: Bun.Server<undefined>, p: string) => `http://127.0.0.1:${s.port}${p}`;

describe('daemon over a live loopback socket', () => {
  test('GET /health needs NO auth and reports ok/version/host', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'] });
    const res = await fetch(url(s, '/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'test', host: 'testhost' });
  });

  test('a gated route with NO secret and NO identity → 401 (fail closed)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/unauthorized|authentication required/i);
    expect(JSON.stringify(body)).not.toContain('topsecret');
  });

  test('a gated route with the WRONG secret → 401', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'), { headers: { 'x-orc-secret': 'nope' } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid credentials/);
    expect(JSON.stringify(body)).not.toContain('topsecret');
    expect(JSON.stringify(body)).not.toContain('nope');
  });

  test('a gated route with the CORRECT legacy secret → 200 (all scopes)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'), { headers: { 'x-orc-secret': 'topsecret' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('/whoami (secret path) reports principal + peerAllowed without credentials', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/whoami'), { headers: { 'x-orc-secret': 'topsecret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      peerAllowed: boolean;
      identity: unknown;
      principal?: { kind: string; scopes: string[] };
    };
    expect(body.peerAllowed).toBe(false);
    expect(body.identity).toBeNull();
    expect(body.principal?.kind).toBe('legacy_secret');
    expect(body.principal?.scopes).toContain('admin');
    expect(JSON.stringify(body)).not.toContain('topsecret');
  });

  test('identity path: an allowlisted whois result is allowed WITHOUT a secret', async () => {
    const s = start({
      secret: null,
      allowlist: ['mini'],
      whois: async () => ({ node: 'mini.taila038d5.ts.net' }),
    });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(200);
    // /whoami should now echo peerAllowed=true and identity principal.
    const who = (await (await fetch(url(s, '/whoami'))).json()) as {
      peerAllowed: boolean;
      principal?: { kind: string; node?: string };
    };
    expect(who.peerAllowed).toBe(true);
    expect(who.principal?.kind).toBe('identity');
    expect(who.principal?.node).toBe('mini.taila038d5.ts.net');
  });

  test('identity path: a NON-allowlisted whois result (no secret) → 401', async () => {
    const s = start({
      secret: null,
      allowlist: ['mini'],
      whois: async () => ({ node: 'stranger.taila038d5.ts.net' }),
    });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(401);
  });

  test('bearer token with sessions:read can list but not spawn', async () => {
    const tokens = new Map<string, readonly Scope[]>([['read-only', ['sessions:read']]]);
    const s = start({ secret: null, tokens, whois: async () => null });
    const list = await fetch(url(s, '/sessions'), {
      headers: { authorization: 'Bearer read-only' },
    });
    expect(list.status).toBe(200);

    const spawn = await fetch(url(s, '/sessions'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer read-only',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(spawn.status).toBe(403);
    const body = (await spawn.json()) as { error?: string };
    expect(body.error).toMatch(/sessions:write/);
    expect(JSON.stringify(body)).not.toContain('read-only');
  });

  test('bearer token with sessions:write can spawn validation path; kill needs admin', async () => {
    const tokens = new Map<string, readonly Scope[]>([['writer', ['sessions:write']]]);
    const s = start({ secret: null, tokens, whois: async () => null });
    const spawn = await fetch(url(s, '/sessions'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'gpt' }),
    });
    // Authz passed; provider validation fails with 400.
    expect(spawn.status).toBe(400);

    const kill = await fetch(url(s, '/sessions/any/kill'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(kill.status).toBe(403);
    const body = (await kill.json()) as { error?: string };
    expect(body.error).toMatch(/admin/);
  });

  test('invalid bearer → 401; missing token → 401; /health still open', async () => {
    const tokens = new Map<string, readonly Scope[]>([['good', ['admin']]]);
    const s = start({ secret: null, tokens, whois: async () => null });
    const bad = await fetch(url(s, '/sessions'), {
      headers: { authorization: 'Bearer bad' },
    });
    expect(bad.status).toBe(401);
    const missing = await fetch(url(s, '/sessions'));
    expect(missing.status).toBe(401);
    const health = await fetch(url(s, '/health'));
    expect(health.status).toBe(200);
    expect(JSON.stringify(await bad.json())).not.toContain('good');
  });

  test('/whoami with bearer reports principal scopes without token value', async () => {
    const tokens = new Map<string, readonly Scope[]>([
      ['scoped-tok', ['sessions:read', 'workflows:read']],
    ]);
    const s = start({ secret: null, tokens, whois: async () => null });
    const res = await fetch(url(s, '/whoami'), {
      headers: { authorization: 'Bearer scoped-tok' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('scoped-tok');
    const body = JSON.parse(text) as { principal: { kind: string; scopes: string[] } };
    expect(body.principal.kind).toBe('token');
    expect(body.principal.scopes).toEqual(['sessions:read', 'workflows:read']);
  });

  test('an unknown route (authenticated) → 404', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/nope'), { headers: { 'x-orc-secret': 'topsecret' } });
    expect(res.status).toBe(404);
  });

  test('a missing session over the API → 404 (not 500)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions/does-not-exist'), {
      headers: { 'x-orc-secret': 'topsecret' },
    });
    expect(res.status).toBe(404);
  });

  test('POST /sessions with invalid provider → 400 (not 500)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'), {
      method: 'POST',
      headers: { 'x-orc-secret': 'topsecret', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gpt' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid provider/);
  });

  test('POST /workflows/run rejects invalid maxConcurrency with 400', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const headers = { 'x-orc-secret': 'topsecret', 'content-type': 'application/json' };
    for (const bad of [0, -1, 1.5, '2', null]) {
      const res = await fetch(url(s, '/workflows/run'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          def: { name: 'x', steps: [{ id: 'a', provider: 'claude', prompt: 'p' }] },
          maxConcurrency: bad,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/maxConcurrency|positive integer/i);
    }
  });

  test('POST /workflows/run accepts a valid maxConcurrency (parse succeeds before def validation)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    // Valid concurrency + invalid def: must NOT fail with maxConcurrency error.
    const res = await fetch(url(s, '/workflows/run'), {
      method: 'POST',
      headers: { 'x-orc-secret': 'topsecret', 'content-type': 'application/json' },
      body: JSON.stringify({
        def: { name: 'bad', steps: [] },
        maxConcurrency: 2,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toMatch(/maxConcurrency/i);
    expect(body.error).toMatch(/steps|non-empty/i);
  });

  test('/sessions/:id/read applies cursor selection to parsed transcripts', async () => {
    const transcript = path.join(home, 'claude-read.jsonl');
    await fs.writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'first' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'first done' } }),
        JSON.stringify({ type: 'user', message: { content: 'second' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/x.ts' } }] },
        }),
        JSON.stringify({ type: 'assistant', message: { content: 'second done' } }),
      ].join('\n'),
    );
    const rec: SessionRecord = {
      id: 'readtest',
      sessionId: 'readtest-0000-0000-0000-000000000000',
      provider: 'claude',
      cwd: home,
      workspace: home,
      createdAt: new Date().toISOString(),
      transcriptPath: transcript,
    };
    await writeRegistry([rec]);

    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const headers = { 'x-orc-secret': 'topsecret' };

    const latest = await fetch(url(s, '/sessions/readtest/read'), { headers });
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({
      kind: 'parsed',
      id: 'readtest',
      turns: [
        { role: 'user', text: 'second' },
        { role: 'tool', text: 'Read src/x.ts' },
        { role: 'assistant', text: 'second done' },
      ],
    });

    const first = await fetch(url(s, '/sessions/readtest/read?index=0'), { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      turns: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'first done' },
      ],
    });

    const full = await fetch(url(s, '/sessions/readtest/read?full=1'), { headers });
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { turns: unknown[] };
    expect(fullBody.turns).toHaveLength(5);

    const badIndex = await fetch(url(s, '/sessions/readtest/read?index=99'), { headers });
    expect(badIndex.status).toBe(400);
    const badIndexBody = (await badIndex.json()) as { error?: string };
    expect(badIndexBody.error).toMatch(/turn index 99 out of range/);

    const rawConflict = await fetch(url(s, '/sessions/readtest/read?raw=1&full=1'), { headers });
    expect(rawConflict.status).toBe(400);
  });
});
