/**
 * orc workflows — the layer above `agent()` that sequences multiple agent steps
 * RELIABLY. This is the CORE runner: foreground execution + persisted run records.
 * Backgrounding (`--detach`) and a `logs` reader are a separate later task; the run
 * record persists enough state (per-step session id, state, ok, commitsAhead) that
 * such a reader can be bolted on without changing the runner.
 *
 * The runner GENERALIZES the hardcoded one-step proto-workflow in
 * scripts/dogfood/run.ts, and inherits its hard-won lessons (encoded as behavior):
 *  - Completion is a HARD signal (a commit / explicit predicate), never a string match
 *    of the agent's own narration — see `evaluateStep` and the CRITICAL note below.
 *  - Sequencing uses F1's debounced `Session.waitFor`, never an ad-hoc sleep/pane poll.
 *  - Large instructions are delivered as a file + a SHORT pointer (the send() multi-KB
 *    paste bug), dropped OUTSIDE any worktree — see `deliverInstructions`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agent } from './agent.ts';
import { Session } from './session.ts';
import { commitCountVsMain } from './worktree.ts';
import { validateAlias } from './registry.ts';
import { writeRun } from './runs.ts';
import { assertValidRunId, runInstructionsDir } from './paths.ts';
import { sanitizeTmuxName } from './drivers/tmux.ts';
import { getDriver } from './drivers/driver.ts';
import type { Driver } from './drivers/driver.ts';
import type { Turn } from './transcript.ts';
import type { AgentState, Provider } from './types.ts';
import type { WaitForResult } from './session.ts';

const VALID_PROVIDERS: Provider[] = ['claude', 'codex', 'pi'];
const DEFAULT_STEP_TIMEOUT_MS = 600_000;
/** Inline prompts larger than this are delivered via file + pointer (the send() bug). */
const LARGE_PROMPT_BYTES = 1024;

export interface WorkflowStep {
  /** Unique within the workflow. */
  id: string;
  provider: Provider;
  /** Optional workspace-scoped session alias for the spawned step agent. */
  alias?: string;
  /** Path to a spec file (PREFERRED for long instructions). */
  taskFile?: string;
  /** Inline prompt (small only). Exactly one of taskFile|prompt must be set. */
  prompt?: string;
  /** Create a fresh git worktree for this step (default false). */
  worktree?: boolean;
  /** Working dir. May interpolate a prior step's field, e.g. '${implement.worktree}'. */
  cwd?: string;
  /** Per-step waitFor timeout (default 600000). */
  timeoutMs?: number;
  /** Explicit success predicate (see the CRITICAL note on `evaluateStep`). */
  done?: (ctx: StepDoneCtx) => boolean;
  /** Default false → a failed step stops the run. */
  continueOnFail?: boolean;
}

export interface StepDoneCtx {
  /** The settled state from waitFor: 'done' = yielded (NOT "succeeded"). */
  state: AgentState;
  /** Commits on the step's worktree branch ahead of main (0 if no worktree). */
  commitsAhead: number;
  /** The live pane capture at settle time. */
  capture: string;
}

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
}

export interface StepResult {
  id: string;
  /** Short session handle (resolves via `orc read`/`getSession`); '' if spawn failed. */
  sessionId: string;
  provider: Provider;
  state: AgentState;
  ok: boolean;
  worktree?: string;
  branch?: string;
  commitsAhead: number;
  /** True when `ok` was inferred from a yield with NO real success signal. */
  unverified?: boolean;
}

export interface WorkflowRun {
  id: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  /**
   * Lifecycle. `running`/`done`/`failed` are written by the runner itself. `orphaned` is
   * NEVER written by the runner — it's a read-time reconcile verdict (see
   * `reconcileRunStatus`): a record still says `running` but its `runnerTmux` session is
   * gone, so the runner died mid-run.
   */
  status: 'running' | 'done' | 'failed' | 'orphaned';
  /**
   * Name of the detached tmux session that owns this run (`orc-wf-<runId>`), when the run
   * was launched with `--detach`. Used by status/list liveness reconcile and by
   * `orc workflow attach`. Absent for a plain foreground run (nothing to reattach/reconcile).
   */
  runnerTmux?: string;
  steps: StepResult[];
}

