import { describe, test, expect } from 'bun:test';
import { nativeResumeCommand, shellQuote } from '../src/provider-cli.ts';
import type { SpawnSpec } from '../src/runtime/types.ts';

const base: SpawnSpec = {
  version: 1,
  sessionId: '11111111-2222-3333-4444-555555555555',
  provider: 'claude',
  cwd: '/work/my repo',
  env: {},
  createdAt: '2026-10-15T00:00:00.000Z',
};

describe('nativeResumeCommand (orc takeover)', () => {
  test('claude: --resume <providerSessionId> with model, agent and the persona file', () => {
    expect(nativeResumeCommand({ ...base, providerSessionId: base.sessionId })).toBe(
      `cd '/work/my repo' && claude --resume ${base.sessionId}`,
    );
    expect(
      nativeResumeCommand({
        ...base,
        model: 'haiku',
        agentName: 'reviewer',
        systemPrompt: { mode: 'append', path: '/h/.orc/sessions/x/system-prompt.md' },
      }),
    ).toBe(
      `cd '/work/my repo' && claude --resume ${base.sessionId} --model haiku --agent reviewer ` +
        '--append-system-prompt-file /h/.orc/sessions/x/system-prompt.md',
    );
  });

  test('codex: codex resume <threadId>', () => {
    expect(nativeResumeCommand({ ...base, provider: 'codex', providerSessionId: 'thr_abc' })).toBe(
      `cd '/work/my repo' && codex resume thr_abc`,
    );
  });

  test('pi: the runtime resume flags minus --mode rpc', () => {
    const cmd = nativeResumeCommand({
      ...base,
      provider: 'pi',
      sessionDir: '/h/.orc/transcripts/pi/x',
      systemPrompt: { mode: 'replace', path: '/p.md' },
    });
    expect(cmd).toBe(
      `cd '/work/my repo' && pi -a --system-prompt /p.md --session-id ${base.sessionId} --session-dir /h/.orc/transcripts/pi/x`,
    );
    expect(cmd).not.toContain('--mode');
  });

  test('shellQuote quotes only when needed', () => {
    expect(shellQuote('/a/b-c_d.e')).toBe('/a/b-c_d.e');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
