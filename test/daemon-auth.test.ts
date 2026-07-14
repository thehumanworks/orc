import { describe, test, expect } from 'bun:test';
import {
  ALL_SCOPES,
  authenticate,
  authorize,
  effectiveScopes,
  extractBearerToken,
  matchBearerToken,
  parseDaemonTokensJson,
  parseDaemonTokensObject,
  reportPrincipal,
  routeAuth,
  safeEqual,
  scopeGrants,
} from '../src/daemon/auth.ts';
import type { RouteName } from '../src/daemon/routes.ts';
import type { Scope } from '../src/daemon/auth.ts';

/**
 * Pure authorization unit tests: scope implication, route mapping (every route),
 * authenticate (401 paths), authorize (403 paths), token parse, redaction shape.
 */

const emptyTokens = new Map<string, readonly Scope[]>();

describe('scopeGrants / effectiveScopes', () => {
  test('admin implies every scope including itself', () => {
    for (const s of ALL_SCOPES) {
      expect(scopeGrants(['admin'], s)).toBe(true);
    }
    expect(effectiveScopes(['admin'])).toEqual([...ALL_SCOPES]);
  });

  test('exact scope grants only itself', () => {
    expect(scopeGrants(['sessions:read'], 'sessions:read')).toBe(true);
    expect(scopeGrants(['sessions:read'], 'sessions:write')).toBe(false);
    expect(scopeGrants(['sessions:write'], 'sessions:read')).toBe(false);
    expect(scopeGrants(['workflows:read'], 'workflows:write')).toBe(false);
    expect(scopeGrants(['workflows:write'], 'admin')).toBe(false);
  });

  test('empty held grants nothing', () => {
    for (const s of ALL_SCOPES) {
      expect(scopeGrants([], s)).toBe(false);
    }
  });

  test('multiple scopes union without implying admin', () => {
    const held: Scope[] = ['sessions:read', 'workflows:write'];
    expect(scopeGrants(held, 'sessions:read')).toBe(true);
    expect(scopeGrants(held, 'workflows:write')).toBe(true);
    expect(scopeGrants(held, 'sessions:write')).toBe(false);
    expect(scopeGrants(held, 'admin')).toBe(false);
    expect(effectiveScopes(held)).toEqual(['sessions:read', 'workflows:write']);
  });
});

describe('routeAuth — exhaustive mapping for every RouteName', () => {
  const expected: Record<RouteName, ReturnType<typeof routeAuth>> = {
    health: { type: 'public' },
    whoami: { type: 'authenticated' },
    'sessions.list': { type: 'scope', scope: 'sessions:read' },
    'sessions.get': { type: 'scope', scope: 'sessions:read' },
    'sessions.read': { type: 'scope', scope: 'sessions:read' },
    'sessions.spawn': { type: 'scope', scope: 'sessions:write' },
    'sessions.send': { type: 'scope', scope: 'sessions:write' },
    'sessions.wait': { type: 'scope', scope: 'sessions:write' },
    'sessions.kill': { type: 'scope', scope: 'admin' },
    'workflows.runs.list': { type: 'scope', scope: 'workflows:read' },
    'workflows.runs.get': { type: 'scope', scope: 'workflows:read' },
    'workflows.runs.logs': { type: 'scope', scope: 'workflows:read' },
    'workflows.run': { type: 'scope', scope: 'workflows:write' },
    'workflows.runs.resume': { type: 'scope', scope: 'workflows:write' },
    'workflows.runs.retry': { type: 'scope', scope: 'workflows:write' },
    'workflows.runs.cancel': { type: 'scope', scope: 'admin' },
    'workflows.runs.cleanup': { type: 'scope', scope: 'admin' },
  };

  test('every route has an explicit mapping', () => {
    for (const [name, auth] of Object.entries(expected) as [RouteName, ReturnType<typeof routeAuth>][]) {
      expect(routeAuth(name)).toEqual(auth);
    }
  });
});