/** Streamed progress events. The CLI renders these; tests collect them. */
export type WorkflowEvent =
  | { type: 'run-start'; runId: string; name: string; steps: number }
  | { type: 'step-start'; runId: string; stepId: string; provider: Provider }
  | { type: 'step-done'; runId: string; result: StepResult }
  | { type: 'step-warn'; runId: string; stepId: string; message: string }
  | { type: 'step-error'; runId: string; stepId: string; error: string }
  | { type: 'run-done'; runId: string; status: WorkflowRun['status']; run: WorkflowRun };

/** Internal step executor (the spawn-and-evaluate unit). The injectable seam. */
export type StepExecutor = (args: {
  step: WorkflowStep;
  runId: string;
  emit: (e: WorkflowEvent) => void;
}) => Promise<StepResult>;

export interface RunWorkflowOptions {
  onEvent?: (e: WorkflowEvent) => void;
  /**
   * Override the per-step executor. Defaults to the real agent spawn. Tests inject a
   * fake that returns canned `StepResult`s so the runner's pure logic (ordering,
   * `${...}` interpolation, status transitions) is exercisable without live agents.
   */
  execStep?: StepExecutor;
  /**
   * Use this runId INSTEAD of generating one. The entrypoint a detached runner executes
   * (`orc workflow run <file> --run-id <id>`) passes the id minted by `--detach` so both
   * sides agree on the record path.
   */
  runId?: string;
  /**
   * The detached runner's own tmux session name (`orc-wf-<runId>`), threaded onto the
   * persisted record so status/list liveness reconcile can find the session. The runner
   * re-persists the record from scratch on run-start, so it must re-supply this or the
   * field the `--detach` parent wrote would be wiped.
   */
  runnerTmux?: string;
}

/**
 * Validate a workflow def's shape: name + non-empty steps, unique ids, a valid provider,
 * and EXACTLY ONE of taskFile|prompt per step. `runWorkflow` calls this too, so a
 * plain-object def loaded by `orc workflow run` (no `defineWorkflow` import required) is
 * still checked. Throws a clear error on the first problem.
 */
export function validateWorkflowDef(def: WorkflowDef): void {
  if (!def || typeof def !== 'object') {
    throw new Error('workflow: definition must be an object with { name, steps }');
  }
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('workflow: `name` is required');
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    throw new Error(`workflow '${def.name}': \`steps\` must be a non-empty array`);
  }
  const seen = new Set<string>();
  def.steps.forEach((step, i) => {
    if (!step || typeof step.id !== 'string' || step.id.length === 0) {
      throw new Error(`workflow '${def.name}': step #${i} is missing a string \`id\``);
    }
    if (seen.has(step.id)) {
      throw new Error(`workflow '${def.name}': duplicate step id '${step.id}'`);
    }
    seen.add(step.id);
    if (!VALID_PROVIDERS.includes(step.provider)) {
      throw new Error(
        `workflow '${def.name}' step '${step.id}': invalid provider '${step.provider}' (claude|codex|pi)`,
      );
    }
    try {
      validateAlias(step.alias);
    } catch (e) {
      throw new Error(`workflow '${def.name}' step '${step.id}': ${(e as Error).message}`);
    }
    const hasTask = typeof step.taskFile === 'string' && step.taskFile.length > 0;
    const hasPrompt = typeof step.prompt === 'string' && step.prompt.length > 0;
    if (hasTask === hasPrompt) {
      throw new Error(
        `workflow '${def.name}' step '${step.id}': set exactly one of \`taskFile\` or \`prompt\``,
      );
    }
  });
}

/** Identity helper with validation — gives authors editor types + an early error. */
export function defineWorkflow(def: WorkflowDef): WorkflowDef {
  validateWorkflowDef(def);
  return def;
}

const REF = /\$\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\}/g;

/**
 * Interpolate `${stepId.field}` references against prior step results. Only PRIOR steps
 * are resolvable (the map only contains steps that have already run). Throws loudly on
 * an unknown step or an absent/empty field (e.g. `${x.worktree}` for a non-worktree
 * step) — a misconfigured reference must surface, not silently become ''.
 */
