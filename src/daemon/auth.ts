/**
 * Scoped daemon authorization — pure decision layer (no sockets, no I/O).
 *
 * Principals are authenticated via allowlisted tailnet identity, a legacy shared
 * secret (`x-orc-secret` / `ORC_DAEMON_SECRET`), or a bearer token
 * (`Authorization: Bearer` / `ORC_DAEMON_TOKEN`) with an explicit scope set.
 *
 * FAIL CLOSED: no trusted identity and no valid credential → 401.
 * Authenticated principal lacking the route's required scope → 403.
 * `admin` implies every other scope. Never log or return token/secret values.
 */
import { timingSafeEqual } from 'node:crypto';
import type { RouteName } from './routes.ts';
import { isAllowlisted } from './trust.ts';
import type { Identity } from './trust.ts';

/** Fine-grained scopes a bearer token may hold. `admin` grants every scope. */
export type Scope =
  | 'sessions:read'
  | 'sessions:write'
  | 'workflows:read'
  | 'workflows:write'
  | 'admin';

export const ALL_SCOPES: readonly Scope[] = [
  'sessions:read',
  'sessions:write',
  'workflows:read',
  'workflows:write',
  'admin',
] as const;

const SCOPE_SET = new Set<string>(ALL_SCOPES);

/** Every non-admin scope — what `admin` expands to for implication checks. */
export const NON_ADMIN_SCOPES: readonly Scope[] = ALL_SCOPES.filter((s) => s !== 'admin');

/**
 * Authenticated caller. Credentials themselves are NEVER stored here — only the
 * principal kind, optional identity node, and effective scopes.
 */
export type Principal =
  | { kind: 'identity'; node: string; scopes: readonly Scope[] }
  | { kind: 'legacy_secret'; scopes: readonly Scope[] }
  | { kind: 'token'; scopes: readonly Scope[] };

/** Public report shape for `/whoami` (no secrets). */
export interface PrincipalReport {
  kind: Principal['kind'];
  node?: string;
  scopes: Scope[];
}

/** Required authorization for a route after authentication. */
export type RouteAuth =
  | { type: 'public' }
  | { type: 'authenticated' }
  | { type: 'scope'; scope: Scope };

/** All-scopes set granted to identity + legacy-secret principals. */
export const ALL_GRANTED_SCOPES: readonly Scope[] = ALL_SCOPES;

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

/**
 * Does `held` grant `required`? `admin` implies every scope (including itself).
 * Pure and exhaustive for the known Scope set.
 */
export function scopeGrants(held: readonly Scope[], required: Scope): boolean {
  if (held.includes('admin')) return true;
  return held.includes(required);
}

