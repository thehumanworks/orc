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
        tmuxName: `orc-${id}`,
        cwd: base,
        workspace: base,
        rootRunId: 'policy-root',
        createdAt: new Date().toISOString(),
      });
      const args = {
        driver: failingDriver,
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
    const repo = await mkRepo();
    const before = await listWorktreePaths(repo);

    await expect(
      agent({
        provider: 'claude',
        cwd: repo,
        workspace: 'my-logical-project',
        worktree: true,
        waitForReady: false,
      }),
    ).rejects.toThrow(/spawn failed for test/);

    expect(await listWorktreePaths(repo)).toEqual(before);
  });

  test('removes orc-owned codex instructions when spawn fails (no AGENTS.md mutation)', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codex-rb-'));
    tmpDirs.push(base);
    const orcHome = path.join(base, 'orc');
    const repo = path.join(base, 'repo');
    await fs.mkdir(orcHome, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'AGENTS.md'), 'user agents\n');
    const prev = process.env.ORC_HOME;
    process.env.ORC_HOME = orcHome;
    try {
      await expect(
        agent({
          provider: 'codex',
          cwd: repo,
          systemPrompt: 'rollback-persona',
          waitForReady: false,
        }),
      ).rejects.toThrow(/spawn failed for test/);

      expect(await Bun.file(path.join(repo, 'AGENTS.md')).text()).toBe('user agents\n');
      // No leftover instructions.md under ~/.orc/sessions
      const sessions = path.join(orcHome, 'sessions');
      let leftover: string[] = [];
      try {
        const walk = async (dir: string): Promise<string[]> => {
          const out: string[] = [];
          for (const e of await fs.readdir(dir)) {
            const p = path.join(dir, e);
            const st = await fs.stat(p);
            if (st.isDirectory()) out.push(...(await walk(p)));
            else if (e === 'instructions.md') out.push(p);
          }
          return out;
        };
        leftover = await walk(sessions);
      } catch {
        leftover = [];
      }
      expect(leftover).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.ORC_HOME;
      else process.env.ORC_HOME = prev;
    }
  });
});
