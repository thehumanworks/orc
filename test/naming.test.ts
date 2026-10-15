import { describe, test, expect } from 'bun:test';
import { sanitizeLabel } from '../src/naming.ts';

// Behaviour is frozen: worktree branch names are derived from this function.
describe('sanitizeLabel', () => {
  test('keeps allowed chars', () => {
    expect(sanitizeLabel('codebase-recon_1')).toBe('codebase-recon_1');
  });
  test('replaces dots and colons with dash', () => {
    expect(sanitizeLabel('a.b:c')).toBe('a-b-c');
  });
  test('collapses runs of disallowed chars', () => {
    expect(sanitizeLabel('a   b')).toBe('a-b');
    expect(sanitizeLabel('a...b')).toBe('a-b');
  });
  test('trims leading/trailing dashes', () => {
    expect(sanitizeLabel('--foo--')).toBe('foo');
    expect(sanitizeLabel('.bar.')).toBe('bar');
  });
  test('falls back to "agent" on empty', () => {
    expect(sanitizeLabel('')).toBe('agent');
    expect(sanitizeLabel('...')).toBe('agent');
  });
  test('strips slashes and unicode', () => {
    expect(sanitizeLabel('orc/claude/❯box')).toBe('orc-claude-box');
  });
});
