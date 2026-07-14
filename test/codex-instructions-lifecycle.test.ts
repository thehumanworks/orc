import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/providers/codex.ts';
import { sessionInstructionsPath } from '../src/paths.ts';
import { removeSessionInstructions } from '../src/session-files.ts';
import { Session } from '../src/session.ts';
import { upsertRecord, readRegistry } from '../src/registry.ts';
import type { SessionRecord } from '../src/types.ts';

/**
 * Lifecycle of orc-owned codex instruction files: distinct paths, purge cleanup,
 * and no mutation of repo AGENTS.md. (agent() pre-spawn rollback is covered via
 * removeSessionInstructions, which agent() calls in its failure path.)
 */

const tmpDirs: string[] = [];
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshHome(): Promise<{ home: string; repo: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codex-life-'));
  tmpDirs.push(base);
  const home = path.join(base, 'orc');
  const repo = path.join(base, 'repo');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'AGENTS.md'), 'repo agents\n');
  process.env.ORC_HOME = home;
  return { home, repo };
}

describe('codex instructions lifecycle', () => {
  const adapter = new CodexAdapter();

  test('agent-shaped prepare+argv: distinct paths, external file, AGENTS.md untouched', async () => {
    const { home, repo } = await freshHome();
    const id1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
    const id2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
    const p1 = sessionInstructionsPath(id1);
    const p2 = sessionInstructionsPath(id2);
    expect(p1).not.toBe(p2);

    await adapter.prepare({
      cwd: repo,
      sessionId: id1,
      systemPrompt: 'persona-one',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath: p1,
    });
    await adapter.prepare({
      cwd: repo,
      sessionId: id2,
      systemPrompt: 'persona-two',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath: p2,
    });

    expect(await Bun.file(p1).text()).toBe('persona-one\n');
    expect(await Bun.file(p2).text()).toBe('persona-two\n');
    expect(p1.startsWith(home)).toBe(true);
    expect(await Bun.file(path.join(repo, 'AGENTS.md')).text()).toBe('repo agents\n');

    const argv = adapter.buildArgv({
      cwd: repo,
      sessionId: id1,
      systemPrompt: 'persona-one',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath: p1,
    });
    expect(argv).toContain(`experimental_instructions_file=${p1}`);
    expect(argv.join('\0')).not.toContain('persona-one');
  });

  test('pre-spawn rollback cleanup removes instruction file only', async () => {
    const { repo } = await freshHome();
    const sessionId = 'rollback-session-uuid-0001';
    const instructionsPath = sessionInstructionsPath(sessionId);
    await adapter.prepare({
      cwd: repo,
      sessionId,
      systemPrompt: 'will-rollback',
      systemPromptMode: 'append',
      sessionDir: '/tmp',
      instructionsPath,
    });
    expect(await Bun.file(instructionsPath).exists()).toBe(true);

    // Same helper agent() invokes in its pre-spawn catch.
    await removeSessionInstructions({ instructionsPath, sessionId });
    expect(await Bun.file(instructionsPath).exists()).toBe(false);
    expect(await Bun.file(path.join(repo, 'AGENTS.md')).text()).toBe('repo agents\n');
  });

  test('Session.kill({ purge: true }) removes instruction file', async () => {
    const { home, repo } = await freshHome();
    const sessionId = 'purge-session-uuid-0001';
    const instructionsPath = sessionInstructionsPath(sessionId);
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await Bun.write(instructionsPath, 'purge-me\n');

    const rec: SessionRecord = {
      id: 'purge001',
      sessionId,
      provider: 'codex',
      tmuxName: 'orc-codex-purge001-doesnotexist',
      cwd: repo,
      workspace: repo,
      instructionsPath,
      createdAt: new Date().toISOString(),
    };
    await upsertRecord(rec);
    // tmux kill-session on a missing name is graceful; purge removes instructions.
    await new Session(rec).kill({ purge: true });

    expect(await Bun.file(instructionsPath).exists()).toBe(false);
    expect(await readRegistry()).toEqual([]);
    expect(await Bun.file(path.join(repo, 'AGENTS.md')).text()).toBe('repo agents\n');
    expect(home.length).toBeGreaterThan(0);
  });

  test('ordinary Session.kill removes instructions while retaining the dead record', async () => {
    const { repo } = await freshHome();
    const sessionId = 'normal-kill-session-uuid-0001';
    const instructionsPath = sessionInstructionsPath(sessionId);
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await Bun.write(instructionsPath, 'remove-after-kill\n');

    const rec: SessionRecord = {
      id: 'kill0001',
      sessionId,
      provider: 'codex',
      tmuxName: 'orc-codex-kill0001-doesnotexist',
      cwd: repo,
      workspace: repo,
      instructionsPath,
      createdAt: new Date().toISOString(),
    };
    await upsertRecord(rec);
    await new Session(rec).kill();

    expect(await Bun.file(instructionsPath).exists()).toBe(false);
    expect((await readRegistry())[0]?.status).toBe('dead');
  });

  test('cleanup refuses a sidecar path owned by a different session id', async () => {
    await freshHome();
    const ownerId = 'sidecar-owner-session-0001';
    const instructionsPath = sessionInstructionsPath(ownerId);
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await Bun.write(instructionsPath, 'must-survive\n');

    await removeSessionInstructions({
      instructionsPath,
      sessionId: 'different-session-id-0002',
    });

    expect(await Bun.file(instructionsPath).text()).toBe('must-survive\n');
  });
});
