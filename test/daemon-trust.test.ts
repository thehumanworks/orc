import { describe, test, expect } from 'bun:test';
import { decideTrust, isAllowlisted } from '../src/daemon/trust.ts';
import type { Identity } from '../src/daemon/trust.ts';
import { resolveBind, isLoopback } from '../src/daemon/bind.ts';
import { parseWhoisJson } from '../src/daemon/tailscale.ts';

/**
 * The trust gate is the security boundary, so its DENY cases are tested EXHAUSTIVELY here
 * (the task's non-negotiable: fail closed). All pure — no socket, no subprocess.
 */

const node: Identity = { node: 'mini.taila038d5.ts.net', user: 'tomas@example.com' };
const ALLOW = ['mini', 'laptop.taila038d5.ts.net'];

describe('decideTrust — FAIL CLOSED (exhaustive deny + allow cases)', () => {
  test('allowlisted node → ALLOW (no secret needed)', () => {
    expect(decideTrust(node, ALLOW, null, null)).toBe(true);
  });

  test('valid secret → ALLOW (no identity needed)', () => {
    expect(decideTrust(null, ALLOW, 's3cret', 's3cret')).toBe(true);
  });

  test('whois-unavailable (null identity) AND no secret configured → DENY', () => {
    // The explicit "do NOT degrade to allow because no auth mechanism is available" case.
    expect(decideTrust(null, ALLOW, null, null)).toBe(false);
  });

  test('whois resolves a NON-allowlisted node (no secret) → DENY', () => {
    expect(decideTrust({ node: 'stranger.taila038d5.ts.net' }, ALLOW, null, null)).toBe(false);
  });

  test('no identity + WRONG secret → DENY', () => {
    expect(decideTrust(null, ALLOW, 'wrong', 's3cret')).toBe(false);
  });

  test('no identity + ABSENT secret while one IS configured → DENY', () => {
    expect(decideTrust(null, ALLOW, null, 's3cret')).toBe(false);
  });

  test('EMPTY configured secret is treated as NOT configured → DENY even on empty match', () => {
    // A blank ORC_DAEMON_SECRET must never become an open door.
    expect(decideTrust(null, ALLOW, '', '')).toBe(false);
    expect(decideTrust(null, ALLOW, '', null)).toBe(false);
  });

  test('non-allowlisted node BUT valid secret → ALLOW (secret is the fallback)', () => {
    expect(decideTrust({ node: 'stranger.ts.net' }, ALLOW, 's3cret', 's3cret')).toBe(true);
  });

  test('empty allowlist + any identity (no secret) → DENY', () => {
    expect(decideTrust(node, [], null, null)).toBe(false);
  });
});

describe('isAllowlisted — flexible host matching', () => {
  test('matches the short label against an FQDN whois result', () => {
    expect(isAllowlisted(node, ['mini'])).toBe(true);
  });
  test('matches the full FQDN (trailing dot + case-insensitive)', () => {
    expect(isAllowlisted({ node: 'Mini.Taila038d5.TS.net.' }, ['mini.taila038d5.ts.net'])).toBe(true);
  });
  test('does not match a different node', () => {
    expect(isAllowlisted({ node: 'other.taila038d5.ts.net' }, ['mini'])).toBe(false);
  });
  test('empty allowlist never matches', () => {
    expect(isAllowlisted(node, [])).toBe(false);
  });
  test('an empty node name never matches', () => {
    expect(isAllowlisted({ node: '' }, ['mini'])).toBe(false);
  });
});

describe('resolveBind — never a stray public bind by default', () => {
  const ts = '100.121.57.112';

  test('0.0.0.0 is REFUSED without --insecure', () => {
    const d = resolveBind({ bind: '0.0.0.0', insecure: false, tailscaleIp: ts });
    expect(d.ok).toBe(false);
  });
  test('127.0.0.1 (loopback) is allowed', () => {
    expect(resolveBind({ bind: '127.0.0.1', insecure: false, tailscaleIp: ts })).toEqual({
      ok: true,
      address: '127.0.0.1',
    });
  });
  test('::1 (loopback) is allowed', () => {
    expect(resolveBind({ bind: '::1', insecure: false, tailscaleIp: ts }).ok).toBe(true);
  });
  test('the tailscale IP is allowed', () => {
    expect(resolveBind({ bind: ts, insecure: false, tailscaleIp: ts })).toEqual({
      ok: true,
      address: ts,
    });
  });
  test('a LAN IP is REFUSED without --insecure', () => {
    expect(resolveBind({ bind: '192.168.1.50', insecure: false, tailscaleIp: ts }).ok).toBe(false);
  });
  test('--insecure overrides the refusal (operator opt-in)', () => {
    expect(resolveBind({ bind: '0.0.0.0', insecure: true, tailscaleIp: ts })).toEqual({
      ok: true,
      address: '0.0.0.0',
    });
  });
  test('default (no --bind) binds to the tailscale IP', () => {
    expect(resolveBind({ insecure: false, tailscaleIp: ts })).toEqual({ ok: true, address: ts });
  });
  test('default with NO tailscale IP REFUSES (does not fall back to a broad bind)', () => {
    expect(resolveBind({ insecure: false, tailscaleIp: null }).ok).toBe(false);
  });

  test('isLoopback: 127.x yes, 0.0.0.0 no', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.5.6.7')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('100.121.57.112')).toBe(false);
  });
});

describe('parseWhoisJson — fail closed on anything unexpected', () => {
  test('parses a node name (success)', () => {
    const out = JSON.stringify({
      Node: { Name: 'mini.taila038d5.ts.net.' },
      UserProfile: { LoginName: 'tomas@example.com' },
    });
    expect(parseWhoisJson(out)).toEqual({ node: 'mini.taila038d5.ts.net.', user: 'tomas@example.com' });
  });
  test('empty stdout (peer-not-found writes to stderr) → null', () => {
    expect(parseWhoisJson('')).toBeNull();
    expect(parseWhoisJson('   \n')).toBeNull();
  });
  test('non-JSON → null', () => {
    expect(parseWhoisJson('peer not found')).toBeNull();
  });
  test('JSON without a Node name → null', () => {
    expect(parseWhoisJson(JSON.stringify({ Node: {} }))).toBeNull();
    expect(parseWhoisJson(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});
