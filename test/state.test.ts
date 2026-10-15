import { describe, test, expect } from 'bun:test';
import { isSettled, resolveUntil } from '../src/state.ts';

describe('isSettled', () => {
  test('done/waiting/failed settle; running/starting do not', () => {
    expect(isSettled('done')).toBe(true);
    expect(isSettled('waiting')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('running')).toBe(false);
    expect(isSettled('starting')).toBe(false);
  });
});

describe('resolveUntil', () => {
  test('every settled set is a subset of the settled states', () => {
    for (const f of ['settled', 'done', 'waiting', 'failed']) {
      for (const s of resolveUntil(f)!) expect(isSettled(s)).toBe(true);
    }
  });
});
