/**
 * Bind-address safety — the layer-1 security boundary, kept PURE so it's unit-testable.
 *
 * The daemon's real security primitive is binding to the host's tailscale interface: the
 * WireGuard tailnet will not route a `100.x` address from off-tailnet, so a daemon bound
 * there is unreachable except by trusted peers. A stray PUBLIC bind (`0.0.0.0`, a LAN IP)
 * would defeat that, so it must be impossible by default. We refuse to start on any
 * non-loopback, non-tailscale address unless `--insecure` is given explicitly.
 */

/** A loopback address never leaves the host, so it's always safe for local testing. */
export function isLoopback(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  if (a === '::1') return true;
  // 127.0.0.0/8 — any 127.x.y.z. (0.0.0.0 is "all interfaces", NOT loopback → refused.)
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || a === '127.0.0.1';
}

export type BindDecision =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Decide what address the daemon should bind to.
 *
 *  - explicit `--bind`:
 *      * `--insecure`            → trust the operator, bind anywhere.
 *      * loopback               → allowed (local testing; never leaves the host).
 *      * == the tailscale IP    → allowed (the intended secure bind).
 *      * anything else (0.0.0.0, a LAN/public IP) → REFUSE unless `--insecure`.
 *  - no `--bind` (default): bind to the discovered tailscale IP; if none could be
 *    discovered, REFUSE (do NOT silently fall back to a broad bind) and tell the operator
 *    to pass `--bind 127.0.0.1` for local use or `--insecure` to override.
 */
export function resolveBind(opts: {
  bind?: string;
  insecure: boolean;
  tailscaleIp: string | null;
}): BindDecision {
  const { bind, insecure, tailscaleIp } = opts;

  if (bind !== undefined && bind.length > 0) {
    if (insecure) return { ok: true, address: bind };
    if (isLoopback(bind)) return { ok: true, address: bind };
    if (tailscaleIp && bind === tailscaleIp) return { ok: true, address: bind };
    return {
      ok: false,
      error:
        `refusing to bind to '${bind}': not loopback and not this host's tailscale IP` +
        `${tailscaleIp ? ` (${tailscaleIp})` : ' (none discovered)'}. ` +
        `The daemon is meant to be reachable only over tailscale. Use --bind 127.0.0.1 ` +
        `for local testing, --bind ${tailscaleIp ?? '<tailscale-ip>'} for the tailnet, ` +
        `or --insecure to override (DANGEROUS — exposes the agent-control API).`,
    };
  }

  // Default: the tailscale IP, never 0.0.0.0.
  if (tailscaleIp) return { ok: true, address: tailscaleIp };
  return {
    ok: false,
    error:
      'could not discover a tailscale IP (`tailscale ip -4` returned nothing). ' +
      'Refusing to start rather than fall back to a public bind. Pass --bind 127.0.0.1 ' +
      'for local testing, or --insecure with an explicit --bind to override.',
  };
}
