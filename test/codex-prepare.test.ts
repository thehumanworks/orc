import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/providers/codex.ts';

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codex-prep-'));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('CodexAdapter.prepare — AGENTS.md', () => {
  const adapter = new CodexAdapter();

  test('throws when AGENTS.md exists', async () => {
    const cwd = await tmpDir();
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'user-owned sentinel\n');
    await expect(
      adapter.prepare({
        cwd,
        sessionId: 's',
        systemPrompt: 'inject me',
        systemPromptMode: 'append',
        sessionDir: '/tmp',
      }),
    ).rejects.toThrow(/refusing to overwrite existing AGENTS\.md/);
    const text = await Bun.file(path.join(cwd, 'AGENTS.md')).text();
    expect(text).toBe('user-owned sentinel\n');
  });

  test('writes when absent', async () => {
    const cwd = await tmpDir();
    await adapter.prepare({
      cwd,
      sessionId: 's',
      systemPrompt: 'persona body',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
    });
    expect(await Bun.file(path.join(cwd, 'AGENTS.md')).text()).toBe('persona body\n');
  });
});