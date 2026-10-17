import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorktree } from '../src/worktree.ts';
import { upsertRecord, readRegistry } from '../src/registry.ts';
import { pruneSessions } from '../src/index.ts';
import type { SessionRecord } from '../src/types.ts';
import { plainCliEnv } from './runtime-helpers.ts';

/**
 * `orc kill --worktree` and `orc prune --worktree` remove the session's checkout but KEEP its
 * branch (it may hold the agent's commits). Only agent()'s spawn-failure rollback deletes the
 * branch (test/agent-worktree-rollback.test.ts).
 */

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const tmpDirs: string[] = [];
const prevHome = process.env.ORC_HOME;

afterAll(async () => {
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return out;
}

async function setup(): Promise<{ repo: string; rec: SessionRecord }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orc-keep-branch-')));
  tmpDirs.push(base);
  process.env.ORC_HOME = path.join(base, 'orc');
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  await git(['init', '-q'], repo);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
  const id = `kb${Math.random().toString(16).slice(2, 8)}`;
  const wt = await createWorktree({ cwd: repo, shortId: id, agentLabel: 'claude' });
  // The agent committed on its branch.
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work'], wt.path);
  // No spawn.json: kill/prune skip the kernel and only handle the record and the worktree.
  const rec: SessionRecord = {
    id,
    sessionId: `${id}-0000-0000-0000-000000000000`,
    provider: 'claude',
    cwd: wt.path,
    worktreePath: wt.path,
    branch: wt.branch,
    workspace: repo,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
  await upsertRecord(rec);
  return { repo, rec };
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const branchHead = (repo: string, branch: string) => git(['rev-parse', '--verify', '-q', branch], repo);

describe('worktree removal keeps the branch', () => {
  test('orc kill --worktree removes the worktree dir and keeps the branch', async () => {
    const { repo, rec } = await setup();
    const head = (await branchHead(repo, rec.branch!)).trim();
    const p = Bun.spawn([process.execPath, CLI, 'kill', rec.id, '--worktree', '--json'], {
      cwd: repo,
      env: plainCliEnv({ ...process.env, ORC_HOME: process.env.ORC_HOME }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, id: rec.id });
    expect(await exists(rec.worktreePath!)).toBe(false);
    expect((await git(['worktree', 'list', '--porcelain'], repo)).includes(rec.worktreePath!)).toBe(false);
    expect((await branchHead(repo, rec.branch!)).trim()).toBe(head);
  }, 30_000);

  test('orc prune --worktree removes the worktree dir and keeps the branch', async () => {
    const { repo, rec } = await setup();
    const head = (await branchHead(repo, rec.branch!)).trim();
    const pruned = await pruneSessions({ removeWorktree: true, liveness: () => 'dead' });
    expect(pruned).toEqual([rec.id]);
    expect(await readRegistry()).toEqual([]);
    expect(await exists(rec.worktreePath!)).toBe(false);
    expect((await branchHead(repo, rec.branch!)).trim()).toBe(head);
  }, 30_000);
});
