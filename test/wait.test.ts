import { describe, test, expect } from 'bun:test';
import { resolveCommand, resolveUntil } from '../src/cli/index.ts';
import { Session } from '../src/session.ts';
import type { SessionRecord } from '../src/types.ts';

function deadRecord(): SessionRecord {
  return {
    id: 'waitdead',
    sessionId: 'waitdead-session',
    provider: 'claude',
    tmuxName: 'orc-test-wait-dead-does-not-exist',
    cwd: process.cwd(),
    workspace: process.cwd(),
    systemPromptMode: 'append',
    createdAt: new Date().toISOString(),
  };
}

describe('resolveCommand routing for state/wait', () => {
  test('state and wait route to themselves', () => {
    expect(resolveCommand('state')).toBe('state');
    expect(resolveCommand('wait')).toBe('wait');
  });
});

describe('Session.waitForResult debounce outcome', () => {
  test('a terminal-looking state at timeout is not reported as settled', async () => {
    const result = await new Session(deadRecord()).waitForResult({
      until: ['failed'],
      timeoutMs: 0,
      pollMs: 1,
    });
    expect(result).toEqual({ state: 'failed', settled: false });
  });

  test('does not settle after sleeping past the timeout deadline', async () => {
    const result = await new Session(deadRecord()).waitForResult({
      until: ['failed'],
      timeoutMs: 20,
      pollMs: 100,
    });
    expect(result).toEqual({ state: 'failed', settled: false });
  });

  test('waitFor keeps the legacy state-only return shape', async () => {
    const state = await new Session(deadRecord()).waitFor({
      until: ['failed'],
      timeoutMs: 0,
      pollMs: 1,
    });
    expect(state).toBe('failed');
  });
});

describe('resolveUntil (orc wait --for)', () => {
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
