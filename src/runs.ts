/**
 * Workflow-run persistence with revision/CAS and owner leases.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertValidRunId, runsDir, runPath } from './paths.ts';
import { withLock } from './lock.ts';
import { isSameProcessAlive, processStartTime } from './runtime/process.ts';
import type { ProcessIdentity } from './runtime/types.ts';
import type {
  AttemptPhase,
  PlanStep,
  RunLease,
  RunnerInfo,
  OwnerLease,
  StepAttempt,
  StepResult,
  WorkflowPlan,
  WorkflowRun,
  WorkflowRunStatus,
} from './run-schema.ts';
import type { AgentState, ExecutionPolicy, Provider } from './types.ts';
import type { DeliveryPhase } from './messages.ts';

export type {
  AttemptPhase,
  PlanStep,
  RunLease,
  RunnerInfo,
  OwnerLease,
  StepAttempt,
  StepResult,
  WorkflowPlan,
  WorkflowRun,
  WorkflowRunStatus,
} from './run-schema.ts';

/**
 * Current on-disk schema.
 * - v1: legacy steps-only
 * - v2: plan + attempts + leases
 * - v3: outcomes, verify observations, artifacts, turn events
 * - v4: persisted DAG dependencies and maxConcurrency
 * - v5: detached runners are plain processes: `runner { pid, startTime, logPath,
 *       startedAt }` replaces the tmux runner name (top-level and on the lease); the lease
 *       carries the owner's `startTime`. A legacy tmux runner name normalizes to the
 *       read-only `legacyRunnerTmux` marker (= dead runner → orphaned, resumable).
 * Missing schemaVersion on read ⇒ treat as v1. Old records still normalize.
 */
export const WORKFLOW_SCHEMA_VERSION = 5;
export const RUN_SCHEMA_VERSION = WORKFLOW_SCHEMA_VERSION;
export const DEFAULT_LEASE_MS = 60_000;

