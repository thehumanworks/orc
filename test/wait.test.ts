import { describe, test, expect } from 'bun:test';
import { resolveCommand, resolveUntil } from '../src/cli/index.ts';

describe('resolveCommand routing for state/wait', () => {
  test('state and wait route to themselves', () => {
    expect(resolveCommand('state')).toBe('state');
    expect(resolveCommand('wait')).toBe('wait');
  });
});

describe('resolveUntil (agi wait --for)', () => {
  test('settled = any non-progressing state', () => {
    expect(resolveUntil('settled')).toEqual(['done', 'waiting', 'failed']);
  });
  test('specific states resolve to singletons', () => {
    expect(resolveUntil('done')).toEqual(['done']);
    expect(resolveUntil('waiting')).toEqual(['waiting']);
    expect(resolveUntil('failed')).toEqual(['failed']);
  });
  test('invalid value → null (caller errors)', () => {
    expect(resolveUntil('running')).toBeNull();
    expect(resolveUntil('starting')).toBeNull();
    expect(resolveUntil('')).toBeNull();
    expect(resolveUntil('garbage')).toBeNull();
  });
});
