import { describe, test, expect } from 'bun:test';
import {
  sanitizeTmuxName,
  buildSpawnArgs,
  PANE_WIDTH,
  PANE_HEIGHT,
} from '../src/drivers/tmux.ts';

describe('sanitizeTmuxName', () => {
  test('keeps allowed chars', () => {
    expect(sanitizeTmuxName('codebase-recon_1')).toBe('codebase-recon_1');
  });
  test('replaces dots and colons (tmux-forbidden) with dash', () => {
    expect(sanitizeTmuxName('a.b:c')).toBe('a-b-c');
  });
  test('collapses runs of disallowed chars', () => {
    expect(sanitizeTmuxName('a   b')).toBe('a-b');
    expect(sanitizeTmuxName('a...b')).toBe('a-b');
  });
  test('trims leading/trailing dashes', () => {
    expect(sanitizeTmuxName('--foo--')).toBe('foo');
    expect(sanitizeTmuxName('.bar.')).toBe('bar');
  });
  test('falls back to "agent" on empty', () => {
    expect(sanitizeTmuxName('')).toBe('agent');
    expect(sanitizeTmuxName('...')).toBe('agent');
  });
  test('strips slashes and unicode', () => {
    expect(sanitizeTmuxName('orc/claude/❯box')).toBe('orc-claude-box');
  });
});

describe('buildSpawnArgs', () => {
  const base = { name: 'orc-x', cwd: '/tmp/repo', argv: ['claude', '--foo'] };

  test('includes the fixed wide -x/-y geometry so a status line never wraps', () => {
    const args = buildSpawnArgs(base);
    // The width/height flags must be present with the source-of-truth values.
    const xi = args.indexOf('-x');
    const yi = args.indexOf('-y');
    expect(xi).toBeGreaterThanOrEqual(0);
    expect(yi).toBeGreaterThanOrEqual(0);
    expect(args[xi + 1]).toBe(String(PANE_WIDTH));
    expect(args[yi + 1]).toBe(String(PANE_HEIGHT));
    // The pinned width must be comfortably wider than any provider status line.
    expect(PANE_WIDTH).toBeGreaterThanOrEqual(120);
  });

  test('geometry flags precede the -- separator (else they become program argv)', () => {
    const args = buildSpawnArgs(base);
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('-x')).toBeLessThan(sep);
    expect(args.indexOf('-y')).toBeLessThan(sep);
    // The program argv lands AFTER the separator, untouched.
    expect(args.slice(sep + 1)).toEqual(base.argv);
  });

  test('still builds a detached, named, cwd-anchored new-session', () => {
    const args = buildSpawnArgs(base);
    expect(args[0]).toBe('new-session');
    expect(args).toContain('-d');
    expect(args[args.indexOf('-s') + 1]).toBe('orc-x');
    expect(args[args.indexOf('-c') + 1]).toBe('/tmp/repo');
  });

  test('threads env as -e KEY=VALUE pairs before the separator', () => {
    const args = buildSpawnArgs({ ...base, env: { ORC_HOME: '/tmp/h' } });
    const sep = args.indexOf('--');
    const ei = args.indexOf('-e');
    expect(ei).toBeGreaterThanOrEqual(0);
    expect(args[ei + 1]).toBe('ORC_HOME=/tmp/h');
    expect(ei).toBeLessThan(sep);
  });
});