export class CasConflictError extends Error {
  readonly code = 'CAS_CONFLICT' as const;
  readonly runId: string;
  readonly expected: number;
  readonly actual: number;
  constructor(runId: string, expected: number, actual: number) {
    super(`run '${runId}' CAS conflict: expected revision ${expected}, actual ${actual}`);
    this.name = 'CasConflictError';
    this.runId = runId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class FinalizedRunError extends Error {
  readonly code = 'FINALIZED' as const;
  constructor(runId: string, status: string) {
    super(`run '${runId}' is already finalized (${status}); cannot downgrade`);
    this.name = 'FinalizedRunError';
  }
}

/** Another live detached runner already owns the run. */
export class LiveOwnerError extends Error {
  readonly code = 'LIVE_OWNER' as const;
  constructor(runId: string, pid: number) {
    super(`run '${runId}' still has a live owner (runner pid ${pid}); wait or cancel first`);
    this.name = 'LiveOwnerError';
  }
}

const FINAL = new Set<WorkflowRunStatus>(['done', 'failed', 'orphaned', 'cancelled']);

export function isFinalStatus(status: WorkflowRunStatus): boolean {
  return FINAL.has(status);
}
export function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return isFinalStatus(status);
}

export function isActiveAttemptPhase(phase: AttemptPhase): boolean {
  return !['succeeded', 'failed', 'cancelled', 'abandoned', 'blocked', 'skipped'].includes(phase);
}

export function isSuccessAttemptPhase(phase: AttemptPhase): boolean {
  return phase === 'succeeded';
}

let selfStartTimeMemo: string | null | undefined;
/** This process's start-time token (memoized: on macOS it shells out to `ps`). */
function selfStartTime(): string | null {
  if (selfStartTimeMemo === undefined) selfStartTimeMemo = processStartTime(process.pid);
  return selfStartTimeMemo;
}

/**
 * A fresh owner lease. Identity defaults to THIS process (pid + start time); pass
 * `pid`/`startTime` to stamp another owner (e.g. a just-spawned detached runner).
 */
export function makeLease(opts?: {
  ownerId?: string;
  pid?: number;
  startTime?: string | null;
  nowMs?: number;
  leaseMs?: number;
}): RunLease {
  const now = opts?.nowMs ?? Date.now();
  const leaseMs = opts?.leaseMs ?? DEFAULT_LEASE_MS;
  const pid = opts?.pid ?? process.pid;
  const startTime =
    opts?.startTime !== undefined ? opts.startTime : pid === process.pid ? selfStartTime() : null;
  return {
    ownerId: opts?.ownerId ?? randomUUID().slice(0, 12),
    pid,
    startTime,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
  };
}

export function heartbeatLease(lease: RunLease, leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now()): RunLease {
  return {
    ...lease,
    pid: process.pid,
    startTime: selfStartTime(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
  };
}

/**
 * Owner liveness of a lease (design §4.6): the lease must not be expired AND its owner
 * process must be alive. Owner = `runner` when given (a detached runner is the liveness
 * authority; `lease.pid` is then informational), else the lease's own identity
 * (`pid` + `startTime` when recorded — pid-reuse safe). `runnerAlive` is an explicit
 * override (true/false) for callers that already probed the owner.
 */
export function isLeaseLive(
  lease: RunLease | undefined,
  optsOrNow?:
    | number
    | {
        nowMs?: number;
        runnerAlive?: boolean | null;
        runner?: ProcessIdentity | null;
        checkPid?: boolean;
      },
): boolean {
  if (!lease) return false;
  const opts = typeof optsOrNow === 'number' ? { nowMs: optsOrNow } : optsOrNow ?? {};
  const now = opts.nowMs ?? Date.now();
  const exp = Date.parse(lease.expiresAt);
  if (!Number.isFinite(exp) || now >= exp) return false;
  if (opts.runnerAlive === false) return false;
  if (opts.runnerAlive === true) return true;
  if (opts.runner) return isSameProcessAlive(opts.runner);
  if (opts.checkPid !== false && lease.pid !== undefined && lease.pid > 0) {
    if (!isSameProcessAlive({ pid: lease.pid, startTime: lease.startTime ?? null })) return false;
  }
  return true;
}

export type OwnerLiveness = 'live' | 'expired' | 'finalized' | 'unknown';

export function classifyOwnerLiveness(
  run: Pick<WorkflowRun, 'status' | 'lease'> & Partial<Pick<WorkflowRun, 'runner' | 'legacyRunnerTmux'>>,
  opts?: { nowMs?: number; runnerAlive?: boolean | null; checkPid?: boolean },
): OwnerLiveness {
  if (isFinalStatus(run.status) && run.status !== 'orphaned') return 'finalized';
  if (run.status === 'orphaned') return 'expired';
  const runnerAlive =
    opts?.runnerAlive !== undefined && opts.runnerAlive !== null
      ? opts.runnerAlive
      : run.legacyRunnerTmux && !run.runner
        ? false
        : null;
  if (runnerAlive === false) return 'expired';
  if (!run.lease && !run.runner) return 'unknown';
  if (!run.lease) return (runnerAlive ?? isSameProcessAlive(run.runner)) ? 'live' : 'expired';
  const live = isLeaseLive(run.lease, {
    nowMs: opts?.nowMs,
    runnerAlive,
    runner: run.runner ?? null,
    checkPid: opts?.checkPid,
  });
  return live ? 'live' : 'expired';
}

export function projectStepsFromAttempts(attempts: StepAttempt[]): StepResult[] {
  const byStep = new Map<string, StepAttempt>();
  for (const a of attempts) {
    const prev = byStep.get(a.stepId);
    if (!prev || a.attemptNumber >= prev.attemptNumber) byStep.set(a.stepId, a);
  }
  const order: string[] = [];
  for (const a of attempts) {
    if (!order.includes(a.stepId)) order.push(a.stepId);
  }
  const out: StepResult[] = [];
  for (const stepId of order) {
    const a = byStep.get(stepId)!;
    if (a.result) {
      out.push(a.result);
      continue;
    }
    out.push({
      id: stepId,
      sessionId: a.sessionId ?? '',
      provider: a.provider,
      state: a.phase === 'succeeded' ? 'done' : a.phase === 'waiting' ? 'waiting' : 'failed',
      ok: a.phase === 'succeeded',
      commitsAhead: 0,
    });
  }
  return out;
}

export function latestAttempt(run: WorkflowRun, stepId: string): StepAttempt | undefined {
  let best: StepAttempt | undefined;
  for (const a of run.attempts ?? []) {
    if (a.stepId !== stepId) continue;
    if (!best || a.attemptNumber > best.attemptNumber) best = a;
  }
  return best;
}

export function patchAttempt(run: WorkflowRun, attempt: StepAttempt): WorkflowRun {
  const attempts = [...(run.attempts ?? [])];
  const i = attempts.findIndex((a) => a.attemptId === attempt.attemptId);
  if (i >= 0) attempts[i] = attempt;
  else attempts.push(attempt);
  return { ...run, attempts, steps: projectStepsFromAttempts(attempts) };
}

export function normalizeRun(raw: unknown): WorkflowRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.name !== 'string') return null;
  if (typeof o.startedAt !== 'string') return null;
  const status = o.status;
  if (
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed' &&
    status !== 'orphaned' &&
    status !== 'cancelled'
  ) {
    return null;
  }
  const steps: StepResult[] = [];
  if (Array.isArray(o.steps)) {
    for (const s of o.steps) {
      const nr = normalizeStepResult(s);
      if (nr) steps.push(nr);
    }
  }
  const run: WorkflowRun = {
    schemaVersion:
      typeof o.schemaVersion === 'number' && Number.isFinite(o.schemaVersion)
        ? Math.max(1, Math.floor(o.schemaVersion))
        : 1,
    revision:
      typeof o.revision === 'number' && Number.isFinite(o.revision) && o.revision >= 0
        ? Math.floor(o.revision)
        : 0,
    id: o.id,
    name: o.name,
    startedAt: o.startedAt,
    status,
    steps,
  };
  if (typeof o.finishedAt === 'string') run.finishedAt = o.finishedAt;
  const runner = normalizeRunner(o.runner);
  if (runner) run.runner = runner;
  if (typeof o.definitionDigest === 'string') run.definitionDigest = o.definitionDigest;
  if (typeof o.sourcePath === 'string') run.sourcePath = o.sourcePath;
  if (typeof o.workflowSourcePath === 'string') run.workflowSourcePath = o.workflowSourcePath;
  if (typeof o.rootRunId === 'string') run.rootRunId = o.rootRunId;
  if (typeof o.parentRunId === 'string') run.parentRunId = o.parentRunId;
  if (typeof o.deadlineAt === 'string') run.deadlineAt = o.deadlineAt;
  if (typeof o.cancelledAt === 'string') run.cancelledAt = o.cancelledAt;
  if (typeof o.cancelReason === 'string') run.cancelReason = o.cancelReason;
  if (o.policy && typeof o.policy === 'object') run.policy = o.policy as ExecutionPolicy;
  if (o.plan && typeof o.plan === 'object') {
    const p = o.plan as Record<string, unknown>;
    if (typeof p.name === 'string' && Array.isArray(p.steps)) {
      const planSteps: PlanStep[] = [];
      for (const s of p.steps) {
        if (!s || typeof s !== 'object') continue;
        const ps = s as Record<string, unknown>;
        if (typeof ps.id !== 'string' || typeof ps.provider !== 'string') continue;
        const step: PlanStep = { id: ps.id, provider: ps.provider as Provider };
        if (typeof ps.alias === 'string') step.alias = ps.alias;
        if (typeof ps.taskFile === 'string') step.taskFile = ps.taskFile;
        if (typeof ps.prompt === 'string') step.prompt = ps.prompt;
        if (typeof ps.worktree === 'boolean') step.worktree = ps.worktree;
        if (typeof ps.cwd === 'string') step.cwd = ps.cwd;
        if (typeof ps.timeoutMs === 'number') step.timeoutMs = ps.timeoutMs;
        if (typeof ps.continueOnFail === 'boolean') step.continueOnFail = ps.continueOnFail;
        if (Array.isArray(ps.needs)) {
          step.needs = ps.needs.filter((n): n is string => typeof n === 'string');
        }
        if (typeof ps.hasDonePredicate === 'boolean') step.hasDonePredicate = ps.hasDonePredicate;
        if (ps.verify && typeof ps.verify === 'object') {
          (step as any).verify = ps.verify as PlanStep['verify'];
        }
        if (typeof ps.allowUnverified === 'boolean') (step as any).allowUnverified = ps.allowUnverified;
        if (Array.isArray(ps.outputs)) (step as any).outputs = ps.outputs as PlanStep['outputs'];
        if (Array.isArray(ps.inputs)) (step as any).inputs = ps.inputs as PlanStep['inputs'];
        if (ps.turns && typeof ps.turns === 'object') (step as any).turns = ps.turns as PlanStep['turns'];
        planSteps.push(step);
      }
      const plan: import('./run-schema.ts').WorkflowPlan = { name: p.name, steps: planSteps };
      if (
        typeof p.maxConcurrency === 'number' &&
        Number.isFinite(p.maxConcurrency) &&
        Number.isInteger(p.maxConcurrency) &&
        p.maxConcurrency >= 1
      ) {
        plan.maxConcurrency = p.maxConcurrency;
      }
      run.plan = plan;
    }
  }
  if (Array.isArray(o.attempts)) {
    const attempts: StepAttempt[] = [];
    for (const a of o.attempts) {
      const att = normalizeAttempt(a);
      if (att) attempts.push(att);
    }
    run.attempts = attempts;
  }
  if (o.lease && typeof o.lease === 'object') {
    const l = o.lease as Record<string, unknown>;
    if (typeof l.ownerId === 'string' && typeof l.updatedAt === 'string' && typeof l.expiresAt === 'string') {
      run.lease = {
        ownerId: l.ownerId,
        pid: typeof l.pid === 'number' ? l.pid : 0,
        ...(typeof l.startTime === 'string' || l.startTime === null
          ? { startTime: l.startTime as string | null }
          : {}),
        updatedAt: l.updatedAt,
        expiresAt: l.expiresAt,
      };
    }
  }
  // v4 → v5: a legacy tmux runner name (top level or on the lease) becomes a read-only
  // marker — a dead runner — unless a v5 `runner` is present.
  if (!run.runner) {
    const legacy = legacyTmuxRunnerName(o);
    if (legacy) run.legacyRunnerTmux = legacy;
  }
  // Ensure steps projection when only attempts exist.
  if (run.steps.length === 0 && run.attempts && run.attempts.length > 0) {
    run.steps = projectStepsFromAttempts(run.attempts);
  }
  return run;
}