export function interpolate(template: string, resultsById: Record<string, StepResult>): string {
  return template.replace(REF, (whole, stepId: string, field: string) => {
    const result = resultsById[stepId];
    if (!result) {
      throw new Error(
        `interpolation: unknown step '${stepId}' in '${whole}' — only PRIOR step ids are resolvable`,
      );
    }
    const value = (result as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`interpolation: step '${stepId}' has no value for field '${field}' (in '${whole}')`);
    }
    return String(value);
  });
}

/** A clone of `step` with cwd/prompt/taskFile interpolated against prior results. */
function resolveStep(step: WorkflowStep, resultsById: Record<string, StepResult>): WorkflowStep {
  const subst = (s: string | undefined) => (s === undefined ? undefined : interpolate(s, resultsById));
  return { ...step, cwd: subst(step.cwd), prompt: subst(step.prompt), taskFile: subst(step.taskFile) };
}

/**
 * CRITICAL — `state === 'done'` means the turn YIELDED (ready for input), NOT that the
 * step succeeded: an agent that asks a clarifying question and stops is
 * pane-indistinguishable from one that finished (a documented F1 limitation —
 * `waitFor` returns `done`, not `waiting`, for a question). So:
 *  - `step.done` provided      → ok = step.done(ctx)                       (author's call)
 *  - else worktree step        → ok = state==='done' && commitsAhead >= 1  (the commit IS the evidence)
 *  - else (no predicate, no wt) → ok = state==='done', but `unverified` — there is NO
 *    universal success signal, so we NEVER silently equate yield with success; the
 *    runner emits a loud warning for this case.
 */
export function evaluateStep(
  step: Pick<WorkflowStep, 'done' | 'worktree'>,
  ctx: StepDoneCtx,
): { ok: boolean; unverified: boolean } {
  if (step.done) return { ok: step.done(ctx), unverified: false };
  if (step.worktree) return { ok: ctx.state === 'done' && ctx.commitsAhead >= 1, unverified: false };
  const ok = ctx.state === 'done';
  // unverified only when we actually INFERRED success from a yield (ok via state==='done').
  // A non-'done' state here is an honest failure, not an unverified success.
  return { ok, unverified: ok };
}

/** Map a debounced wait result + hard signals into a step outcome (exported for tests). */
export function stepOutcomeFromWait(
  step: Pick<WorkflowStep, 'done' | 'worktree'>,
  wait: WaitForResult,
  ctx: Omit<StepDoneCtx, 'state'>,
): { state: AgentState; ok: boolean; unverified?: boolean } {
  if (!wait.settled) {
    return { state: wait.state, ok: false };
  }
  const fullCtx: StepDoneCtx = { state: wait.state, ...ctx };
  const { ok, unverified } = evaluateStep(step, fullCtx);
  return { state: wait.state, ok, unverified: unverified || undefined };
}

/**
 * Drop a step's instruction text to a file OUTSIDE any worktree (~/.orc/runs/<runId>/)
 * and return its absolute path, so the agent reads it by pointer and can't commit it.
 */
