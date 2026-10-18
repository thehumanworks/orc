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

function historicalSession(entries: unknown[], check: (spec: SpawnSpec, file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-pcli-history-'));
  try {
    const file = path.join(dir, 'codex-session.jsonl');
    const header = { type: 'session', version: 3, id: base.sessionId, cwd: base.cwd };
    fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    check({ ...base, provider: 'codex', providerSessionId: base.sessionId, transcriptPath: file }, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
      fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: base.sessionId }) + '\n' + JSON.stringify({ type: 'model_change', id: 'model0', parentId: null, provider: 'openai', modelId: 'gpt-5.5' }) + '\n');
      const spec = { ...base, provider: 'codex' as const, providerSessionId: base.sessionId, transcriptPath: file };
      expect(nativeResumeCommand(spec)).toBe(`cd '/work/my repo' && pi --session ${file} --provider openai --model gpt-5.5`);
      expect(nativeResumeNote(spec)).toContain('Pi');
      expect(() => nativeResumeCommand({ ...spec, systemPrompt: { mode: 'replace', path: path.join(dir, 'missing.md') } })).toThrow(/system prompt is missing/);
      expect(() => nativeResumeCommand({ ...spec, systemPrompt: { mode: 'append', path: dir } })).toThrow(/system prompt is missing/);
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

  test('historical Pi branches select the active assistant model, ignoring inactive provider changes', () => {
    historicalSession([
      { type: 'model_change', id: 'root', parentId: null, provider: 'openai', modelId: 'gpt-5.4-mini' },
      { type: 'message', id: 'answer', parentId: 'root', message: { role: 'assistant', provider: 'openai', model: 'gpt-5.5' } },
      { type: 'model_change', id: 'inactive', parentId: 'answer', provider: 'anthropic', modelId: 'claude-other' },
      { type: 'message', id: 'leaf', parentId: 'answer', message: { role: 'user', content: 'Continue the OpenAI branch.' } },
    ], (spec, file) => {
      const before = fs.readFileSync(file, 'utf8');
      expect(nativeResumeCommand({ ...spec, model: 'stale-spec-model' })).toContain('--provider openai --model gpt-5.5');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });
  });

  test('an active model change after an assistant wins; a recorded default is used only without transcript metadata', () => {
    historicalSession([
      { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', provider: 'openai', model: 'gpt-5.5' } },
      { type: 'model_change', id: 'latest', parentId: 'answer', provider: 'openai', modelId: 'gpt-5.4-mini' },
    ], (spec) => {
      expect(nativeResumeCommand(spec)).toContain('--provider openai --model gpt-5.4-mini');
    });
    historicalSession([
      { type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'A saved prompt.' } },
    ], (spec) => {
      expect(nativeResumeCommand({ ...spec, model: 'gpt-5.5' })).toContain('--provider openai --model gpt-5.5');
      expect(() => nativeResumeCommand(spec)).toThrow(/no recorded model.*MIGRATION-pi/);
    });
  });

  test('unsupported active branches fail actionably without rewriting the transcript', () => {
    const model = { type: 'model_change', id: 'model', parentId: null, provider: 'openai', modelId: 'gpt-5.5' };
    for (const entries of [
      [{ ...model, parentId: 'missing' }],
      [{ ...model, parentId: 'model' }],
      [model, { ...model }],
      [{ ...model, id: undefined }],
      [{ ...model, provider: 'anthropic', modelId: 'claude-other' }],
      [null],
    ]) {
      historicalSession(entries, (spec, file) => {
        const before = fs.readFileSync(file, 'utf8');
        expect(() => nativeResumeCommand(spec)).toThrow(/cannot safely continue.*MIGRATION-pi/);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
      });
    }
  });

  test('a torn tail does not change the last complete active selection or rewrite history', () => {
    historicalSession([
      { type: 'model_change', id: 'model', parentId: null, provider: 'openai', modelId: 'gpt-5.5' },
    ], (spec, file) => {
      fs.appendFileSync(file, '{"type":"message","id":');
      const before = fs.readFileSync(file, 'utf8');
      expect(nativeResumeCommand(spec)).toContain('--provider openai --model gpt-5.5');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });
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