/** Validate a persisted `runner`; anything malformed is dropped. */
function normalizeRunner(raw: unknown): RunnerInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return undefined;
  if (!(typeof r.startTime === 'string' || r.startTime === null)) return undefined;
  if (typeof r.logPath !== 'string' || r.logPath.length === 0) return undefined;
  if (typeof r.startedAt !== 'string') return undefined;
  return { pid: r.pid, startTime: r.startTime, logPath: r.logPath, startedAt: r.startedAt };
}

/** Pre-v5 records named their tmux runner at the top level and/or on the lease. */
function legacyTmuxRunnerName(o: Record<string, unknown>): string | undefined {
  const top = o.runnerTmux;
  if (typeof top === 'string' && top.length > 0) return top;
  const lease = o.lease as Record<string, unknown> | undefined;
  const onLease = lease && typeof lease === 'object' ? lease.runnerTmux : undefined;
  if (typeof onLease === 'string' && onLease.length > 0) return onLease;
  return undefined;
}

function normalizeStepOutcome(v: unknown): import('./run-schema.ts').StepOutcome | undefined {
  if (
    v === 'succeeded' ||
    v === 'failed' ||
    v === 'needs_input' ||
    v === 'unverified' ||
    v === 'timed_out' ||
    v === 'cancelled'
  ) {
    return v;
  }
  return undefined;
}

