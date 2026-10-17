/**
 * Detached workflow runners (design §4.6): plain detached processes spawned with
 * `spawnDetached` — own session/process group, no terminal, stdout+stderr appended to
 * ~/.orc/runs/<runId>/runner.log. The runner's process identity (pid + start time) plus
 * the lease is the liveness authority. Shared by the CLI (`--detach`) and the daemon so
 * both apply the same preconditions and the same spawn-then-stamp order (D7).
 */
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { orcHome, runnerLogPath } from './paths.ts';
import {
  isPidAlive,
  isSameProcessAlive,
  processStartTime,
  selfArgv,
  spawnDetached,
  terminateProcessGroup,
} from './runtime/process.ts';
import type { SpawnDetachedOptions } from './runtime/process.ts';
import type { ProcessIdentity } from './runtime/types.ts';
import {
  isFinalStatus,
  makeLease,
  readRun,
  stampRunner,
  writeRun,
  writeRunOwned,
  WORKFLOW_SCHEMA_VERSION,
} from './runs.ts';
import type { RunnerInfo, WorkflowRun } from './run-schema.ts';
import {
  assertRecoveryAllowed,
  assertRecoveryDefinition,
  buildPlan,
  planDigest,
  reconcileRun,
  runnerLineageEnv,
  validateWorkflowDef,
} from './workflow.ts';
import type { WorkflowDef } from './workflow.ts';

/** Spawns a detached runner (default `spawnDetached`; injectable for tests). */
export type RunnerSpawner = (argv: string[], opts: SpawnDetachedOptions) => ProcessIdentity;

export interface LaunchRunnerOptions {
  /** Runner cwd (default: process.cwd(), so steps sharing cwd match a foreground run). */
  cwd?: string;
  /** Override the spawner (tests). */
  spawn?: RunnerSpawner;
}

export interface DetachedLaunch {
  runId: string;
  logPath: string;
  runner: RunnerInfo;
}

/** The detached runner could not be started; the record was not stamped. */
export class RunnerSpawnError extends Error {
  readonly code = 'RUNNER_SPAWN_FAILED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSpawnError';
  }
}

/** Hidden CLI flag marking a detached resume/retry runner (the `run` runner uses `--run-id`). */
export const RUNNER_FLAG = '--runner';

/**
 * A runner always executes on THIS host: `--local` keeps a default host (ORC_HOST or a
 * settings.toml `host`, inherited by the runner) from sending its `workflow` command remote.
 */
const RUNNER_LOCAL_FLAG = '--local';

/** The `runner` a detached runner process reports for itself. */
export function currentRunnerInfo(runId: string): RunnerInfo {
  return {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    logPath: runnerLogPath(runId),
    startedAt: new Date().toISOString(),
  };
}

/** Full child env: spawnDetached REPLACES the env, so start from ours. */
function runnerEnv(
  run: Pick<WorkflowRun, 'id' | 'rootRunId' | 'parentRunId' | 'policy' | 'deadlineAt' | 'lease'>,
): Record<string, string | undefined> {
  return { ...process.env, ORC_HOME: orcHome(), ...runnerLineageEnv(run) };
}

function spawnRunner(
  runId: string,
  argv: string[],
  run: Parameters<typeof runnerEnv>[0],
  opts: LaunchRunnerOptions,
): RunnerInfo {
  const logPath = runnerLogPath(runId);
  const spawn = opts.spawn ?? spawnDetached;
  let id: ProcessIdentity;
  try {
    id = spawn(argv, { cwd: opts.cwd ?? process.cwd(), env: runnerEnv(run), logPath });
  } catch (e) {
    throw new RunnerSpawnError((e as Error).message);
  }
  return { pid: id.pid, startTime: id.startTime, logPath, startedAt: new Date().toISOString() };
}

/** Stamp the runner after spawn; if the record moved underneath us, stop the runner. */
async function stampOrStop(
  runId: string,
  runner: RunnerInfo,
  opts: { allowCancelled?: boolean },
): Promise<WorkflowRun> {
  try {
    return await stampRunner(runId, runner, opts);
  } catch (e) {
    await terminateProcessGroup(runner, 1_000).catch(() => false);
    throw e;
  }
}

