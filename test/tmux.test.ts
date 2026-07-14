import { describe, test, expect } from 'bun:test';
import {
  sanitizeTmuxName,
  buildSpawnArgs,
  buildAttachArgs,
  buildSetBufferArgs,
  buildPasteBufferArgs,
  buildDeleteBufferArgs,
  newPasteBufferName,
  pasteWithNamedBuffer,
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
    const xi = args.indexOf('-x');
    const yi = args.indexOf('-y');
    expect(xi).toBeGreaterThanOrEqual(0);
    expect(yi).toBeGreaterThanOrEqual(0);
    expect(args[xi + 1]).toBe(String(PANE_WIDTH));
    expect(args[yi + 1]).toBe(String(PANE_HEIGHT));
    expect(PANE_WIDTH).toBeGreaterThanOrEqual(120);
  });

  test('geometry flags precede the -- separator (else they become program argv)', () => {
    const args = buildSpawnArgs(base);
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('-x')).toBeLessThan(sep);
    expect(args.indexOf('-y')).toBeLessThan(sep);
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

describe('buildAttachArgs', () => {
  test('builds a read-write attach command', () => {
    expect(buildAttachArgs('orc-claude-abcd1234')).toEqual([
      'attach',
      '-t',
      'orc-claude-abcd1234',
    ]);
  });

  test('adds tmux read-only mode when requested', () => {
    expect(buildAttachArgs('orc-claude-abcd1234', { readOnly: true })).toEqual([
      'attach',
      '-r',
      '-t',
      'orc-claude-abcd1234',
    ]);
  });
});

describe('named paste buffers (no server-global unnamed buffer)', () => {
  test('newPasteBufferName is unique and safe', () => {
    const a = newPasteBufferName();
    const b = newPasteBufferName();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^orc-paste-[0-9a-f]+$/);
    expect(b).toMatch(/^orc-paste-[0-9a-f]+$/);
  });

  test('set-buffer uses -b <name> -- text (never the unnamed buffer)', () => {
    expect(buildSetBufferArgs('orc-paste-abc', 'hello\nworld')).toEqual([
      'set-buffer',
      '-b',
      'orc-paste-abc',
      '--',
      'hello\nworld',
    ]);
    // `--` keeps text that starts with '-' from being parsed as a tmux flag.
    expect(buildSetBufferArgs('orc-paste-abc', '-starts-with-dash')).toEqual([
      'set-buffer',
      '-b',
      'orc-paste-abc',
      '--',
      '-starts-with-dash',
    ]);
  });

  test('paste-buffer uses -b, bracketed paste -p, and -d (delete after paste)', () => {
    expect(buildPasteBufferArgs('orc-paste-abc', 'orc-pane')).toEqual([
      'paste-buffer',
      '-b',
      'orc-paste-abc',
      '-p',
      '-d',
      '-t',
      'orc-pane',
    ]);
  });

  test('pasteWithNamedBuffer sets then pastes the same unique name', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    const { bufferName } = await pasteWithNamedBuffer(run, 'orc-x', 'prompt text', 'orc-paste-fixed1');
    expect(bufferName).toBe('orc-paste-fixed1');
    expect(calls).toEqual([
      ['set-buffer', '-b', 'orc-paste-fixed1', '--', 'prompt text'],
      ['paste-buffer', '-b', 'orc-paste-fixed1', '-p', '-d', '-t', 'orc-x'],
    ]);
  });

  test('two pastes get distinct buffer names by default', async () => {
    const names: string[] = [];
    const run = async (args: string[]) => {
      if (args[0] === 'set-buffer') names.push(args[2]!);
      return { code: 0, stdout: '', stderr: '' };
    };
    await pasteWithNamedBuffer(run, 'p', 'a');
    await pasteWithNamedBuffer(run, 'p', 'b');
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  test('best-effort delete-buffer when set succeeds but paste fails', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'paste-buffer') {
        return { code: 1, stdout: '', stderr: 'paste failed' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(pasteWithNamedBuffer(run, 'orc-x', 'text', 'orc-paste-cleanup')).rejects.toThrow(
      /paste-buffer failed/,
    );
    expect(calls).toEqual([
      ['set-buffer', '-b', 'orc-paste-cleanup', '--', 'text'],
      ['paste-buffer', '-b', 'orc-paste-cleanup', '-p', '-d', '-t', 'orc-x'],
      buildDeleteBufferArgs('orc-paste-cleanup'),
    ]);
  });

  test('set-buffer failure does not attempt paste or delete', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { code: 1, stdout: '', stderr: 'set failed' };
    };
    await expect(pasteWithNamedBuffer(run, 'orc-x', 'text', 'orc-paste-setfail')).rejects.toThrow(
      /set-buffer failed/,
    );
    expect(calls).toEqual([['set-buffer', '-b', 'orc-paste-setfail', '--', 'text']]);
  });
});