function normalizeStepResult(raw: unknown): StepResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.provider !== 'string') return null;
  const result: StepResult = {
    id: r.id,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
    provider: r.provider as Provider,
    state: (typeof r.state === 'string' ? r.state : 'failed') as AgentState,
    ok: r.ok === true,
    commitsAhead: typeof r.commitsAhead === 'number' ? r.commitsAhead : 0,
  };
  if (typeof r.worktree === 'string') result.worktree = r.worktree;
  if (typeof r.branch === 'string') result.branch = r.branch;
  if (r.unverified === true) result.unverified = true;
  const outcome = normalizeStepOutcome(r.outcome);
  if (outcome) (result as any).outcome = outcome;
  if (typeof (r as any).baselineSha === 'string') (result as any).baselineSha = r.baselineSha;
  if (typeof (r as any).cwd === 'string') (result as any).cwd = r.cwd;
  if (typeof (r as any).resultPath === 'string') (result as any).resultPath = r.resultPath;
  if (r.artifacts && typeof (r as any).artifacts === 'object' && !Array.isArray(r.artifacts)) {
    (result as any).artifacts = r.artifacts as any;
  }
  if (Array.isArray(r.observations)) {
    (result as any).observations = r.observations as any;
  }
  if (r.envelope && typeof (r as any).envelope === 'object') {
    (result as any).envelope = r.envelope as any;
  }
  return result;
}