/**
 * `workflow run --detach`: validate, write the initial `running` record (so `status`
 * resolves immediately), spawn `orc workflow run <absFile> --run-id <runId>` detached,
 * then stamp `runner`. A spawn failure finalizes the pre-written record as `failed`
 * and throws RunnerSpawnError. Validation errors throw before anything is written.
 */
export async function launchDetachedRun(
  def: WorkflowDef,
  absFile: string,
  opts: LaunchRunnerOptions & { maxConcurrency?: number; defaultModels?: WorkflowRun['defaultModels']; prompt?: string } = {},
): Promise<DetachedLaunch> {
  const defForPlan: WorkflowDef =
    opts.maxConcurrency !== undefined ? { ...def, maxConcurrency: opts.maxConcurrency } : def;
  // The parent never calls runWorkflow, so validate here: a malformed workflow must fail
  // now, not spawn a doomed runner and hand back a self-orphaning runId.
  validateWorkflowDef(defForPlan);

  const runId = randomUUID().slice(0, 8);
  const plan = buildPlan(defForPlan);
  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: 0,
    id: runId,
    name: def.name,
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
    plan,
    definitionDigest: planDigest(plan),
    sourcePath: absFile,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    attempts: [],
    // Informational until the runner stamps its own identity (D4).
    lease: makeLease(),
    rootRunId: runId,
    // Authoritative: the runner (`--run-id`) runs with exactly this map (absent = none) and
    // never reads settings itself, so a detached run behaves like a foreground one. Only a
    // non-empty map is recorded; absence already means "none", so no sentinel is needed.
    ...(opts.defaultModels && Object.keys(opts.defaultModels).length > 0
      ? { defaultModels: { ...opts.defaultModels } }
      : {}),
  };
  await writeRunOwned(run);

  const argv = [...selfArgv(), RUNNER_LOCAL_FLAG, 'workflow', 'run', absFile, '--run-id', runId];
  if (opts.maxConcurrency !== undefined) argv.push('--max-concurrency', String(opts.maxConcurrency));
  let runner: RunnerInfo;
  try {
    runner = spawnRunner(runId, argv, run, opts);
  } catch (e) {
    // Finalize the record we wrote so it doesn't linger as a phantom run.
    await writeRun({ ...run, status: 'failed', finishedAt: new Date().toISOString() }).catch(() => {});
    throw e;
  }
  await stampOrStop(runId, runner, {});
  return { runId, logPath: runner.logPath, runner };
}

/**
 * Detached `resume`/`retry`: the SAME preconditions as the foreground paths — status
 * (never a `done` run; `resume` never a `cancelled` one; never over a live owner) and
 * definition (plan digest / `done` predicates / retry step) — then spawn
 * `orc workflow <action> <runId> <absFile> [--step id] --runner`, then stamp `runner` +
 * `running` (D7). Any precondition or spawn failure writes nothing.
 */
export async function launchDetachedRecovery(
  action: 'resume' | 'retry',
  runId: string,
  def: WorkflowDef,
  absFile: string,
  opts: LaunchRunnerOptions & { stepId?: string } = {},
): Promise<DetachedLaunch & { action: 'resume' | 'retry' }> {
  const existing = await readRun(runId);
  if (!existing) throw new Error(`no run found for '${runId}'`);
  assertRecoveryAllowed(await reconcileRun(existing), action);
  assertRecoveryDefinition(existing, def, {
    stepId: action === 'retry' ? opts.stepId : undefined,
    sourcePath: absFile,
  });

  const argv = [
    ...selfArgv(),
    RUNNER_LOCAL_FLAG,
    'workflow',
    action,
    runId,
    absFile,
    ...(action === 'retry' && opts.stepId ? ['--step', opts.stepId] : []),
    RUNNER_FLAG,
  ];
  const runner = spawnRunner(runId, argv, existing, opts);
  await stampOrStop(runId, runner, { allowCancelled: action === 'retry' });
  return { runId, logPath: runner.logPath, runner, action };
}

/**
 * Runner-process SIGTERM handling (D5). The returned signal aborts on SIGTERM: pass it
 * to runWorkflow/resumeWorkflow/retryWorkflow, which then stop launching, stop
 * heartbeating and return without writing. Exit after they return. As a backstop the
 * process force-exits (143) `forceExitMs` after the signal. Call dispose() when done.
 */
