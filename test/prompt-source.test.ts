import { describe, test, expect } from 'bun:test';
import { decidePromptSource } from '../src/cli/index.ts';

/**
 * BUG 1 — `orc spawn`/`send` hung forever on non-TTY stdin because the undefined-prompt
 * branch read `Bun.stdin.text()` unconditionally. decidePromptSource is the pure decision
 * that fixes it: only reach for stdin when EXPLICITLY '-', or (for required prompts) when
 * stdin is actually piped. spawn (requireStdin=false) never reads stdin opportunistically.
 */
describe('decidePromptSource — spawn (prompt optional, requireStdin=false)', () => {
  test('omitted prompt → none (never read stdin, even when piped)', () => {
    // This is the hang fix: a never-closing pipe (!isTTY) must NOT cause a stdin read.
    expect(decidePromptSource(undefined, { requireStdin: false, isTTY: false })).toEqual({
      kind: 'none',
    });
    expect(decidePromptSource(undefined, { requireStdin: false, isTTY: true })).toEqual({
      kind: 'none',
    });
  });

  test('explicit - still reads stdin', () => {
    expect(decidePromptSource('-', { requireStdin: false, isTTY: false })).toEqual({
      kind: 'stdin',
    });
  });

  test('@file → file', () => {
    expect(decidePromptSource('@/tmp/p.txt', { requireStdin: false, isTTY: false })).toEqual({
      kind: 'file',
      value: '/tmp/p.txt',
    });
  });

  test('literal text → literal', () => {
    expect(decidePromptSource('hi there', { requireStdin: false, isTTY: false })).toEqual({
      kind: 'literal',
      value: 'hi there',
    });
  });
});

describe('decidePromptSource — send (prompt required, requireStdin=true)', () => {
  test('omitted + piped stdin (!isTTY) → read stdin', () => {
    expect(decidePromptSource(undefined, { requireStdin: true, isTTY: false })).toEqual({
      kind: 'stdin',
    });
  });

  test('omitted + TTY → error (do not block on stdin)', () => {
    expect(decidePromptSource(undefined, { requireStdin: true, isTTY: true })).toEqual({
      kind: 'error',
    });
  });

  test('explicit - reads stdin regardless of TTY', () => {
    expect(decidePromptSource('-', { requireStdin: true, isTTY: true })).toEqual({
      kind: 'stdin',
    });
    expect(decidePromptSource('-', { requireStdin: true, isTTY: false })).toEqual({
      kind: 'stdin',
    });
  });

  test('@file and literal still work', () => {
    expect(decidePromptSource('@p.md', { requireStdin: true, isTTY: true })).toEqual({
      kind: 'file',
      value: 'p.md',
    });
    expect(decidePromptSource('do the thing', { requireStdin: true, isTTY: true })).toEqual({
      kind: 'literal',
      value: 'do the thing',
    });
  });
});
