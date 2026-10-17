/**
 * The MCP layer's only way to act: run the orc CLI (`orc <cmd> … --json`) as a child
 * process. argv is an array (never a shell); prompt text travels on stdin; the env is the
 * caller's minus daemon credentials; an aborted call kills the child; output is bounded.
 * The CLI's documented `--json` output is the contract the tools shape their results from.
 */
import fs from 'node:fs';
import { selfArgv } from '../runtime/process.ts';
import { MAX_CLI_CHILDREN } from './limits.ts';

/**
 * Daemon credentials never handed to a CLI child: the server's token map / shared secret,
 * and the client's bearer token. A local child may start agents (spawn, send → wake,
 * resume, workflow runners), whose environment would otherwise carry them.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = ['ORC_DAEMON_SECRET', 'ORC_DAEMON_TOKENS', 'ORC_DAEMON_TOKEN'];

/**
 * The client credentials an explicit `--host` call needs (bearer, legacy x-orc-secret).
 * Such a child is a pure HTTP client of the remote daemon: it starts no local process.
 */
export const REMOTE_CLIENT_ENV_KEYS: readonly string[] = ['ORC_DAEMON_TOKEN', 'ORC_DAEMON_SECRET'];

/** stdout kept per call; a larger output is reported instead of parsed (it is drained, not kept). */
export const MAX_CLI_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES = 64 * 1024;
/** SIGTERM → SIGKILL grace for an aborted or timed-out child. */
const KILL_GRACE_MS = 2_000;

/**
 * The env for a CLI child: string values of `base` without daemon credentials. With
 * `remote` (an explicit `--host` call) the client credentials stay: they ARE that call's
 * authentication, and a `--host` child never starts a local agent.
 */
export function childEnv(
  base: Record<string, string | undefined>,
  opts: { remote?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    if (STRIPPED_ENV_KEYS.includes(k) && !(opts.remote === true && REMOTE_CLIENT_ENV_KEYS.includes(k))) continue;
    out[k] = v;
  }
  return out;
}

/** One CLI invocation. `args` follow the orc argv prefix (`orc` itself). */
export interface CliCall {
  args: string[];
  /** Piped to the child's stdin (e.g. a prompt read with `-`); omitted = no stdin. */
  stdin?: string;
  /** The child's working directory (default: the server's). */
  cwd?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Safety net: kill the child after this long (ms). */
  timeoutMs?: number;
}

export interface CliResult {
  /** Exit code; null when the child was killed by a signal or never started. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Parsed stdout (the `--json` document), or undefined when stdout is not JSON. */
  json: unknown;
  aborted: boolean;
  timedOut: boolean;
  /** stdout exceeded MAX_CLI_STDOUT_BYTES (it was not parsed). */
  overflow: boolean;
  /** The child could not be started at all. */
  spawnError?: string;
}

export type CliRunner = (call: CliCall) => Promise<CliResult>;

/** Parse a CLI `--json` stdout: the whole document, else its last JSON line. */
export function parseCliJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const last = text.slice(text.lastIndexOf('\n') + 1);
    try {
      return JSON.parse(last) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Read a stream to the end, keeping at most `max` bytes (the rest is drained). */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (overflow || value.byteLength === 0) continue;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      overflow = true;
      continue;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), overflow };
}

/**
 * A counting semaphore for CLI children: at most `max` run at once; further calls queue in
 * order. A call whose signal aborts while queued leaves the queue without ever starting.
 */
export class ChildLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`ChildLimiter: max must be a positive integer, got ${max}`);
  }

  /** Children running now / calls waiting for a slot. */
  get running(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }

  /** Take a slot: true once granted, false if `signal` aborted first (no slot taken). */
  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve(true);
      };
      const onAbort = (): void => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  /** Give a slot back (to the next queued call, if any). */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}

/** The process-wide limit every runner shares by default (MAX_CLI_CHILDREN). */
export const SHARED_CHILD_LIMITER = new ChildLimiter(MAX_CLI_CHILDREN);

/**
 * A CliRunner that executes `[...prefix, ...call.args]`. `prefix` defaults to `selfArgv()`:
 * this orc build (the compiled binary, or `bun <repo>/src/cli/index.ts` from source). At most
 * `limiter.max` children run at once across every runner sharing the limiter (default: the
 * process-wide one); the rest wait, and an abort while waiting cancels the call.
 */
export function createCliRunner(
  prefix: readonly string[] = selfArgv(),
  opts: { limiter?: ChildLimiter } = {},
): CliRunner {
  const limiter = opts.limiter ?? SHARED_CHILD_LIMITER;
  return async (call: CliCall): Promise<CliResult> => {
    const argv = [...prefix, ...call.args];
    if (argv.some((a) => a.includes('\0'))) {
      return { ...EMPTY_RESULT, spawnError: 'an argument contains a NUL byte' };
    }
    if (!(await limiter.acquire(call.signal))) return { ...EMPTY_RESULT, aborted: true };
    try {
      return await runChild(argv, call);
    } finally {
      limiter.release();
    }
  };
}

const EMPTY_RESULT: CliResult = {
  code: null,
  signal: null,
  stdout: '',
  stderr: '',
  json: undefined,
  aborted: false,
  timedOut: false,
  overflow: false,
};

/** Run one child to completion (abort / timeout → SIGTERM, then SIGKILL after a grace). */
async function runChild(argv: string[], call: CliCall): Promise<CliResult> {
  if (call.signal?.aborted) return { ...EMPTY_RESULT, aborted: true };
  let proc: Bun.Subprocess<Blob | 'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(argv, {
      cwd: call.cwd,
      env: call.env,
      stdin: call.stdin !== undefined ? new Blob([call.stdin]) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    // A missing working directory surfaces as an ENOENT about posix_spawn of the binary:
    // name the directory instead.
    const missingCwd = call.cwd !== undefined && !fs.existsSync(call.cwd);
    const spawnError = missingCwd ? `working directory '${call.cwd}' does not exist` : (e as Error).message;
    return { ...EMPTY_RESULT, spawnError };
  }

  let aborted = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => {
    if (killTimer !== undefined || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* gone */
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, KILL_GRACE_MS);
  };
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  call.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline =
    call.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, call.timeoutMs)
      : undefined;

  try {
    const [out, err] = await Promise.all([
      readCapped(proc.stdout, MAX_CLI_STDOUT_BYTES),
      readCapped(proc.stderr, MAX_CLI_STDERR_BYTES),
    ]);
    await proc.exited;
    return {
      code: proc.exitCode,
      signal: proc.signalCode ?? null,
      stdout: out.text,
      stderr: err.text,
      json: out.overflow ? undefined : parseCliJson(out.text),
      aborted,
      timedOut,
      overflow: out.overflow,
    };
  } finally {
    call.signal?.removeEventListener('abort', onAbort);
    if (deadline !== undefined) clearTimeout(deadline);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
}
