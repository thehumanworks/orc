import { describe, test, expect, afterAll, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Driver } from '../src/drivers/driver.ts';

const failingDriver: Driver = {
  name: 'fail-spawn',
  async spawn() {
    throw new Error('spawn failed for test');
  },
  capture: async () => '',
  sendKeys: async () => {},
  paste: async () => {},
  list: async () => [],
  isAlive: async () => false,
  kill: async () => {},
  attach: async () => 0,
  attachCommand: () => 'true',
};

mock.module('../src/drivers/driver.ts', () => ({
  getDriver: () => failingDriver,
}));

const { agent } = await import('../src/agent.ts');

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
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('agent() worktree rollback on pre-spawn failure', () => {
  test('removes created worktree when driver.spawn fails', async () => {
    const repo = await mkRepo();
    const before = await listWorktreePaths(repo);

    await expect(
      agent({
        provider: 'claude',
        cwd: repo,
        worktree: true,
        waitForReady: false,
      }),
    ).rejects.toThrow(/spawn failed for test/);

    const after = await listWorktreePaths(repo);
    expect(after).toEqual(before);
  });
});