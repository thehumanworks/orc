import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeResumeCommand, nativeResumeNote, shellQuote } from '../src/provider-cli.ts';
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

  test('codex: pi --session <harness session file> (+ a pi login note); legacy app-server sessions have none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-pcli-'));
    try {
      const file = path.join(dir, 'codex-session.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      const spec = { ...base, provider: 'codex' as const, providerSessionId: base.sessionId, transcriptPath: file };
      expect(nativeResumeCommand(spec)).toBe(`cd '/work/my repo' && pi --session ${file}`);
      expect(nativeResumeNote(spec)).toContain('pi');
      expect(nativeResumeNote({ ...base, provider: 'claude' })).toBeNull();
      // Missing session file, or a session from the removed codex app-server runtime.
      expect(nativeResumeCommand({ ...spec, transcriptPath: path.join(dir, 'gone', 'codex-session.jsonl') })).toBe(
        "# provider 'codex' has no native resume command",
      );
      expect(nativeResumeCommand({ ...spec, providerSessionId: 'thr_abc' })).toBe("# provider 'codex' has no native resume command");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
