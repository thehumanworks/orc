import { describe, test, expect, afterAll, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';

// D16: a provider that fails to start (the scripted fake exits at once) must leave
// nothing behind — no worktree, no record, no session dir, no system prompt file.
const prevFake = process.env[FAKE_PROVIDER_ENV];
process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ exitAtStart: 1 });

const { agent, reserveSpawnRecord } = await import('../src/agent.ts');
const { readRegistry } = await import('../src/registry.ts');

const tmpDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

async function mkRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-wt-rollback-'));
  tmpDirs.push(base);
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  await git(['init', '-q'], repo);
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  return fs.realpath(repo);
}

async function listWorktreePaths(repo: string): Promise<string[]> {
  const p = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], { cwd: repo, stdout: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length));
  }
  return paths;
}

afterAll(async () => {
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

const START_FAILURE = /failed to start|stopped before its provider was ready|actor exited before its provider was ready/;

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-rb-home-'));
  tmpDirs.push(base);
  const previous = process.env.ORC_HOME;
  process.env.ORC_HOME = path.join(base, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
  try {
    return await fn(process.env.ORC_HOME);
  } finally {
    if (previous === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = previous;
  }
}

async function sessionDirs(home: string): Promise<string[]> {
  return fs.readdir(path.join(home, 'sessions')).catch(() => []);
}

describe('agent() rollback when the provider fails to start (D16)', () => {
  test('removes the created worktree, record and session dir', async () => {
    await withHome(async (home) => {
      const repo = await mkRepo();
      const before = await listWorktreePaths(repo);

      await expect(
        agent({
          provider: 'claude',
          cwd: repo,
          worktree: true,
          systemPrompt: 'persona',
        }),
      ).rejects.toThrow(START_FAILURE);

      expect(await listWorktreePaths(repo)).toEqual(before);
      expect(await readRegistry()).toEqual([]);
      expect(await sessionDirs(home)).toEqual([]);
    });
  }, 30_000);

  test('policy check and registry reservation are atomic across concurrent spawns', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-policy-reserve-'));
    tmpDirs.push(base);
    const previous = process.env.ORC_HOME;
    process.env.ORC_HOME = path.join(base, 'orc');
    await fs.mkdir(process.env.ORC_HOME, { recursive: true });
    try {
      const makeRecord = (id: string) => ({
        id,
        sessionId: `${id}-session`,
        provider: 'claude' as const,
        cwd: base,
        workspace: base,
        rootRunId: 'policy-root',
        createdAt: new Date().toISOString(),
      });
      const args = {
        lineage: { rootRunId: 'policy-root', depth: 1 },
        policy: { maxConcurrentSessions: 1 },
      };
      const settled = await Promise.allSettled([
        reserveSpawnRecord(makeRecord('spawn001'), args),
        reserveSpawnRecord(makeRecord('spawn002'), args),
      ]);

      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/maxConcurrentSessions=1/);
      expect(await readRegistry()).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = previous;
    }
  });

  test('removes worktree when workspace is logical (non-repo path)', async () => {
    await withHome(async () => {
      const repo = await mkRepo();
      const before = await listWorktreePaths(repo);

      await expect(
        agent({
          provider: 'claude',
          cwd: repo,
          workspace: 'my-logical-project',
          worktree: true,
        }),
      ).rejects.toThrow(START_FAILURE);

      expect(await listWorktreePaths(repo)).toEqual(before);
    });
  }, 30_000);

  test('removes the orc-owned system prompt file when spawn fails (no AGENTS.md mutation)', async () => {
    await withHome(async (home) => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codex-rb-'));
      tmpDirs.push(base);
      const repo = path.join(base, 'repo');
      await fs.mkdir(repo, { recursive: true });
      await fs.writeFile(path.join(repo, 'AGENTS.md'), 'user agents\n');
      await expect(
        agent({
          provider: 'codex',
          cwd: repo,
          systemPrompt: 'rollback-persona',
        }),
      ).rejects.toThrow(START_FAILURE);

      expect(await Bun.file(path.join(repo, 'AGENTS.md')).text()).toBe('user agents\n');
      expect(await fs.readdir(repo)).toEqual(['AGENTS.md']);
      expect(await sessionDirs(home)).toEqual([]);
      expect(await readRegistry()).toEqual([]);
    });
  }, 30_000);
});
