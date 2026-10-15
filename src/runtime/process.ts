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
import { ensurePrivateDir } from '../private-fs.ts';

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
  ensurePrivateDir(path.dirname(opts.logPath));
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

let procfsAvailable: boolean | undefined;
function hasProcfs(): boolean {
  if (procfsAvailable === undefined) {
    try {
      procfsAvailable = fs.readFileSync('/proc/self/stat', 'utf8').length > 0;
    } catch {
      procfsAvailable = false;
    }
  }
  return procfsAvailable;
}

/**
 * Opaque start-time token for `pid`, or null when the process does not exist / cannot
 * be inspected. Linux: /proc/<pid>/stat field 22 (clock ticks since boot). macOS:
 * `ps -o lstart=` (1 s resolution — adequate as a reuse guard).
 *
 * The token SOURCE is fixed per host: on a procfs host a transient read failure returns
 * null (unknown → treated as "same process" by isSameProcessAlive) rather than a `ps:`
 * token that could never equal a stored `proc:` token and would make a live process
 * look recycled.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens: parse after the LAST ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // rest[0] is field 3 (state) → field 22 is rest[19].
      const ticks = rest[19];
      if (ticks && /^\d+$/.test(ticks)) return `proc:${ticks}`;
    } catch {
      // process gone or transiently unreadable — unknown.
    }
    return null;
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

/** POSIX env for `ps` so `lstart` tokens are stable (C locale, UTC). */
const PS_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC' } as Record<string, string>;

export interface ProcessProbe {
  /** Kernel state letter(s): `R`, `S`, `Z`… (null when unreadable). */
  state: string | null;
  /** Same token format as processStartTime (null when unreadable). */
  startTime: string | null;
}

/**
 * State + start-time token in ONE probe: Linux reads /proc/<pid>/stat once; elsewhere one
 * `ps -o lstart=,stat=` call. null when the process is gone (or cannot be inspected).
 */
export function probeProcess(pid: number): ProcessProbe | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = rest[19];
      return {
        state: rest[0] || null,
        startTime: ticks && /^\d+$/.test(ticks) ? `proc:${ticks}` : null,
      };
    } catch {
      return null;
    }
  }
  try {
    const r = Bun.spawnSync(['ps', '-o', 'lstart=,stat=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: PS_ENV,
    });
    const out = r.stdout.toString().trim();
    if (r.exitCode !== 0 || out.length === 0) return null;
    // `lstart` is a fixed 5-field date; `stat` is the last whitespace-separated token.
    const m = /^(.*\S)\s+(\S+)$/.exec(out);
    if (!m) return { state: null, startTime: null };
    return { state: m[2]!, startTime: `ps:${m[1]!}` };
  } catch {
    return null;
  }
}

function zombieState(state: string | null | undefined): boolean {
  return !!state && (state.startsWith('Z') || state.startsWith('X'));
}

function killZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/**
 * A dead-but-unreaped process. kill(pid, 0) succeeds on zombies, and orphans are never
 * reaped when PID 1 is not a real init (common in containers).
 */
export function isZombie(pid: number): boolean {
  return zombieState(probeProcess(pid)?.state);
}

/**
 * Alive and not a zombie: kill(pid, 0) semantics (alive, or alive but not ours → EPERM),
 * minus unreaped zombies (Linux: /proc state; elsewhere one `ps` call).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!killZero(pid)) return false;
  return !isZombie(pid);
}

/**
 * True when `id` still names the SAME live process: pid alive, not a zombie and (when a
 * start time was recorded) the start time matches. A recycled pid reports false. One
 * probe per call (procfs read / one `ps`).
 */
export function isSameProcessAlive(id: ProcessIdentity | undefined | null): boolean {
  if (!id || !Number.isInteger(id.pid) || id.pid <= 0 || !killZero(id.pid)) return false;
  const probe = probeProcess(id.pid);
  if (!probe) return true; // kill(0) says alive; transiently uninspectable → unknown = same
  if (zombieState(probe.state)) return false;
  if (id.startTime === null || probe.startTime === null) return true;
  // Tokens from different sources (e.g. a record written on another host type) are not
  // comparable — fall back to pid liveness rather than declaring the process recycled.
  if (probe.startTime.split(':', 1)[0] !== id.startTime.split(':', 1)[0]) return true;
  return probe.startTime === id.startTime;
}

/** Alias used by the actor kernel: same (pid + start time), live, non-zombie process. */
export const isLiveProcess = isSameProcessAlive;

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

/** Signal the group led by `pid`; if there is no such group (ESRCH), signal the pid itself. */
function signalGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  try {
    if (signalProcessGroup(pid, signal)) return;
  } catch {
    /* EPERM / invalid pgid: try the process itself */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* gone */
  }
}

/**
 * Terminate the process group led by `id` iff it is still the same live process:
 * SIGTERM, wait up to graceMs, then SIGKILL. A pid that is not a group leader (ESRCH on
 * the group) is signalled directly. Once the leader is gone, stragglers in its group are
 * SIGKILLed (the pgid stays valid — and unreusable — while members remain). Zombie-aware:
 * an unreaped leader counts as gone. Returns true when something was signalled.
 */
export async function terminateGroup(id: ProcessIdentity | undefined | null, graceMs = 2_000): Promise<boolean> {
  if (!id || !isSameProcessAlive(id)) return false;
  signalGroupOrPid(id.pid, 'SIGTERM');
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline && isSameProcessAlive(id)) await Bun.sleep(25);
  if (isSameProcessAlive(id)) {
    signalGroupOrPid(id.pid, 'SIGKILL');
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && isSameProcessAlive(id)) await Bun.sleep(25);
  }
  try {
    signalProcessGroup(id.pid, 'SIGKILL');
  } catch {
    /* no group members left */
  }
  return true;
}
