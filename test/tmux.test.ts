import { describe, test, expect } from 'bun:test';
import { sanitizeTmuxName } from '../src/drivers/tmux.ts';

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
