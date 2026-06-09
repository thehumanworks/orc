import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveDaemon } from '../src/daemon/server.ts';
import type { Identity } from '../src/daemon/trust.ts';

/**
 * Live-socket integration: a real `Bun.serve` on 127.0.0.1, started/stopped in-process,
 * with an INJECTED whois (loopback can't be whois-resolved for real). This exercises the
 * gate end-to-end over HTTP — the open /health, the 403 deny paths, the secret-path allow,
 * AND (via a mocked whois) the identity path's wiring — WITHOUT spawning real agents.
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
  allowlist?: string[];
  whois?: (ip: string | null) => Promise<Identity | null>;
}): Bun.Server<undefined> {
  const s = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: opts.secret ?? null,
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

  test('a gated route with NO secret and NO identity → 403 (fail closed)', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/forbidden/);
  });

  test('a gated route with the WRONG secret → 403', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'), { headers: { 'x-orc-secret': 'nope' } });
    expect(res.status).toBe(403);
  });

  test('a gated route with the CORRECT secret → 200', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/sessions'), { headers: { 'x-orc-secret': 'topsecret' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('/whoami (secret path) reports peerAllowed=false when identity is unresolved', async () => {
    const s = start({ secret: 'topsecret', allowlist: ['mini'], whois: async () => null });
    const res = await fetch(url(s, '/whoami'), { headers: { 'x-orc-secret': 'topsecret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { peerAllowed: boolean; identity: unknown };
    expect(body.peerAllowed).toBe(false);
    expect(body.identity).toBeNull();
  });

  test('identity path: an allowlisted whois result is allowed WITHOUT a secret', async () => {
    const s = start({
      secret: null,
      allowlist: ['mini'],
      whois: async () => ({ node: 'mini.taila038d5.ts.net' }),
    });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(200);
    // /whoami should now echo peerAllowed=true.
    const who = (await (await fetch(url(s, '/whoami'))).json()) as { peerAllowed: boolean };
    expect(who.peerAllowed).toBe(true);
  });

  test('identity path: a NON-allowlisted whois result (no secret) → 403', async () => {
    const s = start({
      secret: null,
      allowlist: ['mini'],
      whois: async () => ({ node: 'stranger.taila038d5.ts.net' }),
    });
    const res = await fetch(url(s, '/sessions'));
    expect(res.status).toBe(403);
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
});