function normalizeAttempt(raw: unknown): StepAttempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.attemptId !== 'string' || typeof x.stepId !== 'string') return null;
  if (typeof x.provider !== 'string' || typeof x.phase !== 'string') return null;
  if (typeof x.attemptNumber !== 'number') return null;
  const createdAt =
    typeof x.createdAt === 'string'
      ? x.createdAt
      : typeof x.startedAt === 'string'
        ? x.startedAt
        : new Date(0).toISOString();
  const att: StepAttempt = {
    attemptId: x.attemptId,
    attemptNumber: x.attemptNumber,
    stepId: x.stepId,
    provider: x.provider as Provider,
    phase: x.phase as AttemptPhase,
    createdAt,
    startedAt: typeof x.startedAt === 'string' ? x.startedAt : createdAt,
    updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : createdAt,
  };
  if (typeof x.finishedAt === 'string') att.finishedAt = x.finishedAt;
  if (typeof x.sessionId === 'string') att.sessionId = x.sessionId;
  if (typeof x.messageId === 'string') att.messageId = x.messageId;
  else if (typeof x.deliveryMessageId === 'string') att.messageId = x.deliveryMessageId;
  if (typeof x.deliveryMessageId === 'string') att.deliveryMessageId = x.deliveryMessageId;
  if (typeof x.deliveryPhase === 'string') att.deliveryPhase = x.deliveryPhase as DeliveryPhase;
  if (typeof x.errorCategory === 'string') att.errorCategory = x.errorCategory;
  if (typeof x.errorMessage === 'string') att.errorMessage = x.errorMessage;
  if (x.result && typeof x.result === 'object') {
    const nr = normalizeStepResult(x.result);
    if (nr) att.result = nr;
  }
  const outcome = normalizeStepOutcome(x.outcome);
  if (outcome) att.outcome = outcome;
  if (typeof x.baselineSha === 'string') att.baselineSha = x.baselineSha;
  if (typeof x.resultPath === 'string') att.resultPath = x.resultPath;
  if (Array.isArray(x.observations)) {
    att.observations = x.observations as StepAttempt['observations'];
  }
  if (Array.isArray(x.turns)) {
    att.turns = x.turns as StepAttempt['turns'];
  }
  return att;
}

async function writeRunUnlocked(run: WorkflowRun): Promise<void> {
  assertValidRunId(run.id);
  const dir = runsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = runPath(run.id);
  const tmp = path.join(dir, `.run.${randomUUID()}.tmp`);
  // The legacy tmux-runner marker is read-only: never persisted.
  const { legacyRunnerTmux: _legacy, ...rest } = run;
  const stamped: WorkflowRun = {
    ...rest,
    schemaVersion: run.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
    revision: run.revision ?? 0,
  };
  await Bun.write(tmp, JSON.stringify(stamped, null, 2));
  await fs.rename(tmp, target);
}

export async function writeRun(run: WorkflowRun): Promise<void> {
  assertValidRunId(run.id);
  await withLock(`run:${run.id}`, async () => {
    await writeRunUnlocked(run);
  });
}

export async function casWriteRun(expectedRevision: number, next: WorkflowRun): Promise<WorkflowRun> {
  assertValidRunId(next.id);
  return withLock(`run:${next.id}`, async () => {
    const current = await readRunUnlocked(next.id);
    if (!current) {
      if (expectedRevision !== 0) throw new CasConflictError(next.id, expectedRevision, -1);
      const stamped: WorkflowRun = { ...next, schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: 1 };
      await writeRunUnlocked(stamped);
      return stamped;
    }
    const curRev = current.revision ?? 0;
    if (curRev !== expectedRevision) throw new CasConflictError(next.id, expectedRevision, curRev);
    if (isFinalStatus(current.status) && !isFinalStatus(next.status)) {
      throw new FinalizedRunError(next.id, current.status);
    }
    const stamped: WorkflowRun = {
      ...next,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: expectedRevision + 1,
    };
    await writeRunUnlocked(stamped);
    return stamped;
  });
}

export async function writeRunCAS(run: WorkflowRun, expectedRevision: number): Promise<WorkflowRun> {
  return casWriteRun(expectedRevision, run);
}

