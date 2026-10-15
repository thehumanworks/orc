/**
 * git worktree helpers: collision-safe path+branch per agent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Raw git spawn (array argv only — never shell). Signature: (args, cwd). */
export async function gitExec(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return git(args, cwd);
}

/** git toplevel of a dir, or null if not in a repo. */
export async function gitToplevel(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top.length > 0 ? top : null;
}

/** Whether cwd is inside a git work tree. */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export interface WorktreeResult {
  path: string;
  branch: string;
}

export interface CreateWorktreeArgs {
  cwd: string;
  shortId: string;
  agentLabel: string;
  branch?: string;
  path?: string;
}

export async function createWorktree(args: CreateWorktreeArgs): Promise<WorktreeResult> {
  const toplevel = await gitToplevel(args.cwd);
  if (!toplevel) {
    throw new Error(`worktree requires cwd to be inside a git repo (cwd=${args.cwd})`);
  }
  const branch = args.branch ?? `orc/${args.agentLabel}/${args.shortId}`;
  const wtPath = args.path ?? path.join(toplevel, '.orc', 'worktrees', args.shortId);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  const r = await git(['worktree', 'add', wtPath, '-b', branch], toplevel);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const real = await fs.realpath(wtPath);
  return { path: real, branch };
}

/** Current HEAD SHA, or null if unavailable. */
export async function gitHead(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length >= 7 ? sha : null;
}

/** Alias returning undefined instead of null. */
export async function gitHeadSha(cwd: string): Promise<string | undefined> {
  return (await gitHead(cwd)) ?? undefined;
}

/**
 * Commits on HEAD since baseline SHA (`baseline..HEAD`).
 * Prefer this over hard-coded main — works on any branch.
 */
export async function commitCountSince(
  cwd: string,
  baselineSha: string | null | undefined,
): Promise<number> {
  if (!baselineSha || !baselineSha.trim()) return 0;
  const r = await git(['rev-list', '--count', `${baselineSha.trim()}..HEAD`], cwd);
  if (r.code !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Legacy helper: commits ahead of integration branch (default main). */
export async function commitCountVsMain(worktree: string, base = 'main'): Promise<number> {
  return commitCountSince(worktree, base);
}

export async function hasDiffSince(
  cwd: string,
  baselineSha: string | null | undefined,
): Promise<boolean> {
  if (!baselineSha) return false;
  const commits = await commitCountSince(cwd, baselineSha);
  if (commits > 0) return true;
  const r = await git(['diff', '--quiet', baselineSha], cwd);
  return r.code === 1;
}

export async function hasWorkingTreeChanges(cwd: string): Promise<boolean> {
  const r = await git(['status', '--porcelain'], cwd);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** The repository's shared git dir (absolute), from any of its worktrees; null when none. */
async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    await fs.access(cwd);
  } catch {
    return null;
  }
  const r = await git(['rev-parse', '--git-common-dir'], cwd);
  const out = r.stdout.trim();
  return r.code === 0 && out.length > 0 ? path.resolve(cwd, out) : null;
}

/**
 * Remove the git worktree at `wtPath`. The branch is KEPT unless `opts.branch` is given —
 * only agent()'s spawn-failure rollback deletes the branch it just created; `orc kill
 * --worktree` / `orc prune --worktree` keep it (it may hold the agent's commits).
 */
export async function removeWorktree(
  repoCwd: string,
  wtPath: string,
  opts?: { branch?: string },
): Promise<void> {
  // Resolve the repository BEFORE the worktree disappears: the branch is deleted through the
  // shared git dir, never from inside the removed directory.
  const commonDir = (await gitCommonDir(wtPath)) ?? (await gitCommonDir(repoCwd));
  const toplevel = (await gitToplevel(wtPath)) ?? (await gitToplevel(repoCwd)) ?? repoCwd;
  const r = await git(['worktree', 'remove', '--force', wtPath], toplevel);
  if (r.code !== 0 && !/is not a working tree|No such file/i.test(r.stderr)) {
    throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
  }
  const branch = opts?.branch?.trim();
  if (branch) {
    if (!commonDir) throw new Error(`git branch -D ${branch}: no repository found for ${wtPath}`);
    const dr = await git(['--git-dir', commonDir, 'branch', '-D', branch], path.dirname(commonDir));
    if (
      dr.code !== 0 &&
      !/not found|not a valid object name|checked out/i.test(dr.stderr + dr.stdout)
    ) {
      throw new Error(`git branch -D failed: ${dr.stderr.trim() || dr.stdout.trim()}`);
    }
  }
}
