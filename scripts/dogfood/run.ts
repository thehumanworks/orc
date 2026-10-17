#!/usr/bin/env bun
/**
 * Dogfooding harness — drives orc *through its own SDK* to implement an orc feature.
 *
 *   bun scripts/dogfood/run.ts spawn <task-file> [provider]   # implementer in a fresh worktree
 *   bun scripts/dogfood/run.ts watch <id>                     # supervise until it ends
 *
 * `spawn` copies the task file under the repo's gitignored `.orc/` (outside the worktree, so the
 * agent can't commit it) and sends a short pointer to it. `watch` blocks on the session's
 * journal-derived state (`waitForResult`) and stops when:
 *   - the branch has a commit AND the agent's last reply contains DOGFOOD_COMPLETE (done),
 *   - the last reply contains `DOGFOOD_BLOCKED: <reason>`,
 *   - the agent yields without either (a question or a stall: steer it with `orc send <id>`),
 *   - the last turn failed, or the session is no longer live, or the timeout passes.
 * Only the agent's own replies are matched (the prompt is a `turn.intent`, never assistant
 * text), so the sentinels echoed by the task file can't false-trigger. The session is left
 * alive for inspection (`orc read`, `orc attach`).
 */
import path from 'node:path';
import { agent, getSession, lastAssistantText } from '../../src/index.ts';
import type { Session, Provider } from '../../src/index.ts';

const REPO = path.resolve(import.meta.dir, '../..');
const POLL_MS = 20_000;
const TIMEOUT_MS = 45 * 60_000;

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

async function doSpawn(taskFileArg: string, provider: Provider): Promise<void> {
  const taskPath = path.resolve(taskFileArg);
  const task = await Bun.file(taskPath).text();
  console.log(`spawning ${provider} implementer in a worktree for ${path.basename(taskPath)}…`);
  const s = await agent({ provider, cwd: REPO, worktree: true });
  const taskFile = path.join(REPO, '.orc', `dogfood-task-${s.id}.md`);
  await Bun.write(taskFile, task);
  const sent = await s.send(
    `Your task is fully specified in this file: ${taskFile}\n` +
      `Read it in full first, then carry it out exactly, end to end. Begin now.`,
    { messageId: `dogfood-${s.id}` },
  );
  console.log(
    JSON.stringify({ id: s.id, worktree: s.worktreePath, branch: s.branch, taskFile, delivery: sent.phase }, null, 2),
  );
  console.log(`\nnext: bun scripts/dogfood/run.ts watch ${s.id}`);
}

/** Commits on the branch ahead of main: 0 at spawn (branch starts at main's tip), ≥1 once committed. */
async function revCount(wt: string): Promise<number> {
  const n = parseInt((await gitOut(wt, ['rev-list', '--count', 'main..HEAD'])).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

async function doWatch(id: string): Promise<void> {
  const s = await getSession(id);
  if (!s) {
    console.log(`no session found for '${id}'`);
    process.exit(1);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  let lastReply = '';
  while (Date.now() < deadline) {
    const r = await s.waitForResult({ timeoutMs: Math.min(POLL_MS, deadline - Date.now()) });
    const commits = s.worktreePath ? await revCount(s.worktreePath) : 0;
    const reply = lastAssistantText(s.journal({ tail: 500 })) ?? '';
    if (reply && reply !== lastReply) {
      const oneLine = reply.replace(/\s+/g, ' ').slice(0, 220);
      console.log(`[${new Date().toISOString()}] ${r.state} commits=${commits} … ${oneLine}`);
      lastReply = reply;
    }
    if (!r.settled) continue; // still running: keep waiting

    const d = await s.stateDetail();
    const blocked = reply.match(/DOGFOOD_BLOCKED:[^\n]*/);
    if (r.state === 'done' && commits >= 1 && reply.includes('DOGFOOD_COMPLETE')) {
      console.log('\n=== DOGFOOD_COMPLETE (committed + signalled) ===');
    } else if (blocked) {
      console.log(`\n=== ${blocked[0]} ===`);
    } else if (r.state === 'done') {
      console.log(`\n=== AGENT YIELDED without completion (commits=${commits}) — read it and steer with \`orc send ${s.id}\` ===`);
    } else if (r.state === 'waiting') {
      console.log('\n=== AGENT WAITING on a permission request — read it and re-instruct ===');
    } else if (d.stopped || d.suspended) {
      console.log(`\n=== session ${d.stopped ? 'stopped' : 'suspended'} before signalling completion ===`);
    } else {
      console.log(`\n=== last turn failed: ${d.lastTurn?.error ?? 'unknown error'} ===`);
    }
    await report(s);
    return;
  }
  console.log('\nwatch timed out');
}

const [cmd, arg, arg2] = process.argv.slice(2);
if (cmd === 'spawn' && arg) {
  await doSpawn(arg, (arg2 as Provider) ?? 'claude');
} else if (cmd === 'watch' && arg) {
  await doWatch(arg);
} else {
  console.log('usage: bun scripts/dogfood/run.ts spawn <task-file> [provider] | watch <id>');
  process.exit(1);
}
