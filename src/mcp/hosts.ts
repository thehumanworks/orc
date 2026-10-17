/**
 * The DNS-rebinding guard of the daemon's `/mcp` endpoint, kept PURE (no SDK, no I/O) so it
 * is unit-testable and the daemon can derive its allowlist at startup without loading MCP.
 *
 * A request is served only when its `Host` names this daemon and its `Origin` (sent by
 * browsers only; CLI/agent MCP clients send none) is absent or names this daemon too:
 * same-origin only. Names are compared without the port, like the MCP SDK's helpers —
 * rebinding and cross-site attacks come from foreign host names, whatever the port.
 */
import { isLoopback } from '../daemon/bind.ts';
import type { TailnetSelf } from '../daemon/tailscale.ts';

/** Where `orc daemon` serves MCP (Streamable HTTP). */
export const MCP_PATH = '/mcp';

/** Loopback names (as URL hostnames: IPv6 bracketed). */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** `URL.hostname` of `host` (a Host header value: name[:port]), lower-cased, no trailing dot; null if unparsable. */
export function hostnameOf(host: string): string | null {
  const s = host.trim();
  if (s.length === 0 || /[\s/\\@?#]/.test(s)) return null;
  try {
    const name = new URL(`http://${s}`).hostname.replace(/\.$/, '').toLowerCase();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Normalize one allowlist entry (a host name or IP, optionally with a port, which is
 * ignored): IPv6 literals are bracketed. Throws a clear error on anything else (a scheme,
 * a path, whitespace, an empty value).
 */
export function normalizeAllowedHost(raw: string): string {
  let s = raw.trim();
  // A bare IPv6 literal (more than one colon, no brackets): bracket it for URL parsing.
  if (!s.startsWith('[') && (s.match(/:/g) ?? []).length > 1) s = `[${s}]`;
  const name = hostnameOf(s);
  if (name === null) throw new Error(`invalid host '${raw}' (a host name or IP, without scheme or path)`);
  return name;
}

/** The address a daemon bound to "every interface" (`--insecure --bind 0.0.0.0` / `::`). */
function isWildcard(bind: string): boolean {
  const b = bind.trim();
  return b === '0.0.0.0' || b === '::' || b === '[::]';
}

/**
 * Host names `/mcp` accepts, for a daemon bound to `bind`:
 *  - the bound address itself (unless it is a wildcard);
 *  - loopback names when bound to loopback (or a wildcard);
 *  - this node's MagicDNS FQDN, its short label and its tailnet IPs when bound to a
 *    tailnet IP (or a wildcard) — `tailnet` is what `tailscale status --json` reports;
 *  - every `extra` entry (`orc daemon --mcp-allow-host`), e.g. a DNS alias or a proxy name.
 */
export function mcpAllowedHosts(opts: {
  bind: string;
  tailnet?: TailnetSelf | null;
  extra?: readonly string[];
}): string[] {
  const out = new Set<string>();
  const add = (h: string | null | undefined): void => {
    if (!h) return;
    try {
      out.add(normalizeAllowedHost(h));
    } catch {
      /* not a usable name (e.g. an empty DNS name): skip */
    }
  };
  const wildcard = isWildcard(opts.bind);
  if (!wildcard) add(opts.bind);
  if (wildcard || isLoopback(opts.bind) || opts.bind.trim().toLowerCase() === 'localhost') {
    for (const h of LOOPBACK_HOSTNAMES) add(h);
  }
  const t = opts.tailnet;
  if (t && (wildcard || t.ips.includes(opts.bind.trim()))) {
    if (t.dnsName) {
      add(t.dnsName);
      add(t.dnsName.split('.')[0]);
    }
    for (const ip of t.ips) add(ip);
  }
  for (const e of opts.extra ?? []) out.add(normalizeAllowedHost(e));
  return [...out];
}

/** Why a request's `Host` is refused (null = allowed). */
export function hostRejection(hostHeader: string | null, allowed: readonly string[]): string | null {
  if (hostHeader === null || hostHeader.trim().length === 0) return 'Missing Host header';
  const name = hostnameOf(hostHeader);
  if (name === null) return `Invalid Host header: ${hostHeader}`;
  return allowed.includes(name) ? null : `Invalid Host: ${name}`;
}

/**
 * Why a request's `Origin` is refused (null = allowed). Absent/empty passes (non-browser
 * clients send none); anything present must be an http(s) origin naming an allowed host —
 * the opaque `null` origin and other schemes are refused.
 */
export function originRejection(originHeader: string | null, allowed: readonly string[]): string | null {
  if (originHeader === null || originHeader.length === 0) return null;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return `Invalid Origin header: ${originHeader}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `Invalid Origin: ${originHeader}`;
  const name = url.hostname.replace(/\.$/, '').toLowerCase();
  return name.length > 0 && allowed.includes(name) ? null : `Invalid Origin: ${name || originHeader}`;
}

/** The 403 an MCP client understands (a JSON-RPC error body, as the MCP SDK's own guards send). */
export function forbiddenMcpResponse(message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}
