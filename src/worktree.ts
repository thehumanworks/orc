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
  /** realpath of the created worktree (used as cwd). */
  path: string;
  branch: string;
}

export interface CreateWorktreeArgs {
  cwd: string;
  /** Short, collision-resistant id (e.g. first chars of the session uuid). */
  shortId: string;
  /** Label used in the branch name (sanitized provider/agent label). */
  agentLabel: string;
  branch?: string;
  path?: string;
}

/**
 * Create a fresh worktree. Default path `<repo>/.orc/worktrees/<shortId>`, branch
 * `orc/<agentLabel>/<shortId>`. The path must not pre-exist and the branch must be unique.
 */
export async function createWorktree(args: CreateWorktreeArgs): Promise<WorktreeResult> {
  const toplevel = await gitToplevel(args.cwd);
  if (!toplevel) {
    throw new Error(`worktree requires cwd to be inside a git repo (cwd=${args.cwd})`);
  }
  const branch = args.branch ?? `orc/${args.agentLabel}/${args.shortId}`;
  const wtPath = args.path ?? path.join(toplevel, '.orc', 'worktrees', args.shortId);

  // Ensure parent dir exists (the worktree path itself must NOT pre-exist).
  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  const r = await git(['worktree', 'add', wtPath, '-b', branch], toplevel);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  // realpath of the created worktree (claude slug + codex cwd match need realpath).
  const real = await fs.realpath(wtPath);
  return { path: real, branch };
}

/**
 * Count commits on a worktree's branch ahead of `base` (default `main`):
 * `git -C <worktree> rev-list --count base..HEAD`. This is the HARD success signal a
 * workflow step uses (a commit is evidence the agent did real work — a yield alone is
 * not). Returns 0 when the ref can't be resolved (e.g. no `base` branch) so an
 * unverifiable worktree never falsely reports success. v1 assumes the integration
 * branch is `main`, matching the dogfood harness and DESIGN-workflows.md.
 */
export async function commitCountVsMain(worktree: string, base = 'main'): Promise<number> {
  const r = await git(['rev-list', '--count', `${base}..HEAD`], worktree);
  if (r.code !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Remove a worktree (force) and optionally delete its branch.
 * Resolves the git toplevel from `wtPath` first so logical `--workspace` strings
 * (non-repo paths) still work when `repoCwd` is not a git directory.
 */
export async function removeWorktree(
  repoCwd: string,
  wtPath: string,
  opts?: { branch?: string },
): Promise<void> {
  const toplevel = (await gitToplevel(wtPath)) ?? (await gitToplevel(repoCwd)) ?? repoCwd;
  const r = await git(['worktree', 'remove', '--force', wtPath], toplevel);
  if (r.code !== 0 && !/is not a working tree|No such file/i.test(r.stderr)) {
    throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
  }
  const branch = opts?.branch?.trim();
  if (branch) {
    const dr = await git(['branch', '-D', branch], toplevel);
    if (dr.code !== 0 && !/not found|not a valid object name|checked out/i.test(dr.stderr + dr.stdout)) {
      throw new Error(`git branch -D failed: ${dr.stderr.trim() || dr.stdout.trim()}`);
    }
  }
}
