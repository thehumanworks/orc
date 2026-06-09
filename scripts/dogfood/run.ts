#!/usr/bin/env bun
/**
 * Dogfooding harness — drives orc *through its own SDK* to implement an orc feature.
 *
 *   bun run scripts/dogfood/run.ts spawn          # spawn a claude implementer in a worktree
 *   bun run scripts/dogfood/run.ts watch <id>     # poll until DOGFOOD_COMPLETE/BLOCKED/timeout
 *
 * `spawn` reads scripts/dogfood/TASK.md and sends it as the initial prompt to a claude
 * session created in a fresh git worktree (so its edits are isolated on a branch we can
 * review + merge). `watch` is the reusable supervise-until-done loop the CLI doesn't have:
 * it tails the pane, surfaces progress, and reports the branch diff when the agent signals
 * completion. The session is left ALIVE on exit so it can be inspected / attached.
 */
import path from 'node:path';
import { agent, getSession } from '../../src/index.ts';
import type { Session } from '../../src/index.ts';

const REPO = path.resolve(import.meta.dir, '../..');
const TASK_PATH = path.join(import.meta.dir, 'TASK.md');
const POLL_MS = 20_000;
const TIMEOUT_MS = 45 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  return new Response(p.stdout).text();
}

async function report(s: Session): Promise<void> {
  const wt = s.worktreePath;
  if (!wt) return;
  console.log(`\nbranch:   ${s.branch}`);
  console.log(`worktree: ${wt}`);
  console.log('--- git log (this branch) ---');
  console.log((await gitOut(wt, ['log', '--oneline', '-6'])).trimEnd());
  console.log('--- diff --stat vs main ---');
  console.log((await gitOut(wt, ['diff', '--stat', 'main'])).trimEnd());
}

async function doSpawn(): Promise<void> {
  const task = await Bun.file(TASK_PATH).text();
  console.log('spawning claude implementer in a worktree…');
  // Boot WITHOUT pasting the (multi-KB) task: a large prompt scrolls its first line out of
  // the composer, defeating send()'s verify-before-submit probe. Instead drop the task as a
  // file OUTSIDE the worktree (under the main repo's gitignored .orc/, so the agent can't
  // accidentally commit it) and send a SHORT pointer prompt the agent reads.
  const s = await agent({ provider: 'claude', cwd: REPO, worktree: true });
  const taskFile = path.join(REPO, '.orc', `dogfood-task-${s.id}.md`);
  await Bun.write(taskFile, task);
  await s.send(
    `Your task is fully specified in this file: ${taskFile}\n` +
      `Read it in full first, then carry it out exactly, end to end. Begin now.`,
  );
  console.log(
    JSON.stringify(
      { id: s.id, tmuxName: s.tmuxName, worktree: s.worktreePath, branch: s.branch, taskFile },
      null,
      2,
    ),
  );
  console.log(`\nnext: bun run scripts/dogfood/run.ts watch ${s.id}`);
}

/** Commits on the branch ahead of main: 0 at spawn (branch starts at main's tip), ≥1 once committed. */
async function revCount(wt: string): Promise<number> {
  const n = parseInt((await gitOut(wt, ['rev-list', '--count', 'main..HEAD'])).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function doWatch(id: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastTail = '';
  let poll = 0;
  let idleStreak = 0;
  while (Date.now() < deadline) {
    poll++;
    const s = await getSession(id);
    if (!s) {
      console.log(`no session found for '${id}'`);
      return;
    }
    const status = await s.status().catch(() => 'dead');
    let pane = '';
    try {
      pane = await s.capture();
    } catch {
      /* pane may be gone */
    }
    const commits = s.worktreePath ? await revCount(s.worktreePath) : 0;

    // DONE requires BOTH a commit on the branch AND the agent's final sentinel in the live
    // pane. We do NOT match the transcript: TASK.md (the prompt) itself contains the literal
    // sentinel strings, which echo into the pane/transcript from poll 1 — so a plain string
    // match would false-complete immediately. The commit gate defeats that echo (commits===0
    // until the agent commits); requiring the sentinel too defeats an early WIP commit (the
    // agent is told to emit it only when finished). By the time real work is committed, the
    // instruction echo has scrolled out of the visible pane.
    const done = commits >= 1 && pane.includes('DOGFOOD_COMPLETE');
    // BLOCKED is pane-only and time-gated past the initial echo (and only when nothing's
    // been committed). Lower-stakes: the progress tail lets us intervene with `agi send`.
    const blocked = poll > 6 && commits === 0 ? pane.match(/DOGFOOD_BLOCKED:[^\n]*/) : null;
    // Idle detection: claude shows "esc to interrupt" only during an active turn. When that
    // vanishes the agent has YIELDED — either finished, or waiting on input (a stall, e.g.
    // the nested-CLI verification). Two consecutive idle polls (≈40s) past startup, with no
    // completion, means: wake the operator to inspect/intervene rather than block for 45m.
    const idle = pane.length > 0 && !pane.includes('esc to interrupt');
    idleStreak = idle ? idleStreak + 1 : 0;

    const tail = pane
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-3)
      .join(' | ');
    if (tail && tail !== lastTail) {
      console.log(
        `[${new Date().toISOString()}] status=${status} commits=${commits} … ${tail.slice(0, 220)}`,
      );
      lastTail = tail;
    }

    if (done) {
      console.log('\n=== DOGFOOD_COMPLETE (committed + signalled) ===');
      await report(s);
      return;
    }
    if (blocked) {
      console.log(`\n=== ${blocked[0]} ===`);
      await report(s);
      return;
    }
    if (poll > 2 && idleStreak >= 2) {
      console.log(
        `\n=== AGENT IDLE without completion (yielded after a turn; commits=${commits}) — inspect/intervene ===`,
      );
      await report(s);
      return;
    }
    if (status === 'dead') {
      console.log('\nsession died before signalling completion');
      await report(s);
      return;
    }
    await sleep(POLL_MS);
  }
  console.log('\nwatch timed out');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'spawn') {
  await doSpawn();
} else if (cmd === 'watch' && arg) {
  await doWatch(arg);
} else {
  console.log('usage: run.ts spawn | watch <id>');
  process.exit(1);
}