async function dropInstructionFile(runId: string, stepId: string, body: string): Promise<string> {
  const dir = runInstructionsDir(runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stepId}.md`);
  await Bun.write(file, body);
  return file;
}

/**
 * Deliver a step's instructions to a freshly-booted session. RELIABILITY: a taskFile, or
 * a large inline prompt (>~1KB), is delivered as a file + a SHORT pointer — a multi-KB
 * initial prompt is dropped by send()'s verify-before-submit probe (a known bug). Small
 * inline prompts are sent verbatim. Exported (it takes only the narrow `send` surface) so
 * the file+pointer paths are unit-testable with a stub session, without a live agent.
 */
export async function deliverInstructions(
  session: Pick<Session, 'send'>,
  step: WorkflowStep,
  runId: string,
): Promise<void> {
  if (step.taskFile) {
    const resolved = path.isAbsolute(step.taskFile)
      ? step.taskFile
      : path.resolve(process.cwd(), step.taskFile);
    const f = Bun.file(resolved);
    if (!(await f.exists())) {
      throw new Error(`step '${step.id}': taskFile not found: ${resolved}`);
    }
    const dropped = await dropInstructionFile(runId, step.id, await f.text());
    await session.send(
      `Your task is fully specified in this file: ${dropped}\n` +
        `Read it in full first, then carry it out exactly, end to end. Begin now.`,
    );
    return;
  }
  const prompt = step.prompt ?? '';
  if (Buffer.byteLength(prompt, 'utf8') > LARGE_PROMPT_BYTES) {
    const dropped = await dropInstructionFile(runId, step.id, prompt);
    await session.send(
      `Your instructions are in this file: ${dropped}\n` +
        `Read it in full and do exactly what it says. Begin now.`,
    );
    return;
  }
  await session.send(prompt);
}

/**
 * The real step executor: spawn the agent → deliver instructions → `waitFor` settle →
 * compute the hard signals → evaluate. Leaves the session ALIVE on purpose (v1 choice):
 * the record stays in the registry so a human can `orc attach`/`orc read` it and a later
 * `orc workflow logs` can read its transcript. Callers tear sessions down explicitly.
 */
const defaultExecStep: StepExecutor = async ({ step, runId, emit }) => {
  const session = await agent({
    provider: step.provider,
    alias: step.alias,
    cwd: step.cwd,
    worktree: step.worktree ? true : undefined,
    // No initial prompt: instructions are delivered via send() (file+pointer when large).
  });
  await deliverInstructions(session, step, runId);

  const wait = await session.waitForResult({
    until: ['done', 'waiting', 'failed'],
    timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
  });
  const commitsAhead = session.worktreePath ? await commitCountVsMain(session.worktreePath) : 0;
  const capture = await session.capture().catch(() => '');
  const { state, ok, unverified } = stepOutcomeFromWait(step, wait, { commitsAhead, capture });

  void emit; // warnings are emitted centrally by runWorkflow from the result.
  return {
    id: step.id,
    sessionId: session.id,
    provider: step.provider,
    state,
    ok,
    commitsAhead,
    worktree: session.worktreePath,
    branch: session.branch,
    unverified: unverified || undefined,
  };
};

/**
 * Run a workflow to completion in the foreground. Persists a `WorkflowRun` to
 * ~/.orc/runs/<runId>.json and RE-PERSISTS after every step transition (crash-inspectable).
 * Steps run strictly in order; a failed step stops the run unless `continueOnFail`.
 */
export async function runWorkflow(def: WorkflowDef, opts: RunWorkflowOptions = {}): Promise<WorkflowRun> {
  validateWorkflowDef(def);
  const execStep = opts.execStep ?? defaultExecStep;
  const emit = (e: WorkflowEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* a listener must never break the run */
    }
  };

  const runId = opts.runId ?? randomUUID().slice(0, 8);
  if (opts.runId !== undefined) assertValidRunId(opts.runId);
  const run: WorkflowRun = {
    id: runId,
    name: def.name,
    startedAt: new Date().toISOString(),
    status: 'running',
    ...(opts.runnerTmux ? { runnerTmux: opts.runnerTmux } : {}),
    steps: [],
  };
  await writeRun(run);
  emit({ type: 'run-start', runId, name: def.name, steps: def.steps.length });

  const resultsById: Record<string, StepResult> = {};
  for (const rawStep of def.steps) {
    const step = resolveStep(rawStep, resultsById);
    emit({ type: 'step-start', runId, stepId: step.id, provider: step.provider });

    let result: StepResult;
    try {
      result = await execStep({ step, runId, emit });
    } catch (e) {
      result = {
        id: rawStep.id,
        sessionId: '',
        provider: rawStep.provider,
        state: 'failed',
        ok: false,
        commitsAhead: 0,
      };
      emit({ type: 'step-error', runId, stepId: rawStep.id, error: (e as Error).message });
    }

    run.steps.push(result);
    resultsById[rawStep.id] = result;
    await writeRun(run); // re-persist after EVERY transition

    emit({ type: 'step-done', runId, result });
    if (result.unverified) {
      emit({
        type: 'step-warn',
        runId,
        stepId: result.id,
        message:
          `step '${result.id}': NO success signal (non-worktree, no \`done\` predicate) — ` +
          `ok was inferred from the agent YIELDING, not from verified success. ` +
          `Add a \`done\` predicate over a hard signal (a commit, a written file).`,
      });
    }

    if (!result.ok && !rawStep.continueOnFail) {
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      await writeRun(run);
      emit({ type: 'run-done', runId, status: run.status, run });
      return run;
    }
  }

  // Reached the end. 'done' iff every step ok — covers a continueOnFail step that failed
  // but didn't stop the run (the run still didn't fully succeed).
  run.status = run.steps.every((s) => s.ok) ? 'done' : 'failed';
  run.finishedAt = new Date().toISOString();
  await writeRun(run);
  emit({ type: 'run-done', runId, status: run.status, run });
  return run;
}

