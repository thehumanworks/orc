import { describe, test, expect } from 'bun:test';
import { ClaudeAdapter } from '../src/providers/claude.ts';
import { CodexAdapter } from '../src/providers/codex.ts';
import { PiAdapter } from '../src/providers/pi.ts';
import type { BuildCtx } from '../src/providers/provider.ts';

function ctx(over: Partial<BuildCtx> = {}): BuildCtx {
  return {
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    systemPromptMode: 'append',
    cwd: '/tmp/work',
    sessionDir: '/tmp/orc/sessions/pi/sid',
    ...over,
  };
}

describe('claude buildArgv', () => {
  const a = new ClaudeAdapter();
  test('base yolo + session-id', () => {
    expect(a.buildArgv(ctx())).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--session-id',
      'abcd1234-0000-0000-0000-000000000000',
    ]);
  });
  test('model flag', () => {
    expect(a.buildArgv(ctx({ model: 'opus' }))).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--session-id',
      'abcd1234-0000-0000-0000-000000000000',
    ]);
  });
  test('native agentName uses --agent', () => {
    const argv = a.buildArgv(ctx({ agentName: 'codebase-recon' }));
    expect(argv).toContain('--agent');
    expect(argv[argv.indexOf('--agent') + 1]).toBe('codebase-recon');
    expect(argv).not.toContain('--append-system-prompt');
  });
  test('systemPrompt append (default)', () => {
    const argv = a.buildArgv(ctx({ systemPrompt: 'be terse' }));
    expect(argv).toContain('--append-system-prompt');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('be terse');
  });
  test('systemPrompt replace', () => {
    const argv = a.buildArgv(ctx({ systemPrompt: 'be terse', systemPromptMode: 'replace' }));
    expect(argv).toContain('--system-prompt');
    expect(argv).not.toContain('--append-system-prompt');
  });
  test('no positional prompt ever', () => {
    const argv = a.buildArgv(ctx({ systemPrompt: 'x' }));
    // last two args are the session-id pair
    expect(argv[argv.length - 2]).toBe('--session-id');
  });
});

describe('codex buildArgv', () => {
  const a = new CodexAdapter();
  test('documented bypass flag, no session-id', () => {
    expect(a.buildArgv(ctx())).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });
  test('model via -m', () => {
    expect(a.buildArgv(ctx({ model: 'gpt-5.5' }))).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.5',
    ]);
  });
  test('never includes --session-id or --append-system-prompt', () => {
    const argv = a.buildArgv(ctx({ systemPrompt: 'x', model: 'gpt-5.5' }));
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--append-system-prompt');
    expect(argv).not.toContain('--system-prompt');
  });
});

describe('pi buildArgv', () => {
  const a = new PiAdapter();
  test('-a trust + session-id + session-dir', () => {
    expect(a.buildArgv(ctx())).toEqual([
      'pi',
      '-a',
      '--session-id',
      'abcd1234-0000-0000-0000-000000000000',
      '--session-dir',
      '/tmp/orc/sessions/pi/sid',
    ]);
  });
  test('model + append system prompt', () => {
    const argv = a.buildArgv(ctx({ model: 'sonnet', systemPrompt: 'persona' }));
    expect(argv).toContain('--model');
    expect(argv).toContain('--append-system-prompt');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('persona');
  });
  test('replace mode', () => {
    const argv = a.buildArgv(ctx({ systemPrompt: 'persona', systemPromptMode: 'replace' }));
    expect(argv).toContain('--system-prompt');
    expect(argv).not.toContain('--append-system-prompt');
  });
});

describe('trust + ready matchers', () => {
  test('claude ready', () => {
    const a = new ClaudeAdapter();
    expect(a.readyMatch('⏵⏵ bypass permissions on')).toBe(true);
    expect(a.readyMatch('booting...')).toBe(false);
  });
  test('claude trust dialog', () => {
    const a = new ClaudeAdapter();
    expect(a.trustDialogMatch('Is this a project you created or one you trust?')).toBe(true);
    expect(a.trustDialogMatch('nothing here')).toBe(false);
  });
  test('codex trust dialog', () => {
    const a = new CodexAdapter();
    expect(a.trustDialogMatch('Do you trust the contents of this directory?')).toBe(true);
  });
  test('pi has no trust dialog', () => {
    const a = new PiAdapter();
    expect(a.trustDialogMatch('anything at all')).toBe(false);
  });
});
