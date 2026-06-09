import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace } from '../src/agent.ts';
import { gitToplevel, createWorktree } from '../src/worktree.ts';

/**
 * A worktree session must belong to the PARENT repo's workspace, not the worktree dir.
 *
 * Pitfall this guards: a linked git worktree reports ITSELF as `git --show-toplevel`,
 * so resolving the workspace from the worktree cwd would silo the session under
 * <repo>/.orc/worktrees/<id> and hide it from `agi list` in the parent repo. agent()
 * therefore resolves the workspace from baseCwd (the original invocation dir, always
 * inside the parent repo), which collapses to the repo root for both the repo and any
 * of its subdirs.
 */

const tmpDirs: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

async function mkRepo(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-wtws-'));
  tmpDirs.push(base);
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  await git(['init', '-q'], repo);
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  return fs.realpath(repo);
}

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('worktree session → parent repo workspace', () => {
  test('the pitfall: a worktree reports itself as git toplevel', async () => {
    const repo = await mkRepo();
    const wt = await createWorktree({ cwd: repo, shortId: 'aa11bb22', agentLabel: 'codex' });
    // This is exactly why resolving the workspace from the worktree cwd is wrong.
    expect(await gitToplevel(wt.path)).toBe(wt.path);
    expect(await gitToplevel(wt.path)).not.toBe(repo);
  });

  test('workspace resolved from baseCwd (repo root) → the repo, for repo and subdirs', async () => {
    const repo = await mkRepo();
    await createWorktree({ cwd: repo, shortId: 'cc33dd44', agentLabel: 'codex' });

    // What agent() now passes for a --worktree spawn invoked at the repo root.
    expect(await resolveWorkspace(undefined, repo)).toBe(repo);

    // Invoked from a subdir of the repo → still collapses to the repo root.
    const sub = path.join(repo, 'pkg', 'deep');
    await fs.mkdir(sub, { recursive: true });
    expect(await resolveWorkspace(undefined, await fs.realpath(sub))).toBe(repo);
  });

  test('the OLD buggy value (resolving from the worktree cwd) would NOT match the repo', async () => {
    const repo = await mkRepo();
    const wt = await createWorktree({ cwd: repo, shortId: 'ee55ff66', agentLabel: 'codex' });
    // Documents the regression: had agent() kept resolving from the worktree `cwd`,
    // the stored workspace would be the worktree path and `agi list` from the repo
    // (which resolves to `repo`) would never match it.
    const buggy = await resolveWorkspace(undefined, wt.path);
    expect(buggy).toBe(wt.path);
    expect(buggy).not.toBe(repo);
  });
});