/** The tmux session name that owns a detached workflow run: `orc-wf-<runId>`. */
export function runnerTmuxName(runId: string): string {
  assertValidRunId(runId);
  return `orc-wf-${sanitizeTmuxName(runId)}`;
}

/**
 * Reconcile a persisted run status against its runner's liveness — the PURE decision
 * behind `orc workflow status`/`list`. A finalized status (`done`/`failed`/`orphaned`)
 * is TRUSTED as-is (the runner, or a prior reconcile, wrote it deliberately). Only a
 * `running` record is suspect: if its runner session is provably NOT alive the runner
 * died mid-run, so the effective status is `orphaned`. `runnerAlive === null` means
 * liveness is unknowable (no `runnerTmux` — e.g. a plain foreground run), so `running`
 * is trusted rather than guessed.
 */
export function reconcileRunStatus(
  recordStatus: WorkflowRun['status'],
  runnerAlive: boolean | null,
): WorkflowRun['status'] {
  if (recordStatus !== 'running') return recordStatus;
  if (runnerAlive === false) return 'orphaned';
  return 'running';
}

/**
 * Apply `reconcileRunStatus` to a run record using a real driver, and PERSIST the
 * transition once observed so it sticks (a crashed runner isn't re-probed forever).
 * Mutates and returns `run`. No-op unless the record is a stale `running`.
 *
 * INVARIANT this relies on: a detached runner's tmux session dies STRICTLY AFTER its
 * final `done`/`failed` write (the write happens inside the bun process; the session
 * ends only when bun exits). So a not-alive session under a `running` record is always a
 * genuine crash, never a clean finish mid-flight — do not add `remain-on-exit` or any
 * post-`runWorkflow` work to the runner, which would break this and yield false orphans.
 */
export async function reconcileRun(run: WorkflowRun, driver: Driver = getDriver()): Promise<WorkflowRun> {
  if (run.status !== 'running') return run;
  const alive = run.runnerTmux ? await driver.isAlive(run.runnerTmux) : null;
  const effective = reconcileRunStatus(run.status, alive);
  if (effective === run.status) return run;
  run.status = effective;
  run.finishedAt = run.finishedAt ?? new Date().toISOString();
  await writeRun(run);
  return run;
}

/** A single step's transcript, for `orc workflow logs`. */
export interface StepLog {
  step: string;
  provider: Provider;
  turns: Turn[];
}

/**
 * Assemble per-step transcripts for `orc workflow logs`. PURE orchestration over an
 * injected `readTurns` reader (so it's unit-testable with a fake run record + fake reader
 * — no live session required). With `stepId`, returns just that one step and throws a
 * clear error if the run has no such step.
 */
export async function assembleStepLogs(
  steps: StepResult[],
  readTurns: (step: StepResult) => Promise<Turn[]>,
  stepId?: string,
): Promise<StepLog[]> {
  let selected = steps;
  if (stepId !== undefined) {
    selected = steps.filter((s) => s.id === stepId);
    if (selected.length === 0) {
      const have = steps.map((s) => s.id).join(', ') || 'none';
      throw new Error(`run has no step '${stepId}' (steps: ${have})`);
    }
  }
  const logs: StepLog[] = [];
  for (const s of selected) {
    logs.push({ step: s.id, provider: s.provider, turns: await readTurns(s) });
  }
  return logs;
}