/** Expand held scopes for reporting: admin → full list, else unique held. */
export function effectiveScopes(held: readonly Scope[]): Scope[] {
  if (held.includes('admin')) return [...ALL_SCOPES];
  const out: Scope[] = [];
  for (const s of ALL_SCOPES) {
    if (held.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Explicit route → required-auth mapping. Every authenticated route is covered;
 * `/health` is public. Read/list/get/log → read; spawn/send/wait/run/resume/retry
 * → write; kill/cancel/cleanup → admin. `/whoami` needs any authenticated principal.
 */
export function routeAuth(route: RouteName): RouteAuth {
  switch (route) {
    case 'health':
      return { type: 'public' };
    case 'whoami':
      return { type: 'authenticated' };
    case 'sessions.list':
    case 'sessions.get':
    case 'sessions.read':
      return { type: 'scope', scope: 'sessions:read' };
    case 'sessions.spawn':
    case 'sessions.send':
    case 'sessions.wait':
      return { type: 'scope', scope: 'sessions:write' };
    case 'sessions.kill':
      return { type: 'scope', scope: 'admin' };
    case 'workflows.runs.list':
    case 'workflows.runs.get':
    case 'workflows.runs.logs':
      return { type: 'scope', scope: 'workflows:read' };
    case 'workflows.run':
    case 'workflows.runs.resume':
    case 'workflows.runs.retry':
      return { type: 'scope', scope: 'workflows:write' };
    case 'workflows.runs.cancel':
    case 'workflows.runs.cleanup':
      return { type: 'scope', scope: 'admin' };
  }
}

/** Public report of a principal (scopes expanded; no credentials). */
export function reportPrincipal(principal: Principal): PrincipalReport {
  const scopes = effectiveScopes(principal.scopes);
  if (principal.kind === 'identity') {
    return { kind: 'identity', node: principal.node, scopes };
  }
  return { kind: principal.kind, scopes };
}

/**
 * Timing-safe string compare. Different lengths always return false after a
 * dummy compare so ordinary `===` length oracles are avoided where feasible.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Touch both buffers so length-mismatch is not a pure early return.
    if (ab.length > 0) timingSafeEqual(ab, ab);
    if (bb.length > 0) timingSafeEqual(bb, bb);
    return false;
  }
  if (ab.length === 0) return true;
  return timingSafeEqual(ab, bb);
}

/**
 * Look up a presented bearer among configured tokens with per-entry timing-safe
 * compare. Returns the scopes for the matching token, or null. Does not return
 * the token string.
 */
export function matchBearerToken(
  presented: string,
  tokens: ReadonlyMap<string, readonly Scope[]>,
): readonly Scope[] | null {
  if (presented.length === 0 || tokens.size === 0) return null;
  let matched: readonly Scope[] | null = null;
  for (const [token, scopes] of tokens) {
    if (safeEqual(presented, token)) {
      // Prefer the first match; continue iterating so scan cost is closer to full map size.
      if (matched === null) matched = scopes;
    }
  }
  return matched;
}

export interface AuthenticateInput {
  identity: Identity | null;
  allowlist: string[];
  /** Raw `x-orc-secret` header value, or null if absent. */
  presentedSecret: string | null;
  /** Configured legacy secret; null/empty = not configured. */
  configuredSecret: string | null;
  /** Bearer token from `Authorization: Bearer …`, or null if absent. */
  presentedBearer: string | null;
  /** token string → scopes. Empty map = no bearer tokens configured. */
  tokens: ReadonlyMap<string, readonly Scope[]>;
}

export type AuthenticateResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401; message: string };

/**
 * Authenticate a request. Prefer allowlisted identity (all scopes), then a
 * matching bearer token, then a matching legacy secret (all scopes).
 * Invalid or missing credentials without a trusted identity → 401.
 */
export function authenticate(input: AuthenticateInput): AuthenticateResult {
  const {
    identity,
    allowlist,
    presentedSecret,
    configuredSecret,
    presentedBearer,
    tokens,
  } = input;

  if (identity && isAllowlisted(identity, allowlist)) {
    return {
      ok: true,
      principal: { kind: 'identity', node: identity.node, scopes: ALL_GRANTED_SCOPES },
    };
  }

  const hasBearer = presentedBearer !== null && presentedBearer.length > 0;
  if (hasBearer) {
    const scopes = matchBearerToken(presentedBearer!, tokens);
    if (scopes) {
      return { ok: true, principal: { kind: 'token', scopes } };
    }
  }

  const secretConfigured = Boolean(configuredSecret && configuredSecret.length > 0);
  const hasSecretHeader = presentedSecret !== null;
  if (secretConfigured && hasSecretHeader && safeEqual(presentedSecret!, configuredSecret!)) {
    return {
      ok: true,
      principal: { kind: 'legacy_secret', scopes: ALL_GRANTED_SCOPES },
    };
  }

  // Credentials were attempted but did not authenticate, or nothing was presented.
  const attempted =
    hasBearer ||
    (hasSecretHeader && presentedSecret!.length > 0) ||
    (hasSecretHeader && secretConfigured);
  if (attempted) {
    return {
      ok: false,
      status: 401,
      message: 'unauthorized: invalid credentials',
    };
  }
  return {
    ok: false,
    status: 401,
    message: 'unauthorized: authentication required',
  };
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; status: 403; message: string };

/**
 * Authorize an authenticated principal for a route. Public routes should be
 * short-circuited before auth. `authenticated` routes only require a principal.
 */
export function authorize(principal: Principal, auth: RouteAuth): AuthorizeResult {
  if (auth.type === 'public' || auth.type === 'authenticated') {
    return { ok: true };
  }
  if (scopeGrants(principal.scopes, auth.scope)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    message: `forbidden: principal lacks required scope '${auth.scope}'`,
  };
}

/**
 * Parse `Authorization` header for a Bearer token. Returns the raw token string
 * or null when the header is absent/not Bearer. Does not validate the token.
 */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  if (!m) return null;
  const token = m[1]!;
  return token.length > 0 ? token : null;
}

/**
 * Parse and validate the daemon token map from a JSON string (env
 * `ORC_DAEMON_TOKENS`). Format: `{ "<token>": ["sessions:read", ...], ... }`.
 * Throws a clear Error on invalid JSON or unknown scopes (fail at startup).
 */
export function parseDaemonTokensJson(raw: string): Map<string, Scope[]> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `ORC_DAEMON_TOKENS is not valid JSON: ${(e as Error).message}`,
    );
  }
  return parseDaemonTokensObject(data, 'ORC_DAEMON_TOKENS');
}

/**
 * Validate a tokens object (already-parsed). Keys are token strings; values are
 * scope arrays. Empty tokens or unknown scopes throw.
 */
export function parseDaemonTokensObject(
  data: unknown,
  label = 'tokens',
): Map<string, Scope[]> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} must be a JSON object mapping token → scope array`);
  }
  const out = new Map<string, Scope[]>();
  for (const [token, scopesRaw] of Object.entries(data as Record<string, unknown>)) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`${label}: token keys must be non-empty strings`);
    }
    if (!Array.isArray(scopesRaw)) {
      throw new Error(`${label}: scopes for a token must be an array of scope strings`);
    }
    const scopes: Scope[] = [];
    for (const s of scopesRaw) {
      if (!isScope(s)) {
        throw new Error(
          `${label}: unknown scope '${String(s)}' (expected one of ${ALL_SCOPES.join(', ')})`,
        );
      }
      if (!scopes.includes(s)) scopes.push(s);
    }
    out.set(token, scopes);
  }
  return out;
}

/**
 * Load tokens from env: `ORC_DAEMON_TOKENS` JSON object. Missing/empty → empty map.
 * Invalid → throws (daemon must fail closed at startup).
 */
export function loadDaemonTokensFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, Scope[]> {
  const raw = env.ORC_DAEMON_TOKENS;
  if (raw === undefined || raw.trim().length === 0) return new Map();
  return parseDaemonTokensJson(raw);
}