export async function updateRun(
  runId: string,
  mutatorOrRev: number | ((run: WorkflowRun | null) => WorkflowRun | null),
  maybeMutator?: (run: WorkflowRun) => WorkflowRun,
): Promise<WorkflowRun | null> {
  assertValidRunId(runId);
  if (typeof mutatorOrRev === 'number') {
    const expectedRevision = mutatorOrRev;
    const mutator = maybeMutator;
    if (!mutator) throw new Error('updateRun CAS form requires a mutator');
    return withLock(`run:${runId}`, async () => {
      const current = await readRunUnlocked(runId);
      if (!current) throw new Error(`no run found for '${runId}'`);
      const curRev = current.revision ?? 0;
      if (curRev !== expectedRevision) throw new CasConflictError(runId, expectedRevision, curRev);
      const next = mutator(structuredClone(current) as WorkflowRun);
      if (isFinalStatus(current.status) && !isFinalStatus(next.status)) {
        throw new FinalizedRunError(runId, current.status);
      }
      next.schemaVersion = WORKFLOW_SCHEMA_VERSION;
      next.revision = expectedRevision + 1;
      if (next.attempts && next.attempts.length > 0) {
        next.steps = projectStepsFromAttempts(next.attempts);
      }
      await writeRunUnlocked(next);
      return next;
    });
  }
  const mutator = mutatorOrRev;
  return withLock(`run:${runId}`, async () => {
    const current = await readRunUnlocked(runId);
    const next = mutator(current);
    if (next === null) return current;
    if (current && isFinalStatus(current.status) && !isFinalStatus(next.status)) return current;
    const written: WorkflowRun = {
      ...next,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: (current?.revision ?? 0) + 1,
    };
    if (written.attempts && written.attempts.length > 0) {
      written.steps = projectStepsFromAttempts(written.attempts);
    }
    await writeRunUnlocked(written);
    return written;
  });
}

