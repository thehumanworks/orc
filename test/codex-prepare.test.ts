import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/providers/codex.ts';
import { sessionInstructionsPath } from '../src/paths.ts';
import { removeSessionInstructions } from '../src/session-files.ts';

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codex-prep-'));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('CodexAdapter — non-mutating persona injection', () => {
  const adapter = new CodexAdapter();
  let orcHome: string;

  beforeEach(async () => {
    orcHome = await tmpDir();
    process.env.ORC_HOME = orcHome;
  });

  test('existing AGENTS.md is untouched; no repo file is created', async () => {
    const cwd = await tmpDir();
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'user-owned sentinel\n');
    const instructionsPath = sessionInstructionsPath('sess-a');
    await adapter.prepare({
      cwd,
      sessionId: 'sess-a',
      systemPrompt: 'inject me',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath,
    });
    expect(await Bun.file(path.join(cwd, 'AGENTS.md')).text()).toBe('user-owned sentinel\n');
    // No new files in cwd besides the existing AGENTS.md.
    const entries = await fs.readdir(cwd);
    expect(entries).toEqual(['AGENTS.md']);
    expect(await Bun.file(instructionsPath).text()).toBe('inject me\n');
    expect((await fs.stat(instructionsPath)).mode & 0o777).toBe(0o600);
  });

  test('absent AGENTS.md stays absent (no repo file created)', async () => {
    const cwd = await tmpDir();
    const instructionsPath = sessionInstructionsPath('sess-b');
    await adapter.prepare({
      cwd,
      sessionId: 'sess-b',
      systemPrompt: 'persona body',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath,
    });
    expect(await fs.readdir(cwd)).toEqual([]);
    expect(await Bun.file(path.join(cwd, 'AGENTS.md')).exists()).toBe(false);
    expect(await Bun.file(instructionsPath).text()).toBe('persona body\n');
  });

  test('concurrent sessions get distinct instruction paths', async () => {
    const cwd = await tmpDir();
    const p1 = sessionInstructionsPath('uuid-1111');
    const p2 = sessionInstructionsPath('uuid-2222');
    expect(p1).not.toBe(p2);
    await adapter.prepare({
      cwd,
      sessionId: 'uuid-1111',
      systemPrompt: 'one',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath: p1,
    });
    await adapter.prepare({
      cwd,
      sessionId: 'uuid-2222',
      systemPrompt: 'two',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath: p2,
    });
    expect(await Bun.file(p1).text()).toBe('one\n');
    expect(await Bun.file(p2).text()).toBe('two\n');
    expect(p1.startsWith(orcHome)).toBe(true);
    expect(p2.startsWith(orcHome)).toBe(true);
  });

  test('buildArgv references the external file (path only, not prompt body)', () => {
    const instructionsPath = path.join(orcHome, 'sessions', 's1', 'instructions.md');
    const argv = adapter.buildArgv({
      cwd: '/tmp/repo',
      sessionId: 's1',
      systemPrompt: 'SECRET_PERSONA_BODY_SHOULD_NOT_APPEAR',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath,
      model: 'gpt-5.5',
    });
    expect(argv[0]).toBe('codex');
    expect(argv).toContain('-m');
    expect(argv).toContain('gpt-5.5');
    const cIdx = argv.indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    expect(argv[cIdx + 1]).toBe(`experimental_instructions_file=${instructionsPath}`);
    expect(argv.join('\0')).not.toContain('SECRET_PERSONA_BODY_SHOULD_NOT_APPEAR');
  });

  test('replace mode is rejected with a clear error (no file writes)', async () => {
    const cwd = await tmpDir();
    const instructionsPath = sessionInstructionsPath('sess-replace');
    await expect(
      adapter.prepare({
        cwd,
        sessionId: 'sess-replace',
        systemPrompt: 'replace me',
        systemPromptMode: 'replace',
        sessionDir: '/tmp',
        instructionsPath,
      }),
    ).rejects.toThrow(/systemPromptMode=replace is not supported/);
    expect(await Bun.file(instructionsPath).exists()).toBe(false);
    expect(await Bun.file(path.join(cwd, 'AGENTS.md')).exists()).toBe(false);
  });

  test('refuses instructionsPath under cwd', async () => {
    const cwd = await tmpDir();
    await expect(
      adapter.prepare({
        cwd,
        sessionId: 's',
        systemPrompt: 'x',
        systemPromptMode: 'append',
        sessionDir: '/tmp',
        instructionsPath: path.join(cwd, 'AGENTS.md'),
      }),
    ).rejects.toThrow(/refusing to write codex instructions under cwd/);
  });

  test('removeSessionInstructions cleans the orc-owned file (rollback/purge)', async () => {
    const instructionsPath = sessionInstructionsPath('sess-clean');
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await Bun.write(instructionsPath, 'bye\n');
    await removeSessionInstructions({ instructionsPath, sessionId: 'sess-clean' });
    expect(await Bun.file(instructionsPath).exists()).toBe(false);
  });

  test('prepare without instructionsPath throws (does not fall back to AGENTS.md)', async () => {
    const cwd = await tmpDir();
    await expect(
      adapter.prepare({
        cwd,
        sessionId: 's',
        systemPrompt: 'x',
        systemPromptMode: 'append',
        sessionDir: '/tmp',
      }),
    ).rejects.toThrow(/instructionsPath/);
    expect(await Bun.file(path.join(cwd, 'AGENTS.md')).exists()).toBe(false);
  });
});
