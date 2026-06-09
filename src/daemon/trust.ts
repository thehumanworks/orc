/**
 * The daemon trust gate — the security boundary, kept as a PURE decision so it can be
 * unit-tested EXHAUSTIVELY without a live socket.
 *
 * FAIL CLOSED is non-negotiable: a request is allowed ONLY IF the caller's tailscale
 * identity resolves to an ALLOWLISTED node, OR a valid shared secret is presented. In
 * EVERY other case (unknown/unresolvable identity, whois unavailable AND no secret
 * configured, wrong/absent secret) the answer is DENY. We never degrade to "allow"
 * because no auth mechanism happens to be available.
 */

/** A tailnet identity resolved from the request's source IP via `tailscale whois`. */
export interface Identity {
  /** The tailnet node name (MagicDNS FQDN), e.g. `mini.taila038d5.ts.net`. */
  node: string;
  /** The tailnet user, when whois reports one (informational; not used by the gate). */
  user?: string;
}

/** Lower-case + drop a trailing dot from a tailnet hostname for comparison. */
function normalizeHost(h: string): string {
  return h.trim().replace(/\.$/, '').toLowerCase();
}

/** First DNS label of a (possibly FQDN) hostname: `mini.taila038d5.ts.net` → `mini`. */
function shortLabel(h: string): string {
  return normalizeHost(h).split('.')[0] ?? '';
}

/**
 * Is the resolved identity's node in the allowlist? Matches flexibly so `agi remote add
 * mini` (stored as `mini`) authorizes a whois result of `mini.taila038d5.ts.net`: an
 * allowlist entry matches if, normalized, it equals the node's FQDN OR its short label.
 * An empty allowlist matches nothing (fail closed — the secret path is then the only way in).
 */
export function isAllowlisted(identity: Identity, allowlist: string[]): boolean {
  const node = normalizeHost(identity.node);
  if (node.length === 0) return false;
  const short = shortLabel(identity.node);
  return allowlist.some((raw) => {
    const a = normalizeHost(raw);
    if (a.length === 0) return false;
    return a === node || a === short;
  });
}

/**
 * The PURE trust decision. ALLOW iff:
 *   (identity resolves to an allowlisted node) OR (a valid secret is presented).
 *
 * A "valid secret" requires a secret to be configured (non-null AND non-empty — an empty
 * `configuredSecret` counts as NOT configured) and the presented secret to equal it.
 * Everything else is DENY.
 */
export function decideTrust(
  identity: Identity | null,
  allowlist: string[],
  presentedSecret: string | null,
  configuredSecret: string | null,
): boolean {
  // Identity path: a resolved, allowlisted tailnet node (the preferred mechanism).
  if (identity && isAllowlisted(identity, allowlist)) return true;
  // Secret path (explicit fallback for when whois is unavailable). An empty configured
  // secret is treated as "no secret configured" so it can never accidentally allow.
  if (configuredSecret && presentedSecret !== null && presentedSecret === configuredSecret) {
    return true;
  }
  return false;
}
