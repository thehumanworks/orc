/**
 * Thin subprocess wrappers over the `tailscale` CLI. These are the IMPURE edge; the
 * parsing that matters for the trust gate is factored into the PURE `parseWhoisJson`
 * (unit-tested on canned output). Every wrapper FAILS CLOSED: any error — binary missing,
 * non-zero exit, empty/unparseable output — resolves to `null`, never a guessed identity.
 */
import type { Identity } from './trust.ts';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `tailscale <args...>` with array argv (no shell). Never throws. */
async function tailscale(args: string[]): Promise<RunResult | null> {
  try {
    const proc = Bun.spawn(['tailscale', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch {
    // Binary not on PATH, spawn error, etc.
    return null;
  }
}

/**
 * Discover this host's tailscale IPv4 (`tailscale ip -4`). Returns the first `100.x`
 * address, or null if tailscale isn't up / not installed. The daemon binds here by default.
 */
export async function tailscaleIp4(): Promise<string | null> {
  const r = await tailscale(['ip', '-4']);
  if (!r || r.code !== 0) return null;
  for (const line of r.stdout.split('\n')) {
    const ip = line.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return null;
}

/**
 * PURE: parse `tailscale whois --json <ip>` stdout into an Identity, or null when it does
 * not resolve a node. The success shape is `{ Node: { Name }, UserProfile?: { LoginName } }`
 * (Name is a MagicDNS FQDN with a trailing dot, which `isAllowlisted` normalizes away).
 * Anything missing a node name → null (fail closed). Never throws.
 */
export function parseWhoisJson(stdout: string): Identity | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const node = obj.Node as Record<string, unknown> | undefined;
  const name = node && typeof node.Name === 'string' ? node.Name : undefined;
  if (!name || name.trim().length === 0) return null;
  const profile = obj.UserProfile as Record<string, unknown> | undefined;
  const user =
    profile && typeof profile.LoginName === 'string' ? profile.LoginName : undefined;
  return { node: name, ...(user ? { user } : {}) };
}

/**
 * Resolve a request's source IP to a tailnet Identity via `tailscale whois --json`.
 * Returns null on ANY failure (no IP, whois unavailable, peer-not-found, unparseable) —
 * the gate treats null as "unknown identity → DENY unless a valid secret is presented".
 *
 * NOTE: `tailscale whois` cannot resolve a loopback address, so on a `127.0.0.1` daemon
 * this always returns null — the whois+allowlist path gets ZERO coverage on loopback and
 * MUST be exercised on a real two-host tailnet before being relied on.
 */
export async function whoisIdentity(ip: string | null): Promise<Identity | null> {
  if (!ip || ip.length === 0) return null;
  const r = await tailscale(['whois', '--json', ip]);
  if (!r || r.code !== 0) return null;
  return parseWhoisJson(r.stdout);
}