export function trapRunnerTermination(opts?: { forceExitMs?: number }): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const ac = new AbortController();
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  const onTerm = () => {
    if (ac.signal.aborted) return;
    ac.abort(new Error('runner received SIGTERM'));
    forceExit = setTimeout(() => process.exit(143), opts?.forceExitMs ?? 5_000);
    (forceExit as { unref?: () => void }).unref?.();
  };
  process.on('SIGTERM', onTerm);
  return {
    signal: ac.signal,
    dispose: () => {
      process.off('SIGTERM', onTerm);
      if (forceExit !== undefined) clearTimeout(forceExit);
      forceExit = undefined;
    },
  };
}

/**
 * Detached-runner handoff (called by the runner before it takes ownership): wait until
 * the launcher has stamped THIS process as the run's `runner`, so the runner's first
 * owning write never races the stamp (and the owner fence never sees the launcher's
 * placeholder lease as a rival). Gives up — returning false, letting the owner fence
 * decide — when the launcher is gone without stamping, or after `timeoutMs`.
 */
export async function awaitRunnerHandoff(
  runId: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const launcher = process.ppid;
  const deadline = Date.now() + (opts?.timeoutMs ?? 10_000);
  while (true) {
    const run = await readRun(runId).catch(() => null);
    if (run?.runner?.pid === process.pid) return true;
    if (!run || process.ppid !== launcher || !isPidAlive(launcher)) return false;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(opts?.pollMs ?? 20);
  }
}

export interface FollowRunnerLogOptions {
  /** Sink for log text (default: process.stdout). */
  write?: (text: string) => void;
  /** Poll interval (default 250 ms). */
  pollMs?: number;
  /** Stop following (e.g. SIGINT). */
  signal?: AbortSignal;
}

/**
 * Follow a detached run's runner log in-process (`orc workflow attach`): print what is
 * there, then poll-tail until the run is finalized AND its runner is gone (or `signal`
 * aborts). Resumed/retried runners append to the same log, so one follow spans them.
 * Returns the last (reconciled) record. Throws when the run has no runner log.
 */
export async function followRunnerLog(
  runId: string,
  opts: FollowRunnerLogOptions = {},
): Promise<WorkflowRun | null> {
  const first = await readRun(runId);
  if (!first) throw new Error(`no run found for '${runId}'`);
  if (!first.runner) {
    throw new Error(
      first.legacyRunnerTmux
        ? `run '${runId}' was started by a legacy tmux runner; it has no runner log`
        : `run '${runId}' has no runner log (it was not run with --detach)`,
    );
  }
  const logPath = first.runner.logPath;
  const write = opts.write ?? ((t: string) => void process.stdout.write(t));
  const pollMs = opts.pollMs ?? 250;
  const decoder = new TextDecoder();
  let offset = 0;

  const drain = async (): Promise<void> => {
    let fh: FileHandle;
    try {
      fh = await fs.open(logPath, 'r');
    } catch {
      return; // not created yet
    }
    try {
      const { size } = await fh.stat();
      if (size < offset) offset = 0; // truncated/replaced
      while (offset < size) {
        const len = Math.min(size - offset, 64 * 1024);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const text = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        if (text) write(text);
      }
    } finally {
      await fh.close();
    }
  };

  const aborted = new Promise<void>((resolve) => {
    if (opts.signal?.aborted) resolve();
    opts.signal?.addEventListener('abort', () => resolve(), { once: true });
  });

  let last: WorkflowRun | null = first;
  while (true) {
    await drain();
    if (opts.signal?.aborted) return last;
    const cur = await readRun(runId);
    last = cur ? await reconcileRun(cur) : null;
    const runnerGone = !last?.runner || !isSameProcessAlive(last.runner);
    if (!last || (isFinalStatus(last.status) && runnerGone)) {
      // Grace drain: pick up the runner's last lines even if they land just after the
      // liveness probe saw it gone.
      await drain();
      await Promise.race([Bun.sleep(pollMs), aborted]);
      await drain();
      const tail = decoder.decode();
      if (tail) write(tail);
      return last;
    }
    await Promise.race([Bun.sleep(pollMs), aborted]);
  }
}
