/**
 * Shared helpers for the actor-kernel tests (not a test file itself).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JournalEntry, SpawnSpec } from '../src/runtime/types.ts';
import type { FakeScript } from '../src/runtime/providers/fake.ts';
import { readJournal } from '../src/runtime/journal.ts';
import { readActorState } from '../src/runtime/actor-state.ts';
import { processStartTime } from '../src/runtime/process.ts';

export const LAUNCHER = path.join(import.meta.dir, 'fixtures', 'runtime-launcher.ts');

/**
 * A start-time token that does NOT match this live process, from the SAME source as its
 * real one (`proc:` with procfs, `ps:` elsewhere, e.g. macOS). isSameProcessAlive treats
 * tokens from different sources as not comparable and falls back to pid liveness, so a
 * pid-reuse test must mismatch within the source this host produces.
 */
export function mismatchedStartTime(): string {
  const own = processStartTime(process.pid);
  if (own === null) throw new Error(`cannot read this process's start time (pid ${process.pid})`);
  return own.startsWith('proc:') ? 'proc:1' : 'ps:Thu Jan  1 00:00:00 1970';
}

export function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fakeSpec(cwd: string, script: FakeScript = {}, sessionId: string = randomUUID()): SpawnSpec {
  return {
    version: 1,
    sessionId,
    provider: 'fake',
    cwd,
    env: { ORC_TEST_MARKER: sessionId },
    fakeScript: script,
    createdAt: new Date().toISOString(),
  };
}

/** Poll `fn` until it returns a truthy value; throws `label` on timeout. */
export async function waitFor<T>(fn: () => T | undefined | null | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await Bun.sleep(20);
  }
}

export function waitForEntry(
  sid: string,
  pred: (e: JournalEntry) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<JournalEntry> {
  return waitFor(() => readJournal(sid).find(pred), label, timeoutMs);
}

export function entries<T extends JournalEntry['type']>(
  sid: string,
  type: T,
  messageId?: string,
): Extract<JournalEntry, { type: T }>[] {
  return readJournal(sid).filter(
    (e) => e.type === type && (messageId === undefined || (e as { messageId?: string }).messageId === messageId),
  ) as Extract<JournalEntry, { type: T }>[];
}

export function waitCompleted(sid: string, messageId: string, timeoutMs = 10_000): Promise<JournalEntry> {
  return waitForEntry(
    sid,
    (e) => e.type === 'turn.completed' && e.messageId === messageId,
    `turn.completed ${messageId}`,
    timeoutMs,
  );
}

export function actorPid(sid: string): number {
  const pid = readActorState(sid)?.lease?.pid;
  if (!pid) throw new Error(`no lease recorded for ${sid}`);
  return pid;
}

interface ProcRow {
  pid: number;
  cmd: string;
}

/**
 * Live (non-zombie) processes whose command line contains `needle`. A child that was
 * forked but has not exec'd yet still shows its parent's command line, so matches whose
 * parent also matches are dropped.
 */
export function liveProcs(needle: string): ProcRow[] {
  const rows: Array<ProcRow & { ppid: number }> = [];
  if (fs.existsSync('/proc/self/stat')) {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[0] === 'Z' || fields[0] === 'X') continue;
        const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim();
        if (cmd.includes(needle)) rows.push({ pid: Number(name), ppid: Number(fields[1]), cmd });
      } catch {
        /* raced with exit */
      }
    }
  } else {
    const r = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,stat=,command='], { stdout: 'pipe' });
    for (const line of r.stdout.toString().split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m || m[3]!.startsWith('Z')) continue;
      if (m[4]!.includes(needle)) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[4]! });
    }
  }
  const pids = new Set(rows.map((r) => r.pid));
  return rows.filter((r) => !pids.has(r.ppid)).map(({ pid, cmd }) => ({ pid, cmd }));
}

export const fakeProviderPids = (sid: string) =>
  liveProcs(`fake-child.ts --orc-session ${sid}`).map((r) => r.pid);
export const actorPids = (sid: string) => liveProcs(`__actor ${sid}`).map((r) => r.pid);

/** SIGKILL every actor/provider process (and its group) belonging to these sessions. */
export async function killSessionProcesses(sids: string[]): Promise<void> {
  for (const sid of sids) {
    for (const pid of [...actorPids(sid), ...fakeProviderPids(sid)]) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* not a group leader / gone */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  await waitFor(
    () => sids.every((s) => actorPids(s).length === 0 && fakeProviderPids(s).length === 0),
    'session processes to exit',
    5_000,
  ).catch(() => undefined);
}

/** Run the launcher fixture to completion: returns parsed stdout JSON. */
export async function runLauncher(args: string[]): Promise<{ code: number; out: unknown; stderr: string; pid: number }> {
  const proc = Bun.spawn([process.execPath, LAUNCHER, ...args], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  let out: unknown;
  try {
    out = JSON.parse(stdout.trim() || 'null');
  } catch {
    out = stdout;
  }
  return { code, out, stderr, pid: proc.pid };
}