describe('authenticate — fail closed (401)', () => {
  test('allowlisted identity → all-scopes identity principal', () => {
    const r = authenticate({
      identity: { node: 'mini.taila038d5.ts.net' },
      allowlist: ['mini'],
      presentedSecret: null,
      configuredSecret: null,
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.kind).toBe('identity');
      expect(scopeGrants(r.principal.scopes, 'admin')).toBe(true);
    }
  });

  test('valid bearer token → token principal with configured scopes only', () => {
    const tokens = new Map<string, readonly Scope[]>([['tok-read', ['sessions:read']]]);
    const r = authenticate({
      identity: null,
      allowlist: [],
      presentedSecret: null,
      configuredSecret: null,
      presentedBearer: 'tok-read',
      tokens,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal).toEqual({ kind: 'token', scopes: ['sessions:read'] });
    }
  });

  test('valid legacy secret → all-scopes legacy_secret principal', () => {
    const r = authenticate({
      identity: null,
      allowlist: [],
      presentedSecret: 's3cret',
      configuredSecret: 's3cret',
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.kind).toBe('legacy_secret');
      expect(scopeGrants(r.principal.scopes, 'admin')).toBe(true);
    }
  });

  test('no credentials and no identity → 401', () => {
    const r = authenticate({
      identity: null,
      allowlist: ['mini'],
      presentedSecret: null,
      configuredSecret: 's3cret',
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r).toEqual({
      ok: false,
      status: 401,
      message: 'unauthorized: authentication required',
    });
  });

  test('wrong secret → 401 (not 403)', () => {
    const r = authenticate({
      identity: null,
      allowlist: [],
      presentedSecret: 'nope',
      configuredSecret: 's3cret',
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.message).toMatch(/invalid credentials/);
      expect(r.message).not.toMatch(/s3cret|nope/);
    }
  });

  test('invalid bearer → 401 and message does not echo token', () => {
    const tokens = new Map<string, readonly Scope[]>([['good', ['admin']]]);
    const r = authenticate({
      identity: null,
      allowlist: [],
      presentedSecret: null,
      configuredSecret: null,
      presentedBearer: 'bad-token-value',
      tokens,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(JSON.stringify(r)).not.toContain('bad-token-value');
      expect(JSON.stringify(r)).not.toContain('good');
    }
  });

  test('non-allowlisted identity without credentials → 401', () => {
    const r = authenticate({
      identity: { node: 'stranger.ts.net' },
      allowlist: ['mini'],
      presentedSecret: null,
      configuredSecret: null,
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('identity wins over invalid token (still authenticated as identity)', () => {
    const tokens = new Map<string, readonly Scope[]>([['good', ['sessions:read']]]);
    const r = authenticate({
      identity: { node: 'mini.taila038d5.ts.net' },
      allowlist: ['mini'],
      presentedSecret: null,
      configuredSecret: null,
      presentedBearer: 'wrong',
      tokens,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principal.kind).toBe('identity');
  });

  test('empty configured secret never authenticates via secret path', () => {
    const r = authenticate({
      identity: null,
      allowlist: [],
      presentedSecret: '',
      configuredSecret: '',
      presentedBearer: null,
      tokens: emptyTokens,
    });
    expect(r.ok).toBe(false);
  });
});

describe('authorize — insufficient scope → 403', () => {
  test('whoami (authenticated) allows any principal', () => {
    const p = { kind: 'token' as const, scopes: [] as Scope[] };
    expect(authorize(p, { type: 'authenticated' }).ok).toBe(true);
  });

  test('sessions:read principal denied sessions:write', () => {
    const p = { kind: 'token' as const, scopes: ['sessions:read'] as Scope[] };
    const r = authorize(p, { type: 'scope', scope: 'sessions:write' });
    expect(r).toEqual({
      ok: false,
      status: 403,
      message: "forbidden: principal lacks required scope 'sessions:write'",
    });
  });

  test('admin principal allowed for kill (admin scope)', () => {
    const p = { kind: 'legacy_secret' as const, scopes: ['admin'] as Scope[] };
    expect(authorize(p, { type: 'scope', scope: 'admin' }).ok).toBe(true);
  });

  test('write principal denied kill (admin)', () => {
    const p = { kind: 'token' as const, scopes: ['sessions:write'] as Scope[] };
    const r = authorize(p, { type: 'scope', scope: 'admin' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe('reportPrincipal — never includes credentials', () => {
  test('token principal reports kind + scopes only', () => {
    const report = reportPrincipal({ kind: 'token', scopes: ['sessions:read'] });
    expect(report).toEqual({ kind: 'token', scopes: ['sessions:read'] });
    // kind may be the string "token"; ensure no credential material is present.
    expect(JSON.stringify(report)).not.toMatch(/Bearer |x-orc-secret|ORC_DAEMON/i);
    expect(report).not.toHaveProperty('token');
    expect(report).not.toHaveProperty('secret');
  });

  test('identity principal reports node', () => {
    expect(reportPrincipal({ kind: 'identity', node: 'mini.ts.net', scopes: ['admin'] })).toEqual({
      kind: 'identity',
      node: 'mini.ts.net',
      scopes: [...ALL_SCOPES],
    });
  });
});

describe('extractBearerToken / matchBearerToken / safeEqual', () => {
  test('parses Bearer header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  test('rejects malformed Bearer headers with trailing fields', () => {
    expect(extractBearerToken('Bearer token extra')).toBeNull();
  });

  test('matchBearerToken returns scopes without leaking token', () => {
    const tokens = new Map<string, readonly Scope[]>([
      ['alpha', ['sessions:read']],
      ['beta', ['admin']],
    ]);
    expect(matchBearerToken('beta', tokens)).toEqual(['admin']);
    expect(matchBearerToken('nope', tokens)).toBeNull();
  });

  test('safeEqual is true only for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('parseDaemonTokensJson — startup validation', () => {
  test('parses token → scopes object', () => {
    const m = parseDaemonTokensJson(
      JSON.stringify({ 't1': ['sessions:read', 'workflows:read'], 't2': ['admin'] }),
    );
    expect(m.get('t1')).toEqual(['sessions:read', 'workflows:read']);
    expect(m.get('t2')).toEqual(['admin']);
  });

  test('rejects unknown scope', () => {
    expect(() => parseDaemonTokensJson(JSON.stringify({ t: ['sessions:admin'] }))).toThrow(
      /unknown scope/,
    );
  });

  test('rejects non-object', () => {
    expect(() => parseDaemonTokensJson('[]')).toThrow(/JSON object/);
    expect(() => parseDaemonTokensObject('nope')).toThrow(/JSON object/);
  });

  test('rejects invalid JSON', () => {
    expect(() => parseDaemonTokensJson('{')).toThrow(/not valid JSON/);
  });
});
