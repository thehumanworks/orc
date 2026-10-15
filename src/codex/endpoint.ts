/**
 * OpenAI endpoints used by the codex harness, plus the offline test seam.
 *
 * `ORC_CODEX_TEST_ENDPOINT=http://127.0.0.1:<port>` redirects every request the harness
 * (and `orc login`) makes to `https://api.openai.com` and `https://auth.openai.com` to that
 * LOOPBACK origin, path unchanged — so the real request shaping (Sign in with ChatGPT field
 * omission, headers, token refresh) is exercised against a local fake. Only loopback http
 * origins are accepted; anything else is ignored with an error.
 */
export const OPENAI_API_BASE = 'https://api.openai.com/v1';
const REDIRECTED_ORIGINS = ['https://api.openai.com', 'https://auth.openai.com'];

export const TEST_ENDPOINT_ENV = 'ORC_CODEX_TEST_ENDPOINT';

/** The loopback override origin, or undefined. Throws on a non-loopback value. */
export function testEndpoint(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[TEST_ENDPOINT_ENV];
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${TEST_ENDPOINT_ENV} is not a URL: ${raw}`);
  }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(`${TEST_ENDPOINT_ENV} must be a loopback http origin (got ${u.origin})`);
  }
  return u.origin;
}

type FetchFn = typeof fetch;

/** Rewrite one URL to the override origin when it targets an OpenAI origin. */
export function rewriteUrl(url: string, override: string): string {
  for (const origin of REDIRECTED_ORIGINS) {
    if (url === origin || url.startsWith(`${origin}/`)) return override + url.slice(origin.length);
  }
  return url;
}

/** A fetch that applies the override (identity when there is none). */
export function harnessFetch(base: FetchFn, override: string | undefined): FetchFn {
  if (!override) return base;
  const wrapped = ((input: Parameters<FetchFn>[0], init?: RequestInit) => {
    if (typeof input === 'string') return base(rewriteUrl(input, override), init);
    if (input instanceof URL) return base(rewriteUrl(input.toString(), override), init);
    const req = input as Request;
    const next = rewriteUrl(req.url, override);
    return base(next === req.url ? req : new Request(next, req), init);
  }) as FetchFn;
  return Object.assign(wrapped, { preconnect: base.preconnect }) as FetchFn;
}

/**
 * Install the override on globalThis.fetch for this process (pi-ai's OAuth token refresh
 * uses the global fetch). Returns the fetch to pass explicitly to request options.
 */
export function installTestEndpoint(env: Record<string, string | undefined> = process.env): FetchFn {
  const override = testEndpoint(env);
  const f = harnessFetch(globalThis.fetch, override);
  if (override) globalThis.fetch = f;
  return f;
}
