/**
 * Process primitives for the tmux-free runtime: detached spawn (new session, no
 * controlling terminal, stdio → log file), pid-reuse-safe identity, process-group kill,
 * and how orc re-executes itself (`orc __actor`, detached workflow runners).
 *
 * POSIX only (macOS + Linux). No PTY anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessIdentity } from './types.ts';

export interface SpawnDetachedOptions {
  cwd: string;
  /** Full environment for the child. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** stdout+stderr are appended here (created 0600). */
  logPath: string;
}

/**
 * Spawn `argv` fully detached: its own session + process group (setsid via
 * `detached: true`), no controlling terminal, stdin ignored, stdout/stderr appended to
 * `logPath`, and unref'd so the caller may exit immediately. The child survives the
 * caller's exit, SIGKILL and terminal hang-up.
 */
export function spawnDetached(argv: string[], opts: SpawnDetachedOptions): ProcessIdentity {
  if (argv.length === 0) throw new Error('spawnDetached: empty argv');
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  const fd = fs.openSync(opts.logPath, 'a', 0o600);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as Record<string, string>,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      detached: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  proc.unref();
  return { pid: proc.pid, startTime: processStartTime(proc.pid) };
}

/**
 * argv prefix that re-executes this orc build: the compiled binary itself, or
 * `bun <repo>/src/cli/index.ts` when running from source (also when orc is used as an
 * SDK from someone else's script — never relies on Bun.main).
 */
export function selfArgv(): string[] {
  if (isCompiledBinary()) return [process.execPath];
  return [process.execPath, cliEntryPath()];
}

/** True inside a `bun build --compile` binary. */
export function isCompiledBinary(): boolean {
  const p = import.meta.path;
  return p.startsWith('/$bunfs/') || p.includes('~BUN');
}

/** Absolute path of the CLI entry when running from source. */
export function cliEntryPath(): string {
  return path.resolve(import.meta.dir, '..', 'cli', 'index.ts');
}

/**
 * Opaque start-time token for `pid`, or null when the process does not exist / cannot
 * be inspected. Linux: /proc/<pid>/stat field 22 (clock ticks since boot). macOS (and
 * Linux fallback): `ps -o lstart=` (1 s resolution — adequate as a reuse guard).
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may contain spaces/parens: parse after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest[0] is field 3 (state) → field 22 is rest[19].
    const ticks = rest[19];
    if (ticks && /^\d+$/.test(ticks)) return `proc:${ticks}`;
  } catch {
    // no procfs (macOS) or process gone — fall through to ps.
  }
  try {
    const r = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } as Record<string, string>,
    });
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out.length > 0) return `ps:${out}`;
  } catch {
    // ps missing — unknown.
  }
  return null;
}

/** kill(pid, 0) semantics: alive (or alive but not ours → EPERM). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/**
 * True when `id` still names the SAME process: pid alive and (when a start time was
 * recorded) the start time matches. A recycled pid reports false.
 */
export function isSameProcessAlive(id: ProcessIdentity | undefined | null): boolean {
  if (!id || !isPidAlive(id.pid)) return false;
  if (id.startTime === null) return true;
  const now = processStartTime(id.pid);
  return now === null ? true : now === id.startTime;
}

/** Signal a whole process group (pgid === leader pid). Missing group is not an error. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal pgid ${pgid}`);
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ESRCH') return false;
    throw e;
  }
}

/**
 * Terminate the process group led by `id` iff it is still the same process: SIGTERM,
 * wait up to `graceMs`, then SIGKILL. Returns true when something was signalled.
 */
export async function terminateProcessGroup(
  id: ProcessIdentity | undefined | null,
  graceMs = 2_000,
): Promise<boolean> {
  if (!id || !isSameProcessAlive(id)) return false;
  signalProcessGroup(id.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(id.pid)) return true;
    await Bun.sleep(50);
  }
  signalProcessGroup(id.pid, 'SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isPidAlive(id.pid)) await Bun.sleep(25);
  return true;
}