export async function updateRunRetry(
  runId: string,
  mutator: (current: WorkflowRun) => WorkflowRun | null,
  opts?: { retries?: number },
): Promise<WorkflowRun> {
  const retries = opts?.retries ?? 8;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    const current = await readRun(runId);
    if (!current) throw new Error(`no run found for '${runId}'`);
    const draft = mutator(current);
    if (draft === null) return current;
    try {
      return await writeRunCAS(draft, current.revision ?? 0);
    } catch (e) {
      if (e instanceof CasConflictError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('updateRunRetry exhausted');
}

/**
 * Owning-runner write. Refuses to downgrade ANY finalized status to non-final, and never
 * overwrites a `cancelled` run with another status (a runner finishing concurrently
 * with `orc workflow cancel` must not resurrect it as done/failed).
 * Resume/retry must call `beginRunRecovery` first to explicitly reopen failed/orphaned
 * (or cancelled with allowCancelled) into a controlled running recovery state.
 */
export async function writeRunOwned(run: WorkflowRun): Promise<WorkflowRun> {
  assertValidRunId(run.id);
  return withLock(`run:${run.id}`, async () => {
    const current = await readRunUnlocked(run.id);
    if (current?.status === 'cancelled' && run.status !== 'cancelled') {
      throw new FinalizedRunError(run.id, current.status);
    }
    if (current && isFinalStatus(current.status) && !isFinalStatus(run.status)) {
      const reopen =
        run.status === 'running' &&
        (current.status === 'failed' || current.status === 'orphaned');
      if (!reopen) throw new FinalizedRunError(run.id, current.status);
    }
    const rev = current ? (current.revision ?? 0) + 1 : (run.revision ?? 0);
    const stamped: WorkflowRun = { ...run, schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: rev };
    await writeRunUnlocked(stamped);
    return stamped;
  });
}

/**
 * Explicit controlled recovery for resume/retry: transition failed/orphaned
 * (and optionally cancelled) → running under the run lock. Does not open `done`.
 * Subsequent writes go through writeRunOwned with full terminal protection restored.
 */
export async function beginRunRecovery(
  runId: string,
  opts?: {
    ownerId?: string;
    leaseMs?: number;
    /**
     * The detached runner performing the recovery (stamped on the record; it becomes
     * the liveness authority). Omitted ⇒ the calling process owns it via the lease and
     * any previous (dead) runner is dropped.
     */
    runner?: RunnerInfo;
    reason?: 'resume' | 'retry' | string;
    allowCancelled?: boolean;
  },
): Promise<WorkflowRun> {
  assertValidRunId(runId);
  return withLock(`run:${runId}`, async () => {
    const current = await readRunUnlocked(runId);
    if (!current) throw new Error(`no run found for '${runId}'`);
    if (current.status === 'done') {
      throw new FinalizedRunError(runId, current.status);
    }
    if (current.status === 'running') {
      return current;
    }
    if (current.status === 'cancelled' && !opts?.allowCancelled) {
      throw new Error(
        `run '${runId}' is cancelled; use retryWorkflow (with recovery) to create new attempts`,
      );
    }
    if (
      current.status !== 'failed' &&
      current.status !== 'orphaned' &&
      current.status !== 'cancelled'
    ) {
      return current;
    }
    const lease = makeLease({
      ownerId: opts?.ownerId ?? current.lease?.ownerId,
      ...(opts?.runner ? { pid: opts.runner.pid, startTime: opts.runner.startTime } : {}),
      leaseMs: opts?.leaseMs ?? DEFAULT_LEASE_MS,
    });
    const { runner: _previousRunner, ...rest } = current;
    const stamped: WorkflowRun = {
      ...rest,
      ...(opts?.runner ? { runner: opts.runner } : {}),
      status: 'running',
      finishedAt: undefined,
      cancelledAt: undefined,
      lease,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: (current.revision ?? 0) + 1,
    };
    await writeRunUnlocked(stamped);
    return stamped;
  });
}

function sameProcess(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return !!a && a.pid === b.pid && (a.startTime ?? null) === (b.startTime ?? null);
}

/**
 * Stamp a just-spawned detached runner onto its run record — called AFTER a successful
 * spawn (nothing to revert when spawn fails). Under the run lock:
 * - the runner already stamped itself (same pid + start time) → no write;
 * - `done`, or `cancelled` without `allowCancelled` → FinalizedRunError, nothing written
 *   (the caller should terminate the runner it spawned);
 * - `running` owned by a DIFFERENT live runner → LiveOwnerError, nothing written;
 * - otherwise → `running` (reopening failed/orphaned[/cancelled]) with `runner` and a
 *   fresh lease whose identity is the runner's.
 */
export async function stampRunner(
  runId: string,
  runner: RunnerInfo,
  opts?: { allowCancelled?: boolean; leaseMs?: number },
): Promise<WorkflowRun> {
  assertValidRunId(runId);
  return withLock(`run:${runId}`, async () => {
    const current = await readRunUnlocked(runId);
    if (!current) throw new Error(`no run found for '${runId}'`);
    if (sameProcess(current.runner, runner)) return current;
    if (current.status === 'done') throw new FinalizedRunError(runId, current.status);
    if (current.status === 'cancelled' && !opts?.allowCancelled) {
      throw new FinalizedRunError(runId, current.status);
    }
    if (current.status === 'running' && current.runner && isSameProcessAlive(current.runner)) {
      throw new LiveOwnerError(runId, current.runner.pid);
    }
    const reopening = current.status !== 'running';
    const stamped: WorkflowRun = {
      ...current,
      status: 'running',
      finishedAt: undefined,
      ...(reopening ? { cancelledAt: undefined } : {}),
      runner,
      lease: makeLease({
        ownerId: current.lease?.ownerId,
        pid: runner.pid,
        startTime: runner.startTime,
        leaseMs: opts?.leaseMs ?? DEFAULT_LEASE_MS,
      }),
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: (current.revision ?? 0) + 1,
    };
    await writeRunUnlocked(stamped);
    return stamped;
  });
}

export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`run:${runId}`, fn);
}

async function readRunUnlocked(runId: string): Promise<WorkflowRun | null> {
  assertValidRunId(runId);
  const f = Bun.file(runPath(runId));
  if (!(await f.exists())) return null;
  try {
    return normalizeRun(await f.json());
  } catch {
    return null;
  }
}

export async function readRun(runId: string): Promise<WorkflowRun | null> {
  return readRunUnlocked(runId);
}

export async function listRuns(): Promise<WorkflowRun[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir());
  } catch {
    return [];
  }
  const runs: WorkflowRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const run = await readRun(name.slice(0, -'.json'.length)).catch(() => null);
    if (run) runs.push(run);
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return runs;
}
