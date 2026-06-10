/**
 * The trusted-peer store, `~/.orc/peers.json`. It serves a DUAL role:
 *  - on the SERVER: the allowlist of tailnet hostnames whose `tailscale whois` identity
 *    is permitted (the trust gate's `allowlist`).
 *  - on the CLIENT: the set of remote daemons `orc --host`/`--all-hosts` can talk to.
 *
 * Managed by `orc remote add|list|rm <host>`. Written atomically (tmp + rename), like the
 * session registry. A peer is a tailnet host plus an optional non-default port.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { orcHome, peersPath } from '../paths.ts';

/** The fixed default daemon port (overridable per peer and via `orc daemon --port`). */
export const DEFAULT_DAEMON_PORT = 8787;

export interface PeerEntry {
  /** Tailnet host (MagicDNS name or short label), e.g. `mini` or `mini.taila038d5.ts.net`. */
  host: string;
  /** Daemon port, if not the default 8787. */
  port?: number;
}

interface PeersFile {
  peers: PeerEntry[];
}

function normalizeHost(h: string): string {
  return h.trim().replace(/\.$/, '').toLowerCase();
}

/** Read the peer list. Missing/corrupt file => empty. */
export async function readPeers(): Promise<PeerEntry[]> {
  const f = Bun.file(peersPath());
  if (!(await f.exists())) return [];
  try {
    const data = (await f.json()) as unknown;
    if (!data || typeof data !== 'object') return [];
    const peers = (data as PeersFile).peers;
    if (!Array.isArray(peers)) return [];
    return peers.filter(
      (p): p is PeerEntry => !!p && typeof p.host === 'string' && p.host.length > 0,
    );
  } catch {
    return [];
  }
}

/** Write the peer list atomically (tmp + rename). */
export async function writePeers(peers: PeerEntry[]): Promise<void> {
  const home = orcHome();
  await fs.mkdir(home, { recursive: true });
  const target = peersPath();
  const tmp = path.join(home, `.peers.${randomUUID()}.tmp`);
  const body: PeersFile = { peers };
  await Bun.write(tmp, JSON.stringify(body, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Add (or update) a trusted peer, keyed by normalized host. Re-adding a host updates its
 * port. Returns the resulting entry.
 */
export async function addPeer(host: string, port?: number): Promise<PeerEntry> {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) throw new Error('remote add: host must be non-empty');
  const peers = await readPeers();
  const entry: PeerEntry = { host: normalized, ...(port ? { port } : {}) };
  const idx = peers.findIndex((p) => normalizeHost(p.host) === normalized);
  if (idx === -1) peers.push(entry);
  else peers[idx] = entry;
  await writePeers(peers);
  return entry;
}

/** Remove a trusted peer by host. Returns true if a peer was removed. */
export async function removePeer(host: string): Promise<boolean> {
  const normalized = normalizeHost(host);
  const peers = await readPeers();
  const next = peers.filter((p) => normalizeHost(p.host) !== normalized);
  if (next.length === peers.length) return false;
  await writePeers(next);
  return true;
}

/** The allowlist of trusted host names (for the daemon trust gate). */
export async function peerHosts(): Promise<string[]> {
  return (await readPeers()).map((p) => p.host);
}
