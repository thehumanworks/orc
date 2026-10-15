/**
 * orc workflows — durable multi-step runner (phase 2).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { agent } from './agent.ts';
import { Session } from './session.ts';
import { commitCountSince, commitCountVsMain } from './worktree.ts';
import { validateAlias, readRegistry, findRecord } from './registry.ts';
import { countLiveSessions, sessionStatusOf } from './session-status.ts';
import { lastAssistantText, renderCapture } from './journal-render.ts';
import { deliveryVerdict } from './runtime/client.ts';
import type { DeliveryVerdict } from './runtime/client.ts';
import {
  makeLease,
  isLeaseLive,
  writeRunOwned,
  readRun,
  updateRun,
  projectStepsFromAttempts as projectRunSteps,
  WORKFLOW_SCHEMA_VERSION,
  DEFAULT_LEASE_MS,
  FinalizedRunError,
  LiveOwnerError,
  beginRunRecovery,
} from './runs.ts';
import { assertValidRunId, runInstructionsDir, runResultPath, runAttemptDir } from './paths.ts';
import { ensurePrivateDir, writePrivateFile } from './private-fs.ts';
import { isSameProcessAlive } from './runtime/process.ts';
import type { Turn } from './transcript.ts';
import type { AgentState, ExecutionPolicy, Provider } from './types.ts';
import { ORC_ENV } from './types.ts';
import type { WaitForResult } from './session.ts';
import type { DeliveryPhase, SendResult } from './messages.ts';
import { applyInheritedContext, lineageEnvVars, resolveLineage, lineageEnv, enforceSpawnPolicy } from './lineage.ts';
import { assertPolicyAllowsSpawn, computeDeadlineAt, normalizePolicy, PolicyViolationError } from './policy.ts';
import type {
  AttemptPhase,
  AttemptTurnEvent,
  StepOutcome,
  PlanStep,
  StepAttempt,
  StepResult,
  TurnPolicy,
  WorkflowPlan,
  WorkflowRun,
  WorkflowRunStatus,
  OwnerLease,
  RunLease,
  RunnerInfo,
} from './run-schema.ts';
import { TERMINAL_ATTEMPT_PHASES } from './run-schema.ts';

export type {
  AttemptPhase,
  AttemptTurnEvent,
  TurnPolicy,
  StepOutcome,
  PlanStep,
  StepAttempt,
  StepResult,
  WorkflowPlan,
  WorkflowRun,
  WorkflowRunStatus,
  OwnerLease,
  RunLease,
  RunnerInfo,
} from './run-schema.ts';
export { TERMINAL_ATTEMPT_PHASES } from './run-schema.ts';
import type { VerifyDescriptor, VerifierObservation } from './verification.ts';
import { assertValidVerifyDescriptor, captureBaselineSha, cloneVerifyDescriptor, runVerify } from './verification.ts';
import type { ArtifactInputDecl, ArtifactOutputDecl, ArtifactRef, ArtifactManifest } from './artifacts.ts';
import { collectDeclaredOutputs, materializeStepInputs, ensureArtifactDirs, refFromManifest } from './artifacts.ts';
import type { ResultEnvelope } from './result-envelope.ts';
import { readResultEnvelope } from './result-envelope.ts';
import { isPathInsideRoot as isPathInsideRootImpl } from './workflow-path.ts';
import {
  buildNormalizedGraph,
  deriveSchedulerState,
  effectiveConcurrency,
  effectiveNeedsOf,
  GraphValidationError,
  normalizeMaxConcurrency,
  pickReady,
  retryClosure,
  defaultRetryRoots,
  schedulingSummary,
  validateStepGraph,
  transitiveDependents,
  SCHEDULER_TERMINAL_PHASES,
  IN_FLIGHT_PHASES,
  type NormalizedStepGraph,
  type SchedulerSnapshot,
} from './workflow-scheduler.ts';

export type { VerifyDescriptor, VerifierObservation } from './verification.ts';
export type { ArtifactInputDecl, ArtifactOutputDecl, ArtifactRef, ArtifactManifest } from './artifacts.ts';
export type { ResultEnvelope } from './result-envelope.ts';
export {
  buildNormalizedGraph,
  deriveSchedulerState,
  effectiveConcurrency,
  effectiveNeedsOf,
  GraphValidationError,
  normalizeMaxConcurrency,
  pickReady,
  retryClosure,
  defaultRetryRoots,
  schedulingSummary,
  validateStepGraph,
  transitiveDependents,
  SCHEDULER_TERMINAL_PHASES,
  IN_FLIGHT_PHASES,
};
export type { NormalizedStepGraph, SchedulerSnapshot, StepSchedStatus, StepView } from './workflow-scheduler.ts';

const VALID_PROVIDERS: Provider[] = ['claude', 'codex', 'pi'];
const DEFAULT_STEP_TIMEOUT_MS = 600_000;
const LARGE_PROMPT_BYTES = 1024;
const STEP_ID_MAX_LEN = 128;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const WORKFLOW_ROOTS_ENV = 'ORC_WORKFLOW_ROOTS';

export interface WorkflowStep {
  id: string;
  provider: Provider;
  alias?: string;
  taskFile?: string;
  prompt?: string;
  worktree?: boolean;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Explicit hard dependencies (step ids that must succeed first).
   * With maxConcurrency > 1, dependency-free steps may run concurrently.
   * Artifact `inputs[].fromStep` is auto-inferred into the effective dependency set.
   */
  needs?: string[];
  /**
   * Local/file-only escape hatch: function success predicate (non-portable for daemon/resume).
   * Prefer serializable `verify`.
   */
  done?: (ctx: StepDoneCtx) => boolean;
  /** JSON-portable completion contract (all/any/gitDiff/command/file/artifact/resultEnvelope). */
  verify?: import('./verification.ts').VerifyDescriptor;
  /**
   * When true, a yielded step with no verify/done/worktree-commit is ok.
   * Default false — fail closed as `unverified`.
   */
  allowUnverified?: boolean;
  outputs?: import('./artifacts.ts').ArtifactOutputDecl[];
  inputs?: import('./artifacts.ts').ArtifactInputDecl[];
  /** Bounded multi-turn steering. Default maxTurns=1. */
  turns?: import('./run-schema.ts').TurnPolicy;
  continueOnFail?: boolean;
}

export interface StepDoneCtx {
  state: AgentState;
  commitsAhead: number;
  /**
   * The step session's last assistant message, then a short rendering of its final turn
   * (prompt, replies, outcome/error), from the session journal — bounded to 8000 chars.
   * (Before the actor runtime this was a tmux pane capture; predicates that matched TUI
   * chrome must match the agent's words instead.)
   */
  capture: string;
  sessionId?: string;
  turns?: Turn[];
  lastAssistantText?: string;
  cwd?: string;
  baselineSha?: string;
  envelope?: import('./result-envelope.ts').ResultEnvelope | null;
  artifacts?: Record<string, import('./artifacts.ts').ArtifactRef>;
  artifact?: (name: string) => import('./artifacts.ts').ArtifactRef | undefined;
}

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
  policy?: ExecutionPolicy;
  /**
   * Max concurrent step executions (positive integer). Absent ⇒ 1 (strict
   * array-order sequential execution, backward compatible).
   */
  maxConcurrency?: number;
}

export type WorkflowEvent =
  | { type: 'run-start'; runId: string; name: string; steps: number; maxConcurrency?: number }
  | { type: 'step-start'; runId: string; stepId: string; provider: Provider }
  | { type: 'step-done'; runId: string; result: StepResult }
  | { type: 'step-warn'; runId: string; stepId: string; message: string }
  | { type: 'step-error'; runId: string; stepId: string; error: string }
  | {
      type: 'step-scheduled';
      runId: string;
      stepId: string;
      /** Free slots remaining after this launch reservation. */
      slotsRemaining?: number;
    }
  | {
      type: 'step-blocked';
      runId: string;
      stepId: string;
      reason: string;
      blockedBy?: string[];
    }
  | { type: 'run-done'; runId: string; status: WorkflowRun['status']; run: WorkflowRun }
  | {
      type: 'attempt-transition';
      runId: string;
      attemptId: string;
      stepId: string;
      phase: AttemptPhase;
      sessionId?: string;
    }
  | { type: 'lease-heartbeat'; runId: string; expiresAt: string; ownerId?: string }
  | { type: 'run-resume'; runId: string; fromStatus: WorkflowRunStatus }
  | { type: 'run-retry'; runId: string; stepId?: string }
  | { type: 'run-cancel'; runId: string; cascade: boolean }
  | {
      type: 'attempt-adopt';
      runId: string;
      attemptId: string;
      stepId: string;
      sessionId: string;
    }
  | {
      type: 'step-turn';
      runId: string;
      stepId: string;
      turn: number;
      outcome?: string;
    }
  | {
      type: 'verify-result';
      runId: string;
      stepId: string;
      ok: boolean;
      observations: number;
    };

export type StepExecutor = (args: {
  step: WorkflowStep;
  runId: string;
  emit: (e: WorkflowEvent) => void;
  lineage?: {
    rootRunId: string;
    parentRunId: string;
    stepId: string;
    depth: number;
    owner?: string;
    policy?: ExecutionPolicy;
    deadlineAt?: string;
  };
  /** Persist attempt phase mid-flight (spawn-before-send ownership). */
  transition?: (
    phase: AttemptPhase,
    patch?: Partial<StepAttempt>,
  ) => Promise<void> | void;
  attempt?: StepAttempt;
}) => Promise<StepResult>;

/**
 * Continue an in-flight attempt adopted on resume (D10). Default: wake the attempt's
 * session if suspended and supervise it like a fresh launch (wait → verify).
 */
export type StepAdopter = (args: {
  step: WorkflowStep;
  runId: string;
  emit: (e: WorkflowEvent) => void;
  attempt: StepAttempt;
  transition?: (phase: AttemptPhase, patch?: Partial<StepAttempt>) => Promise<void> | void;
}) => Promise<StepResult>;

/** Kernel facts about an in-flight attempt's session (see probeAttemptSession). */
export type AdoptionProbe = (
  attempt: StepAttempt,
  runId: string,
) => Promise<{ sessionAlive: boolean | null; verdict?: DeliveryVerdict; takenOver?: boolean }>;

export interface RunWorkflowOptions {
  onEvent?: (e: WorkflowEvent) => void;
  execStep?: StepExecutor;
  /** Adoption of in-flight attempts on resume/retry (D10). Injectable for tests. */
  adoptStep?: StepAdopter;
  probeAdoption?: AdoptionProbe;
  /** Resume: relaunch an attempt whose instruction delivery is unknown (default: require retry). */
  allowUnknownDeliveryRetry?: boolean;
  runId?: string;
  /**
   * The detached runner process executing this run (the `--run-id` / `--runner`
   * entrypoints self-report it). Persisted as `run.runner`; it becomes the liveness
   * authority. Omitted ⇒ the calling process owns the run via the lease identity.
   */
  runner?: RunnerInfo;
  /**
   * Lease renewal period while the run is in flight (default leaseMs/3). The runner
   * heartbeats on this timer so a long step never lets a healthy lease expire.
   */
  heartbeatMs?: number;
  /**
   * Abort the runner (e.g. on SIGTERM after `orc workflow cancel`): stop launching,
   * clear the heartbeat and return promptly WITHOUT further record writes — a finalized
   * status is never overwritten. In-flight steps are abandoned, not awaited.
   */
  signal?: AbortSignal;
  sourcePath?: string;
  resume?: boolean;
  retryFromStepId?: string;
  continueExisting?: boolean;
  ownerId?: string;
  leaseMs?: number;
  parentRunId?: string;
  rootRunId?: string;
  depth?: number;
  nowMs?: () => number;
  seedResults?: StepResult[];
  seedAttempts?: StepAttempt[];
  /**
   * Override / supply maxConcurrency for this invocation (CLI/daemon).
   * When set, must be a positive integer. Merged into the durable plan on first write;
   * on resume the persisted plan value wins so scheduling semantics cannot silently change.
   */
  maxConcurrency?: number;
}

export function assertValidStepId(stepId: string, label = 'step id'): void {
  const id = stepId.trim();
  if (id.length === 0) throw new Error(`invalid ${label} '${stepId}' (empty)`);
  if (id === '.' || id === '..') throw new Error(`invalid ${label} '${stepId}'`);
  if (id.length > STEP_ID_MAX_LEN) throw new Error(`invalid ${label} '${stepId}' (max length ${STEP_ID_MAX_LEN})`);
  if (id.includes('/') || id.includes('\\') || id.includes('\0') || id.includes('..')) {
    throw new Error(`invalid ${label} '${stepId}'`);
  }
  if (!STEP_ID_RE.test(id)) {
    throw new Error(`invalid ${label} '${stepId}' (use a letter/digit, then letters/digits/_/- only)`);
  }
}

export function validateWorkflowDef(def: WorkflowDef): void {
  if (!def || typeof def !== 'object') throw new Error('workflow: definition must be an object with { name, steps }');
  if (!def.name || typeof def.name !== 'string') throw new Error('workflow: `name` is required');
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    throw new Error(`workflow '${def.name}': \`steps\` must be a non-empty array`);
  }
  if (def.policy !== undefined) normalizePolicy(def.policy);
  if (def.maxConcurrency !== undefined) {
    try {
      normalizeMaxConcurrency(def.maxConcurrency, 'maxConcurrency');
    } catch (e) {
      throw new Error(`workflow '${def.name}': ${(e as Error).message}`);
    }
  }
  const seen = new Set<string>();
  def.steps.forEach((step, i) => {
    if (!step || typeof step.id !== 'string' || step.id.length === 0) {
      throw new Error(`workflow '${def.name}': step #${i} is missing a string \`id\``);
    }
    try {
      assertValidStepId(step.id);
    } catch (e) {
      throw new Error(`workflow '${def.name}': ${(e as Error).message}`);
    }
    if (seen.has(step.id)) throw new Error(`workflow '${def.name}': duplicate step id '${step.id}'`);
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
    if (step.needs !== undefined) {
      if (!Array.isArray(step.needs)) {
        throw new Error(`workflow '${def.name}' step '${step.id}': needs must be a string array`);
      }
    }
  });
  // Dependency graph + artifact fromStep rule (inferred edges).
  try {
    validateStepGraph(
      def.steps.map((s) => ({
        id: s.id,
        needs: s.needs,
        inputs: s.inputs as PlanStep['inputs'],
      })),
      { workflowName: def.name },
    );
  } catch (e) {
    if (e instanceof GraphValidationError) throw new Error(e.message);
    throw e;
  }
}

export function defineWorkflow(def: WorkflowDef): WorkflowDef {
  validateWorkflowDef(def);
  return def;
}

export function buildPlan(def: WorkflowDef): WorkflowPlan {
  const maxConcurrency = normalizeMaxConcurrency(def.maxConcurrency ?? 1);
  return {
    name: def.name,
    // Always persist normalized concurrency so resume/retry keep scheduling semantics.
    maxConcurrency,
    steps: def.steps.map((s) => {
      const p: PlanStep = { id: s.id, provider: s.provider };
      if (s.alias !== undefined) p.alias = s.alias;
      if (s.taskFile !== undefined) p.taskFile = s.taskFile;
      if (s.prompt !== undefined) p.prompt = s.prompt;
      if (s.worktree !== undefined) p.worktree = s.worktree;
      if (s.cwd !== undefined) p.cwd = s.cwd;
      if (s.timeoutMs !== undefined) p.timeoutMs = s.timeoutMs;
      if (s.continueOnFail !== undefined) p.continueOnFail = s.continueOnFail;
      // Persist effective needs (explicit ∪ inferred artifact fromStep) for durable scheduling.
      const effNeeds = effectiveNeedsOf({
        id: s.id,
        needs: s.needs,
        inputs: s.inputs as PlanStep['inputs'],
      });
      if (effNeeds.length > 0) p.needs = effNeeds;
      if (typeof s.done === 'function') p.hasDonePredicate = true;
      if (s.verify !== undefined) p.verify = cloneVerifyDescriptor(s.verify);
      if (s.allowUnverified !== undefined) p.allowUnverified = s.allowUnverified;
      if (s.outputs !== undefined) p.outputs = s.outputs.map((o) => ({ ...o }));
      if (s.inputs !== undefined) p.inputs = s.inputs.map((i) => ({ ...i }));
      if (s.turns !== undefined) p.turns = { ...s.turns };
      return p;
    }),
  };
}

export function buildWorkflowPlan(def: WorkflowDef): WorkflowPlan {
  return buildPlan(def);
}

export function canonicalPlanJson(plan: WorkflowPlan): string {
  const steps = plan.steps.map((s) => {
    const o: Record<string, unknown> = { id: s.id, provider: s.provider };
    if (s.alias !== undefined) o.alias = s.alias;
    if (s.taskFile !== undefined) o.taskFile = s.taskFile;
    if (s.prompt !== undefined) o.prompt = s.prompt;
    if (s.worktree !== undefined) o.worktree = s.worktree;
    if (s.cwd !== undefined) o.cwd = s.cwd;
    if (s.timeoutMs !== undefined) o.timeoutMs = s.timeoutMs;
    if (s.continueOnFail !== undefined) o.continueOnFail = s.continueOnFail;
    if (s.needs !== undefined && s.needs.length > 0) o.needs = s.needs;
    if (s.hasDonePredicate !== undefined) o.hasDonePredicate = s.hasDonePredicate;
    if (s.verify !== undefined) o.verify = s.verify;
    if (s.allowUnverified !== undefined) o.allowUnverified = s.allowUnverified;
    if (s.outputs !== undefined) o.outputs = s.outputs;
    if (s.inputs !== undefined) o.inputs = s.inputs;
    if (s.turns !== undefined) o.turns = s.turns;
    return o;
  });
  const maxConcurrency = normalizeMaxConcurrency(plan.maxConcurrency ?? 1);
  return JSON.stringify({ name: plan.name, maxConcurrency, steps });
}

export function planDigest(plan: WorkflowPlan): string {
  return createHash('sha256').update(canonicalPlanJson(plan), 'utf8').digest('hex');
}

/**
 * Digest format used by schema v1-v3, before DAG dependencies and maxConcurrency
 * became scheduling semantics. Kept only so durable pre-v4 runs can resume after
 * upgrading; all new writes use planDigest().
 */
export function legacyPlanDigest(plan: WorkflowPlan): string {
  const steps = plan.steps.map((s) => {
    const o: Record<string, unknown> = { id: s.id, provider: s.provider };
    if (s.alias !== undefined) o.alias = s.alias;
    if (s.taskFile !== undefined) o.taskFile = s.taskFile;
    if (s.prompt !== undefined) o.prompt = s.prompt;
    if (s.worktree !== undefined) o.worktree = s.worktree;
    if (s.cwd !== undefined) o.cwd = s.cwd;
    if (s.timeoutMs !== undefined) o.timeoutMs = s.timeoutMs;
    if (s.continueOnFail !== undefined) o.continueOnFail = s.continueOnFail;
    if (s.hasDonePredicate !== undefined) o.hasDonePredicate = s.hasDonePredicate;
    if (s.verify !== undefined) o.verify = s.verify;
    if (s.allowUnverified !== undefined) o.allowUnverified = s.allowUnverified;
    if (s.outputs !== undefined) o.outputs = s.outputs;
    if (s.inputs !== undefined) o.inputs = s.inputs;
    if (s.turns !== undefined) o.turns = s.turns;
    return o;
  });
  return createHash('sha256')
    .update(JSON.stringify({ name: plan.name, steps }), 'utf8')
    .digest('hex');
}

export function digestPlanSteps(plan: WorkflowPlan): string {
  return planDigest(plan);
}

const REF = /\$\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\}/g;

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

function resolveStep(step: WorkflowStep, resultsById: Record<string, StepResult>): WorkflowStep {
  const subst = (s: string | undefined) => (s === undefined ? undefined : interpolate(s, resultsById));
  return { ...step, cwd: subst(step.cwd), prompt: subst(step.prompt), taskFile: subst(step.taskFile) };
}

export function evaluateStep(
  step: Pick<WorkflowStep, 'done' | 'worktree' | 'allowUnverified' | 'verify'>,
  ctx: StepDoneCtx,
): { ok: boolean; unverified: boolean; outcome: StepOutcome } {
  if (ctx.state === 'waiting') {
    return { ok: false, unverified: false, outcome: 'failed' };
  }
  if (ctx.state === 'failed') {
    return { ok: false, unverified: false, outcome: 'failed' };
  }
  if (ctx.state !== 'done' && ctx.state !== 'starting' && ctx.state !== 'running') {
    return { ok: false, unverified: false, outcome: 'failed' };
  }

  if (step.done) {
    const ok = step.done(ctx);
    return { ok, unverified: false, outcome: ok ? 'succeeded' : 'failed' };
  }

  if (step.worktree && !step.verify) {
    const ok = ctx.state === 'done' && ctx.commitsAhead >= 1;
    return { ok, unverified: false, outcome: ok ? 'succeeded' : 'failed' };
  }

  // Portable verify is async — pure evaluateStep does not claim success.
  if (step.verify) {
    return { ok: false, unverified: false, outcome: 'failed' };
  }

  // Bare yield: fail closed unless allowUnverified.
  if (ctx.state === 'done') {
    if (step.allowUnverified === true) {
      return { ok: true, unverified: true, outcome: 'unverified' };
    }
    return { ok: false, unverified: true, outcome: 'unverified' };
  }
  return { ok: false, unverified: false, outcome: 'failed' };
}

export function stepOutcomeFromWait(
  step: Pick<WorkflowStep, 'done' | 'worktree' | 'allowUnverified' | 'verify'>,
  wait: WaitForResult,
  ctx: Omit<StepDoneCtx, 'state'>,
): { state: AgentState; ok: boolean; unverified?: boolean; outcome: StepOutcome } {
  if (!wait.settled) {
    return { state: wait.state, ok: false, outcome: 'timed_out' };
  }
  if (wait.state === 'waiting') {
    return { state: 'waiting', ok: false, outcome: 'failed' };
  }
  const fullCtx: StepDoneCtx = { state: wait.state, ...ctx };
  const { ok, unverified, outcome } = evaluateStep(step, fullCtx);
  return { state: wait.state, ok, unverified: unverified || undefined, outcome };
}

async function dropInstructionFile(runId: string, stepId: string, body: string): Promise<string> {
  assertValidStepId(stepId);
  const dir = runInstructionsDir(runId);
  ensurePrivateDir(dir);
  const file = path.join(dir, `${stepId}.md`);
  await writePrivateFile(file, body);
  return file;
}

export function workflowImportRoots(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const raw = env[WORKFLOW_ROOTS_ENV];
  if (raw && raw.trim().length > 0) {
    return raw
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => path.resolve(cwd, s));
  }
  return [path.resolve(cwd)];
}

export function isPathInsideRoot(child: string, root: string): boolean {
  const c = path.resolve(child);
  const r = path.resolve(root);
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

export async function resolveContainedWorkflowFile(
  file: string,
  opts?: { roots?: string[]; cwd?: string },
): Promise<string> {
  const cwd = opts?.cwd ?? process.cwd();
  const roots = opts?.roots ?? workflowImportRoots(process.env, cwd);
  if (roots.length === 0) throw new Error('workflow import: no allowed roots configured');
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    try {
      resolvedRoots.push(await fs.realpath(root));
    } catch {
      resolvedRoots.push(path.resolve(root));
    }
  }
  const abs = path.resolve(cwd, file);
  let probe = abs;
  let realCandidate: string | null = null;
  while (true) {
    try {
      realCandidate = await fs.realpath(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  let candidate: string;
  if (realCandidate === null) candidate = abs;
  else if (probe === abs) candidate = realCandidate;
  else candidate = path.resolve(realCandidate, path.relative(probe, abs));
  if (!resolvedRoots.some((root) => isPathInsideRoot(candidate, root))) {
    throw new Error(
      `workflow import path '${file}' is outside allowed roots ` +
        `(${resolvedRoots.join(', ')}); set ${WORKFLOW_ROOTS_ENV} to extend the allowlist`,
    );
  }
  return candidate;
}

export async function deliverInstructions(
  session: Pick<Session, 'send'>,
  step: WorkflowStep,
  runId: string,
  opts?: { messageId?: string },
): Promise<SendResult> {
  const sendOpts = opts?.messageId ? { messageId: opts.messageId } : undefined;
  if (step.taskFile) {
    const resolved = path.isAbsolute(step.taskFile)
      ? step.taskFile
      : path.resolve(process.cwd(), step.taskFile);
    const f = Bun.file(resolved);
    if (!(await f.exists())) throw new Error(`step '${step.id}': taskFile not found: ${resolved}`);
    const dropped = await dropInstructionFile(runId, step.id, await f.text());
    return session.send(
      `Your task is fully specified in this file: ${dropped}\n` +
        `Read it in full first, then carry it out exactly, end to end. Begin now.`,
      sendOpts,
    );
  }
  const prompt = step.prompt ?? '';
  if (Buffer.byteLength(prompt, 'utf8') > LARGE_PROMPT_BYTES) {
    const dropped = await dropInstructionFile(runId, step.id, prompt);
    return session.send(
      `Your instructions are in this file: ${dropped}\n` +
        `Read it in full and do exactly what it says. Begin now.`,
      sendOpts,
    );
  }
  return session.send(prompt, sendOpts);
}

export function nextAttemptNumber(attempts: StepAttempt[] | undefined, stepId: string): number {
  const prior = (attempts ?? []).filter((a) => a.stepId === stepId);
  if (prior.length === 0) return 1;
  return Math.max(...prior.map((a) => a.attemptNumber)) + 1;
}

export function createAttempt(args: {
  stepId: string;
  provider: Provider;
  attemptNumber: number;
  now?: string;
}): StepAttempt {
  const now = args.now ?? new Date().toISOString();
  return {
    attemptId: randomUUID().slice(0, 12),
    attemptNumber: args.attemptNumber,
    stepId: args.stepId,
    provider: args.provider,
    phase: 'queued',
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  };
}

/** Forward order of the in-flight attempt phases (terminal phases rank last). */
const ATTEMPT_PROGRESS: Partial<Record<AttemptPhase, number>> = {
  queued: 0,
  spawning: 1,
  dispatched: 2,
  running: 3,
  waiting: 3,
  verifying: 4,
};

function attemptProgress(phase: AttemptPhase): number {
  return ATTEMPT_PROGRESS[phase] ?? 5;
}

export function transitionAttempt(
  attempt: StepAttempt,
  phase: AttemptPhase,
  patch: Partial<Omit<StepAttempt, 'attemptId' | 'attemptNumber' | 'stepId' | 'provider' | 'createdAt' | 'phase'>> = {},
  now = new Date().toISOString(),
): StepAttempt {
  const next: StepAttempt = { ...attempt, ...patch, phase, updatedAt: now };
  if ((phase === 'spawning' || phase === 'dispatched' || phase === 'running') && !next.startedAt) {
    next.startedAt = now;
  }
  if (TERMINAL_ATTEMPT_PHASES.has(phase) && !next.finishedAt) next.finishedAt = now;
  return next;
}

export function latestAttemptForStep(
  attempts: StepAttempt[] | undefined,
  stepId: string,
): StepAttempt | undefined {
  const list = (attempts ?? []).filter((a) => a.stepId === stepId);
  if (list.length === 0) return undefined;
  return list.reduce((a, b) => (a.attemptNumber >= b.attemptNumber ? a : b));
}

export function projectStepsFromAttempts(
  planSteps: { id: string; provider: Provider }[],
  attempts: StepAttempt[] | undefined,
  prior: StepResult[] = [],
): StepResult[] {
  const out: StepResult[] = [];
  for (const ps of planSteps) {
    const att = latestAttemptForStep(attempts, ps.id);
    if (att?.result) {
      out.push(att.result);
      continue;
    }
    const existing = prior.find((s) => s.id === ps.id);
    if (existing) out.push(existing);
  }
  return out;
}

/**
 * What to do with a step's latest attempt when a run is recovered (resume/retry, D10):
 * - `skip_succeeded` — already succeeded
 * - `adopt`          — in flight, its session still continuable (exists, not stopped) and
 *                      the instruction is queued / acknowledged / completed: keep waiting
 * - `require_retry`  — delivery `unknown` (cut before the provider acked it): never
 *                      re-sent automatically; an explicit retry is required. Also when
 *                      the session was TAKEN OVER by a human: a resume must never launch a
 *                      competing agent (hand it back with `orc resume <id>` first)
 * - `spawn_new`      — no attempt, terminal non-success, session gone/stopped, or the
 *                      instruction failed / was never enqueued / was interrupted
 * `verdict` is the kernel delivery verdict of the attempt's instruction message; without
 * one, an alive session is adopted (pre-kernel behaviour).
 */
export function adoptionDecision(args: {
  attempt: StepAttempt | undefined;
  sessionAlive: boolean | null;
  verdict?: DeliveryVerdict;
  allowUnknownDeliveryRetry?: boolean;
  /** The attempt's session was taken over (`orc takeover`): never relaunch around it. */
  takenOver?: boolean;
}): 'skip_succeeded' | 'adopt' | 'require_retry' | 'spawn_new' {
  const a = args.attempt;
  if (!a) return 'spawn_new';
  if (a.phase === 'succeeded') return 'skip_succeeded';
  if (a.phase === 'cancelled' || a.phase === 'abandoned') return 'spawn_new';
  if (a.phase === 'failed') return 'spawn_new';
  if (TERMINAL_ATTEMPT_PHASES.has(a.phase)) return 'spawn_new';
  if (args.takenOver) return 'require_retry';
  const unknown = a.deliveryPhase === 'unknown' || args.verdict === 'unknown';
  if (unknown) return args.allowUnknownDeliveryRetry ? 'spawn_new' : 'require_retry';
  if (!a.sessionId) return 'spawn_new';
  if (args.sessionAlive === false) return 'spawn_new';
  if (args.sessionAlive === null) {
    if (['dispatched', 'running', 'verifying'].includes(a.phase)) return 'require_retry';
    return 'spawn_new';
  }
  if (!['dispatched', 'running', 'verifying', 'waiting', 'spawning'].includes(a.phase)) return 'spawn_new';
  switch (args.verdict) {
    case undefined:
    case 'queued':
    case 'acknowledged':
    case 'completed':
      return 'adopt';
    default:
      // failed | interrupted | absent → normal relaunch rules.
      return 'spawn_new';
  }
}

export function decideAdoption(args: {
  attempt: StepAttempt | undefined;
  sessionAlive: boolean | null;
  verdict?: DeliveryVerdict;
  allowUnknownDeliveryRetry?: boolean;
  takenOver?: boolean;
}): 'skip_succeeded' | 'adopt' | 'require_retry' | 'spawn_new' {
  return adoptionDecision(args);
}

export interface FinalizeStepArgs {
  step: Pick<WorkflowStep, 'done' | 'worktree' | 'allowUnverified' | 'verify' | 'id' | 'outputs'>;
  wait: WaitForResult;
  ctx: Omit<StepDoneCtx, 'state'>;
  runId: string;
  attemptId: string;
  collectedArtifacts?: import('./artifacts.ts').ArtifactManifest[];
}

export async function finalizeStepOutcome(args: FinalizeStepArgs): Promise<{
  state: AgentState;
  ok: boolean;
  unverified?: boolean;
  outcome: StepOutcome;
  observations?: import('./verification.ts').VerifierObservation[];
  envelope?: import('./result-envelope.ts').ResultEnvelope | null;
}> {
  const { step, wait, ctx, runId, attemptId } = args;
  const envelope = ctx.envelope ?? null;
  if (!wait.settled) return { state: wait.state, ok: false, outcome: 'timed_out', envelope };
  if (wait.state === 'waiting') return { state: 'waiting', ok: false, outcome: 'failed', envelope };
  if (wait.state === 'failed') return { state: 'failed', ok: false, outcome: 'failed', envelope };
  if (envelope?.outcome === 'needs_input') return { state: wait.state, ok: false, outcome: 'needs_input', envelope };
  if (step.done) {
    const fullCtx: StepDoneCtx = { state: wait.state, ...ctx, envelope };
    const ok = step.done(fullCtx);
    return { state: wait.state, ok, outcome: ok ? 'succeeded' : 'failed', envelope };
  }
  if (step.verify) {
    const { runVerify } = await import('./verification.ts');
    const verifyResult = await runVerify(step.verify, {
      cwd: ctx.cwd ?? process.cwd(),
      runId,
      stepId: step.id,
      attemptId,
      baselineSha: ctx.baselineSha,
      envelope,
      artifacts: args.collectedArtifacts,
      state: wait.state,
      settled: wait.settled,
    });
    return {
      state: wait.state,
      ok: verifyResult.ok,
      outcome: verifyResult.ok ? 'succeeded' : 'failed',
      observations: verifyResult.observations,
      envelope,
    };
  }
  if (step.worktree) {
    const ok = ctx.commitsAhead >= 1;
    return { state: wait.state, ok, outcome: ok ? 'succeeded' : 'failed', envelope };
  }
  if (step.allowUnverified === true) {
    return { state: wait.state, ok: true, unverified: true, outcome: 'unverified', envelope };
  }
  return { state: wait.state, ok: false, unverified: true, outcome: 'unverified', envelope };
}

const defaultExecStep: StepExecutor = async ({
  step,
  runId,
  lineage,
  transition,
  attempt,
  emit,
}) => {
  const depth = lineage?.depth ?? 0;
  const rootRunId = lineage?.rootRunId ?? runId;
  const policy = lineage?.policy;
  const attemptId = attempt?.attemptId ?? randomUUID().slice(0, 12);
  const stepTimeout = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const stepDeadline = Date.now() + stepTimeout;

  if (policy || lineage) {
    const records = await readRegistry();
    const rootSessions = records.filter((r) => r.rootRunId === rootRunId);
    assertPolicyAllowsSpawn({
      depth,
      policy,
      deadlineAt: lineage?.deadlineAt,
      rootSessions,
      // D2: concurrency counts live actors (or spawns in progress), not "not dead".
      liveCount: countLiveSessions(rootSessions),
      isDelegation: depth > 0,
      totalAfterSpawn: rootSessions.length + 1,
    });
  }

  await ensureArtifactDirs(runId);
  ensurePrivateDir(runAttemptDir(runId, attemptId));
  const resultPath = runResultPath(runId, attemptId);

  const spawnCwd = step.cwd ? path.resolve(step.cwd) : process.cwd();
  let baselineSha = await captureBaselineSha(spawnCwd);

  await transition?.('spawning', { baselineSha, resultPath });

  const session = await agent(
    applyInheritedContext({
      provider: step.provider,
      alias: step.alias,
      cwd: step.cwd,
      worktree: step.worktree ? true : undefined,
      rootRunId,
      parentRunId: lineage?.parentRunId ?? runId,
      stepId: step.id,
      depth,
      owner: lineage?.owner,
      policy,
      extraEnv: {
        [ORC_ENV.RESULT_PATH]: resultPath,
        [ORC_ENV.ATTEMPT_ID]: attemptId,
        [ORC_ENV.RUN_ID]: runId,
      },
    }),
  );

  const effectiveCwd = session.worktreePath ?? session.cwd;
  baselineSha = (await captureBaselineSha(effectiveCwd)) ?? baselineSha;

  // CRITICAL: persist session ownership before any send side effect.
  await transition?.('dispatched', {
    sessionId: session.id,
    baselineSha,
    resultPath,
  });

  const messageId = instructionMessageId(runId, step.id, attemptId);
  let sent: SendResult;
  try {
    sent = await deliverInstructions(session, step, runId, { messageId });
    if (sent.phase === 'failed') throw new Error(`step '${step.id}': instructions were rejected by the provider`);
  } catch (e) {
    await transition?.('failed', {
      sessionId: session.id,
      messageId,
      errorCategory: 'send',
      errorMessage: (e as Error).message,
      finishedAt: new Date().toISOString(),
      outcome: 'failed',
    });
    throw e;
  }

  await transition?.('running', {
    sessionId: session.id,
    messageId,
    deliveryPhase: sent.phase,
    baselineSha,
    resultPath,
  });

  return superviseStep({
    session,
    step,
    runId,
    attemptId,
    baselineSha,
    resultPath,
    effectiveCwd,
    stepDeadline,
    transition,
    emit,
    turnEvents: [],
    turnsDone: 0,
  });
};

/** Deterministic idempotency key of a step attempt's instruction (turn 0) message. */
export function instructionMessageId(runId: string, stepId: string, attemptId: string): string {
  return `wf-${runId}-${stepId}-${attemptId}-t0`;
}

interface SuperviseArgs {
  session: Session;
  step: WorkflowStep;
  runId: string;
  attemptId: string;
  baselineSha?: string;
  resultPath: string;
  effectiveCwd: string;
  stepDeadline: number;
  transition?: Parameters<StepExecutor>[0]['transition'];
  emit: (e: WorkflowEvent) => void;
  turnEvents: AttemptTurnEvent[];
  /** Turns already settled before this supervisor took over (adoption). */
  turnsDone: number;
}

/**
 * Wait for the step's turns to settle (bounded multi-turn steering), collect outputs,
 * evaluate the step's success contract and build its StepResult. Shared by a fresh
 * launch and by adoption of an in-flight attempt on resume (D10).
 */
async function superviseStep(a: SuperviseArgs): Promise<StepResult> {
  const { session, step, runId, attemptId, resultPath, effectiveCwd, stepDeadline, transition, emit } = a;
  const baselineSha = a.baselineSha;
  const turnEvents = a.turnEvents;
  const maxTurns = step.turns?.maxTurns ?? 1;

  let wait: WaitForResult = { state: 'failed', settled: false };
  let turn = a.turnsDone;
  // An adopted attempt always gets (at least) one more wait for its open turn.
  const turnLimit = a.turnsDone > 0 ? Math.max(maxTurns, a.turnsDone + 1) : maxTurns;
  while (turn < turnLimit) {
    const remaining = stepDeadline - Date.now();
    if (remaining <= 0) {
      wait = { state: wait.state === 'failed' ? 'failed' : 'done', settled: false };
      turnEvents.push({
        turn: turn + 1,
        at: new Date().toISOString(),
        kind: 'timeout',
        state: wait.state,
      });
      break;
    }

    wait = await session.waitForResult({
      until: ['done', 'waiting', 'failed'],
      timeoutMs: remaining,
    });
    turn += 1;

    const envValidation = await readResultEnvelope(resultPath, {
      runId,
      stepId: step.id,
      attemptId,
    });
    const envelope =
      envValidation && envValidation.ok ? envValidation.envelope : null;

    turnEvents.push({
      turn,
      at: new Date().toISOString(),
      kind: wait.settled ? 'settle' : 'timeout',
      state: wait.state,
      envelopeOutcome: envelope?.outcome,
      summary: envelope?.summary?.slice(0, 256),
    });
    emit({
      type: 'step-turn',
      runId,
      stepId: step.id,
      turn,
      outcome: envelope?.outcome,
    });

    if (!wait.settled) break;
    if (wait.state === 'waiting' || wait.state === 'failed') break;

    const needsInput =
      envelope?.outcome === 'needs_input' ||
      (typeof envelope?.question === 'string' && envelope.question.length > 0);

    if (needsInput && turn < maxTurns) {
      const policyTurn = step.turns;
      if (policyTurn?.onNeedsInput === 'send' && policyTurn.response) {
        const steerMsgId = `wf-${runId}-${step.id}-${attemptId}-t${turn}`;
        await session.send(policyTurn.response, { messageId: steerMsgId });
        turnEvents.push({
          turn,
          at: new Date().toISOString(),
          kind: 'steer',
          messageId: steerMsgId,
          summary: `sent configured response (${policyTurn.response.length} chars)`,
        });
        await fs.unlink(resultPath).catch(() => {});
        continue;
      }
      turnEvents.push({
        turn,
        at: new Date().toISOString(),
        kind: 'needs_input',
        envelopeOutcome: 'needs_input',
        summary: envelope?.question?.slice(0, 256) ?? 'needs_input without configured response',
      });
      break;
    }
    break;
  }

  await transition?.('verifying', {
    sessionId: session.id,
    baselineSha,
    resultPath,
    turns: turnEvents,
  });

  let collected: ArtifactManifest[] = [];
  let artifactMap: Record<string, ArtifactRef> | undefined;
  if (step.outputs && step.outputs.length > 0) {
    try {
      const map = await collectDeclaredOutputs({
        runId,
        stepId: step.id,
        attemptId,
        cwd: effectiveCwd,
        outputs: step.outputs,
      });
      collected = Object.values(map);
      artifactMap = {};
      for (const m of collected) {
        artifactMap[m.name] = refFromManifest(m);
      }
    } catch {
      return {
        id: step.id,
        sessionId: session.id,
        provider: step.provider,
        state: wait.state,
        ok: false,
        outcome: 'failed',
        commitsAhead: 0,
        baselineSha,
        worktree: session.worktreePath,
        branch: session.branch,
        cwd: effectiveCwd,
        resultPath,
      };
    }
  }

  const envValidation = await readResultEnvelope(resultPath, {
    runId,
    stepId: step.id,
    attemptId,
  });
  const envelope =
    envValidation && envValidation.ok ? envValidation.envelope : null;

  const commitsAhead = baselineSha
    ? await commitCountSince(effectiveCwd, baselineSha)
    : session.worktreePath
      ? await commitCountVsMain(session.worktreePath)
      : 0;
  // StepDoneCtx.capture: last assistant message + a short rendering of the final turn,
  // from the session journal (see StepDoneCtx).
  const journal = session.journal();
  const capture = renderCapture(journal);
  const lastText = lastAssistantText(journal);

  const finalized = await finalizeStepOutcome({
    step,
    wait,
    runId,
    attemptId,
    collectedArtifacts: collected,
    ctx: {
      commitsAhead,
      capture,
      ...(lastText !== undefined ? { lastAssistantText: lastText } : {}),
      sessionId: session.id,
      cwd: effectiveCwd,
      baselineSha,
      envelope,
      artifacts: artifactMap,
      artifact: (n: string) => artifactMap?.[n],
    },
  });

  if (finalized.observations) {
    emit({
      type: 'verify-result',
      runId,
      stepId: step.id,
      ok: finalized.ok,
      observations: finalized.observations.length,
    });
  }

  return {
    id: step.id,
    sessionId: session.id,
    provider: step.provider,
    state: finalized.state,
    ok: finalized.ok,
    outcome: finalized.outcome,
    commitsAhead,
    baselineSha,
    worktree: session.worktreePath,
    branch: session.branch,
    cwd: effectiveCwd,
    unverified: finalized.unverified,
    artifacts: artifactMap as StepResult['artifacts'],
    observations: finalized.observations,
    envelope: finalized.envelope ?? undefined,
    resultPath,
  };
}

/**
 * Continue an adopted in-flight attempt (D10): wake its session if it is suspended, then
 * supervise it exactly like a fresh launch (wait → verify). Never re-sends the
 * instruction (the kernel would replay it idempotently anyway).
 */
const defaultAdoptStep: StepAdopter = async ({ step, runId, attempt, transition, emit }) => {
  if (!attempt.sessionId) throw new Error(`step '${step.id}': adopted attempt has no session`);
  const rec = await findRecord(attempt.sessionId);
  if (!rec) throw new Error(`step '${step.id}': session ${attempt.sessionId} not found`);
  const session = new Session(rec);
  const detail = await session.stateDetail();
  if (!detail.live) await session.resume();
  const resultPath = attempt.resultPath ?? runResultPath(runId, attempt.attemptId);
  const messageId = attempt.messageId ?? instructionMessageId(runId, step.id, attempt.attemptId);
  await transition?.('running', { sessionId: session.id, messageId, resultPath });
  const turns = attempt.turns ?? [];
  return superviseStep({
    session,
    step,
    runId,
    attemptId: attempt.attemptId,
    ...(attempt.baselineSha ? { baselineSha: attempt.baselineSha } : {}),
    resultPath,
    effectiveCwd: session.worktreePath ?? session.cwd,
    stepDeadline: Date.now() + (step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS),
    transition,
    emit,
    turnEvents: [...turns],
    turnsDone: turns.filter((t) => t.kind === 'settle' || t.kind === 'timeout').length,
  });
};

/**
 * What the kernel says about an in-flight attempt's session (D10): whether the session
 * can still be continued (exists, not stopped) and the delivery verdict of the
 * instruction message. `sessionAlive: null` = unknowable.
 */
export async function probeAttemptSession(
  attempt: StepAttempt,
  runId: string,
): Promise<{ sessionAlive: boolean | null; verdict?: DeliveryVerdict; takenOver?: boolean }> {
  if (!attempt.sessionId) return { sessionAlive: false };
  const rec = await findRecord(attempt.sessionId);
  if (!rec) return { sessionAlive: false };
  // A human holds it (`orc takeover`): not continuable by the workflow, and not to be
  // replaced by a competing agent either.
  if (rec.stoppedBy === 'takeover') return { sessionAlive: false, takenOver: true };
  if (sessionStatusOf(rec) === 'dead') return { sessionAlive: false };
  try {
    const messageId = attempt.messageId ?? instructionMessageId(runId, attempt.stepId, attempt.attemptId);
    return { sessionAlive: true, verdict: deliveryVerdict(rec.sessionId, messageId) };
  } catch {
    return { sessionAlive: null };
  }
}

export function runnerLineageEnv(
  run: Pick<WorkflowRun, 'id' | 'rootRunId' | 'parentRunId' | 'policy' | 'deadlineAt' | 'lease'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ORC_HOME) env.ORC_HOME = process.env.ORC_HOME;
  Object.assign(
    env,
    lineageEnvVars({
      rootRunId: run.rootRunId ?? run.id,
      parentRunId: run.parentRunId ?? run.id,
      depth: 0,
      owner: run.lease?.ownerId,
      policy: run.policy,
      deadlineAt: run.deadlineAt,
    }),
  );
  return env;
}

/** Process-level resources a run holds while it owns its record (released in `finally`). */
interface RunLifecycle {
  heartbeat?: ReturnType<typeof setInterval>;
  disposers: (() => void)[];
}

function releaseLifecycle(life: RunLifecycle): void {
  if (life.heartbeat !== undefined) clearInterval(life.heartbeat);
  life.heartbeat = undefined;
  for (const d of life.disposers.splice(0)) {
    try {
      d();
    } catch {
      /* ignore */
    }
  }
}

export async function runWorkflow(def: WorkflowDef, opts: RunWorkflowOptions = {}): Promise<WorkflowRun> {
  const life: RunLifecycle = { disposers: [] };
  try {
    return await runWorkflowOwned(def, opts, life);
  } finally {
    // The lease heartbeat and abort listener never outlive the run (any exit path).
    releaseLifecycle(life);
  }
}

async function runWorkflowOwned(
  def: WorkflowDef,
  opts: RunWorkflowOptions,
  life: RunLifecycle,
): Promise<WorkflowRun> {
  // Merge CLI/daemon maxConcurrency override into the def before validation/plan.
  const defWithConc: WorkflowDef = {
    ...def,
    maxConcurrency:
      opts.maxConcurrency !== undefined
        ? normalizeMaxConcurrency(opts.maxConcurrency, 'maxConcurrency')
        : def.maxConcurrency,
  };
  validateWorkflowDef(defWithConc);
  const execStep = opts.execStep ?? defaultExecStep;
  const now = () => (opts.nowMs ? new Date(opts.nowMs()).toISOString() : new Date().toISOString());
  const nowMs = () => (opts.nowMs ? opts.nowMs() : Date.now());
  const emit = (e: WorkflowEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* ignore */
    }
  };

  const plan = buildPlan(defWithConc);
  const digest = planDigest(plan);
  const policy = normalizePolicy(defWithConc.policy);
  const runId = opts.runId ?? randomUUID().slice(0, 8);
  if (opts.runId !== undefined) assertValidRunId(opts.runId);

  const ownerId = opts.ownerId ?? randomUUID().slice(0, 8);
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  // Lease identity = the runner when there is one, else this process (D1/D4).
  const ownerLease = () =>
    makeLease({
      ownerId,
      ...(opts.runner ? { pid: opts.runner.pid, startTime: opts.runner.startTime } : {}),
      nowMs: nowMs(),
      leaseMs,
    });
  if (opts.signal?.aborted) throw new Error(`workflow run aborted before start`);
  const existing =
    opts.continueExisting || opts.resume || opts.retryFromStepId ? await readRun(runId) : null;
  const rootRunId = opts.rootRunId ?? existing?.rootRunId ?? runId;
  const parentRunId = opts.parentRunId ?? existing?.parentRunId;
  const depth = opts.depth ?? 0;
  const startedAt = existing?.startedAt ?? now();
  const deadlineAt =
    existing?.deadlineAt ?? computeDeadlineAt(startedAt, policy?.deadlineMs ?? existing?.policy?.deadlineMs);
  // Persisted plan/digest win on resume/retry so scheduling cannot silently change.
  const effectivePlan = existing?.plan ?? plan;
  const effectiveDigest = existing?.definitionDigest ?? digest;
  const effectivePolicy = existing?.policy ?? policy;
  // Ensure plan has normalized maxConcurrency for legacy records.
  if (effectivePlan.maxConcurrency === undefined) {
    effectivePlan.maxConcurrency = 1;
  }

  let run: WorkflowRun = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: existing?.revision ?? 0,
    id: runId,
    name: existing?.name ?? defWithConc.name,
    startedAt,
    status: 'running',
    finishedAt: undefined,
    // Only THIS invocation's runner: a previous (dead) runner is never inherited.
    ...(opts.runner ? { runner: opts.runner } : {}),
    steps: opts.seedResults
      ? [...opts.seedResults]
      : existing?.steps
        ? [...existing.steps]
        : [],
    plan: effectivePlan,
    definitionDigest: effectiveDigest,
    ...(opts.sourcePath || existing?.sourcePath
      ? { sourcePath: opts.sourcePath ?? existing?.sourcePath }
      : {}),
    attempts: opts.seedAttempts
      ? [...opts.seedAttempts]
      : existing?.attempts
        ? [...existing.attempts]
        : [],
    lease: ownerLease(),
    ...(effectivePolicy ? { policy: effectivePolicy } : {}),
    rootRunId,
    ...(parentRunId ? { parentRunId } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
  };

  run = await writeRunOwned(run);

  const graph = buildNormalizedGraph(effectivePlan);
  const maxConc = effectiveConcurrency(graph.maxConcurrency, effectivePolicy);
  emit({
    type: 'run-start',
    runId,
    name: run.name,
    steps: defWithConc.steps.length,
    maxConcurrency: maxConc,
  });

  const resultsById: Record<string, StepResult> = {};
  for (const s of run.steps) resultsById[s.id] = s;

  const stepsById = new Map(defWithConc.steps.map((s) => [s.id, s]));
  const continueOnFailMap = new Map(
    defWithConc.steps.map((s) => [s.id, s.continueOnFail === true] as const),
  );

  // Retry set: explicit step + DAG descendants, or first-failed closure, or empty (all incomplete).
  let retrySet: Set<string> | undefined;
  let retryBaseline: Map<string, number> | undefined;
  if (opts.retryFromStepId) {
    if (opts.retryFromStepId === '__failed__') {
      const roots = defaultRetryRoots(graph, run.attempts, run.steps);
      retrySet = roots.size > 0 ? roots : undefined;
    } else {
      retrySet = retryClosure(graph, opts.retryFromStepId);
    }
    if (retrySet && retrySet.size > 0) {
      retryBaseline = new Map();
      for (const id of retrySet) {
        const latest = latestAttemptForStep(run.attempts, id);
        retryBaseline.set(id, latest?.attemptNumber ?? 0);
      }
    }
  }

  const deriveOpts = (): import('./workflow-scheduler.ts').DeriveOpts => ({
    resume: opts.resume === true || opts.retryFromStepId !== undefined,
    retrySet,
    retryBaseline,
    continueOnFail: continueOnFailMap,
    honorContinueOnFail: true,
  });

  // Serialized persistence coordinator — parallel completions must not race CAS writes.
  let persistChain: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const runFn = persistChain.then(fn, fn);
    persistChain = runFn.then(
      () => undefined,
      () => undefined,
    );
    return runFn;
  };

  const persist = () =>
    serialize(async () => {
      if (cancelled) return;
      run.lease = ownerLease();
      try {
        run = await writeRunOwned(run);
        emit({ type: 'lease-heartbeat', runId, expiresAt: run.lease!.expiresAt, ownerId });
      } catch (e) {
        if (onWriteRefused(e)) return;
        throw e;
      }
    });

  const recordAttempt = (attempt: StepAttempt) => {
    const list = run.attempts ?? [];
    const idx = list.findIndex((a) => a.attemptId === attempt.attemptId);
    const prevPhase = idx >= 0 ? list[idx]!.phase : undefined;
    if (idx >= 0) list[idx] = attempt;
    else list.push(attempt);
    run.attempts = list;
    // A same-phase re-record only attaches data (e.g. baselineSha at `spawning`): it is
    // persisted, but it is not a transition.
    if (prevPhase === attempt.phase) return;
    emit({
      type: 'attempt-transition',
      runId,
      attemptId: attempt.attemptId,
      stepId: attempt.stepId,
      phase: attempt.phase,
      sessionId: attempt.sessionId,
    });
  };

  const upsertResult = (result: StepResult) => {
    const si = run.steps.findIndex((s) => s.id === result.id);
    if (si >= 0) run.steps[si] = result;
    else run.steps.push(result);
    resultsById[result.id] = result;
  };

  /** Persist durable blocked/skipped attempts for steps the scheduler marked terminal without launch. */
  const materializeBlockedSkipped = async (snap: SchedulerSnapshot): Promise<void> => {
    let changed = false;
    for (const view of snap.steps) {
      if (view.status !== 'blocked' && view.status !== 'skipped') continue;
      const latest = latestAttemptForStep(run.attempts, view.stepId);
      if (latest && TERMINAL_ATTEMPT_PHASES.has(latest.phase)) {
        // Already terminal — do not clobber succeeded/failed history on resume.
        if (latest.phase === 'succeeded' || latest.phase === 'failed' || latest.phase === 'cancelled') {
          continue;
        }
        if (latest.phase === 'blocked' || latest.phase === 'skipped') continue;
      }
      // On retry set membership, we may re-open; only write if no in-flight.
      if (latest && !TERMINAL_ATTEMPT_PHASES.has(latest.phase)) continue;

      const raw = stepsById.get(view.stepId);
      const provider = raw?.provider ?? effectivePlan.steps.find((s) => s.id === view.stepId)?.provider ?? 'claude';
      const phase: AttemptPhase = view.status === 'blocked' ? 'blocked' : 'skipped';
      const result: StepResult = {
        id: view.stepId,
        sessionId: '',
        provider,
        state: 'failed',
        ok: false,
        outcome: 'failed',
        commitsAhead: 0,
      };
      let attempt = createAttempt({
        stepId: view.stepId,
        provider,
        attemptNumber: nextAttemptNumber(run.attempts, view.stepId),
        now: now(),
      });
      attempt = transitionAttempt(
        attempt,
        phase,
        {
          result,
          errorCategory: phase,
          errorMessage: view.reason ?? phase,
        },
        now(),
      );
      recordAttempt(attempt);
      upsertResult(result);
      emit({
        type: 'step-blocked',
        runId,
        stepId: view.stepId,
        reason: view.reason ?? phase,
        blockedBy: view.blockedBy,
      });
      changed = true;
    }
    if (changed) await persist();
  };

  type InFlight = {
    stepId: string;
    attemptId: string;
    promise: Promise<void>;
  };
  const inFlight = new Map<string, InFlight>();
  let stopNewLaunches = false;
  let cancelled = false;

  const checkCancelled = async (): Promise<boolean> => {
    const latest = await readRun(runId);
    if (latest?.status === 'cancelled') {
      cancelled = true;
      stopNewLaunches = true;
      return true;
    }
    return false;
  };

  const safeWriteOwned = async (): Promise<boolean> => {
    if (cancelled) return false;
    run.lease = ownerLease();
    try {
      run = await writeRunOwned(run);
      return true;
    } catch (e) {
      if (onWriteRefused(e)) return false;
      throw e;
    }
  };

  /**
   * A write was refused. Finalized/cancelled → stop like a cancel. Another LIVE owner
   * holds the record (we were superseded, e.g. resumed elsewhere while we were stopped
   * past our lease) → step aside exactly like an abort: no further writes, return now.
   */
  const onWriteRefused = (e: unknown): boolean => {
    if (e instanceof LiveOwnerError) {
      stopRunner();
      return true;
    }
    if (e instanceof FinalizedRunError) {
      cancelled = true;
      stopNewLaunches = true;
      return true;
    }
    return false;
  };

  // ── Lease heartbeat (D1): renew on a timer through the serialized write path so a
  // step blocking far longer than leaseMs never lets a healthy owner's lease expire.
  const stopHeartbeat = () => {
    if (life.heartbeat !== undefined) clearInterval(life.heartbeat);
    life.heartbeat = undefined;
  };
  const heartbeatMs = Math.max(10, Math.floor(opts.heartbeatMs ?? leaseMs / 3));
  const heartbeat = () =>
    serialize(async () => {
      if (cancelled) {
        stopHeartbeat();
        return;
      }
      try {
        await safeWriteOwned();
      } catch {
        // Transient I/O (lock timeout, disk) — the next tick retries.
      }
      if (cancelled) stopHeartbeat();
    });
  // Deliberately NOT unref'd: an owning runner stays alive while it owns the record; the
  // interval is cleared on every exit path (stopHeartbeat / releaseLifecycle).
  life.heartbeat = setInterval(() => {
    void heartbeat();
  }, heartbeatMs);

  // ── Abort (D5): stop launching, stop heartbeating, never write again, return promptly.
  let aborted = false;
  let wakeOnAbort: () => void = () => {};
  const abortWake = new Promise<void>((resolve) => {
    wakeOnAbort = resolve;
  });
  const stopRunner = () => {
    aborted = true;
    cancelled = true;
    stopNewLaunches = true;
    stopHeartbeat();
    wakeOnAbort();
  };
  if (opts.signal) {
    const onAbort = () => stopRunner();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    life.disposers.push(() => opts.signal?.removeEventListener('abort', onAbort));
    if (opts.signal.aborted) onAbort();
  }

  const launchStep = async (stepId: string): Promise<void> => {
    const rawStep = stepsById.get(stepId);
    if (!rawStep) return;
    if (cancelled || stopNewLaunches) {
      // Re-check: stop may have flipped between schedule and launch.
      const latestDisk = await readRun(runId);
      if (latestDisk?.status === 'cancelled') {
        cancelled = true;
        return;
      }
      if (stopNewLaunches && !cancelled) {
        // Only skip if this was a late schedule after hard-fail; still allow if already recorded queued.
      }
    }

    const step = resolveStep(rawStep, resultsById);
    emit({ type: 'step-start', runId, stepId: step.id, provider: step.provider });

    let attempt = createAttempt({
      stepId: rawStep.id,
      provider: rawStep.provider,
      attemptNumber: nextAttemptNumber(run.attempts, rawStep.id),
      now: now(),
    });
    recordAttempt(attempt);
    await serialize(async () => {
      await safeWriteOwned();
    }); // queued before launch

    if (cancelled) return;

    attempt = transitionAttempt(attempt, 'spawning', {}, now());
    recordAttempt(attempt);
    await serialize(async () => {
      await safeWriteOwned();
    });

    await runAttempt(rawStep, attempt, (transition) =>
      execStep({
        step,
        runId,
        emit,
        lineage: {
          rootRunId,
          parentRunId: parentRunId ?? runId,
          stepId: step.id,
          depth: depth + 1,
          owner: ownerId,
          policy: effectivePolicy,
          deadlineAt,
        },
        transition,
        attempt,
      }),
    );
  };

  /**
   * Execute one attempt (fresh launch or adoption) and persist its outcome. `exec` gets
   * the attempt's mid-flight `transition` and must return the StepResult.
   */
  const runAttempt = async (
    rawStep: WorkflowStep,
    initial: StepAttempt,
    exec: (
      transition: (phase: AttemptPhase, patch?: Partial<StepAttempt>) => Promise<void>,
    ) => Promise<StepResult>,
  ): Promise<void> => {
    let attempt = initial;
    let result: StepResult | undefined;
    try {
      result = await exec(async (phase, patch) => {
        await serialize(async () => {
          attempt = transitionAttempt(attempt, phase, patch ?? {}, now());
          recordAttempt(attempt);
          await safeWriteOwned();
        });
      });
      const completed = result;
      await serialize(async () => {
        if (cancelled) return;
        // Executors that report no mid-flight transitions still pass through
        // dispatched → verifying; never step BACK to a phase the executor already passed.
        if (completed.sessionId && attemptProgress(attempt.phase) < attemptProgress('dispatched')) {
          attempt = transitionAttempt(attempt, 'dispatched', { sessionId: completed.sessionId }, now());
          recordAttempt(attempt);
        }
        attempt = transitionAttempt(attempt, 'verifying', { sessionId: completed.sessionId }, now());
        recordAttempt(attempt);
        if (!completed.ok) {
          attempt = transitionAttempt(
            attempt,
            'failed',
            {
              sessionId: completed.sessionId,
              result: completed,
              errorCategory: 'step_failed',
              errorMessage: `step ended state=${completed.state}`,
            },
            now(),
          );
        } else {
          attempt = transitionAttempt(
            attempt,
            'succeeded',
            { sessionId: completed.sessionId, result: completed },
            now(),
          );
        }
        recordAttempt(attempt);
        upsertResult(completed);
        await safeWriteOwned();
      });
    } catch (e) {
      if (onWriteRefused(e)) return;
      const msg = (e as Error).message;
      result = {
        id: rawStep.id,
        sessionId: attempt.sessionId ?? '',
        provider: rawStep.provider,
        state: 'failed',
        ok: false,
        commitsAhead: 0,
      };
      const failed = result;
      await serialize(async () => {
        attempt = transitionAttempt(
          attempt,
          'failed',
          {
            sessionId: attempt.sessionId,
            result: failed,
            errorCategory:
              (e as { code?: string }).code === 'POLICY_VIOLATION' ? 'policy' : 'spawn_or_exec',
            errorMessage: msg,
          },
          now(),
        );
        recordAttempt(attempt);
        upsertResult(failed);
        await safeWriteOwned();
      });
      emit({ type: 'step-error', runId, stepId: rawStep.id, error: msg });
    }

    if (!result) return;
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
      stopNewLaunches = true;
    }
  };

  // ── Adoption (D10): a recovered run continues in-flight attempts whose session is
  // still continuable and whose instruction reached it, instead of relaunching them.
  if (opts.resume || opts.retryFromStepId !== undefined) {
    const probe = opts.probeAdoption ?? probeAttemptSession;
    const adoptStep = opts.adoptStep ?? defaultAdoptStep;
    const allowUnknown = opts.retryFromStepId !== undefined || opts.allowUnknownDeliveryRetry === true;
    let changed = false;
    const toAdopt: StepAttempt[] = [];
    for (const id of graph.order) {
      const a = latestAttemptForStep(run.attempts, id);
      if (!a || !IN_FLIGHT_PHASES.has(a.phase)) continue;
      const facts = await probe(a, runId).catch(() => ({ sessionAlive: null }) as const);
      const takenOver = 'takenOver' in facts && facts.takenOver === true;
      const decision = adoptionDecision({
        attempt: a,
        sessionAlive: facts.sessionAlive,
        ...('verdict' in facts && facts.verdict ? { verdict: facts.verdict } : {}),
        allowUnknownDeliveryRetry: allowUnknown,
        takenOver,
      });
      if (decision === 'adopt' && stepsById.has(id)) {
        toAdopt.push(a);
        continue;
      }
      const ts = now();
      if (decision === 'require_retry' && takenOver) {
        const sid = a.sessionId ?? '';
        const failed: StepResult = {
          id,
          sessionId: sid,
          provider: a.provider,
          state: 'failed',
          ok: false,
          outcome: 'failed',
          commitsAhead: 0,
        };
        const msg =
          `session ${sid} was taken over (\`orc takeover\`); not relaunched — hand it back with ` +
          `\`orc resume ${sid}\`, then \`orc workflow retry ${runId} --step ${id}\``;
        recordAttempt(transitionAttempt(a, 'failed', { result: failed, errorCategory: 'taken_over', errorMessage: msg }, ts));
        upsertResult(failed);
        emit({ type: 'step-error', runId, stepId: id, error: msg });
      } else if (decision === 'require_retry') {
        const failed: StepResult = {
          id,
          sessionId: a.sessionId ?? '',
          provider: a.provider,
          state: 'failed',
          ok: false,
          outcome: 'failed',
          commitsAhead: 0,
        };
        recordAttempt(
          transitionAttempt(
            a,
            'failed',
            {
              result: failed,
              deliveryPhase: 'unknown',
              errorCategory: 'delivery_unknown',
              errorMessage:
                'instruction delivery is unknown (cut before the provider acknowledged it); ' +
                'not re-sent automatically — use `orc workflow retry`',
            },
            ts,
          ),
        );
        upsertResult(failed);
        emit({ type: 'step-error', runId, stepId: id, error: 'delivery unknown: explicit retry required' });
      } else {
        recordAttempt(
          transitionAttempt(
            a,
            'abandoned',
            {
              errorCategory: 'abandoned',
              errorMessage: `previous owner died; attempt not adoptable (session ${
                facts.sessionAlive === false ? 'gone or stopped' : 'not continuable'
              })`,
            },
            ts,
          ),
        );
      }
      changed = true;
    }
    if (changed) await persist();
    for (const a of toAdopt) {
      const rawStep = stepsById.get(a.stepId)!;
      emit({
        type: 'attempt-adopt',
        runId,
        attemptId: a.attemptId,
        stepId: a.stepId,
        sessionId: a.sessionId ?? '',
      });
      const step = resolveStep(rawStep, resultsById);
      const promise = runAttempt(rawStep, a, (transition) =>
        adoptStep({ step, runId, emit, attempt: a, transition }),
      ).finally(() => {
        inFlight.delete(a.stepId);
      });
      inFlight.set(a.stepId, { stepId: a.stepId, attemptId: a.attemptId, promise });
    }
  }

  // ── Bounded worker / launch loop (no unbounded Promise.all) ──────────────
  const emittedBlocked = new Set<string>();

  while (true) {
    if (aborted) break;
    if (await checkCancelled()) {
      // Cancel non-terminal pending attempts; in-flight settle below.
      break;
    }

    const snap = deriveSchedulerState(graph, run.attempts, run.steps, deriveOpts());

    if (snap.stopNewLaunches) stopNewLaunches = true;

    // Emit blocked events once and materialize durable blocked/skipped attempts.
    for (const view of snap.steps) {
      if ((view.status === 'blocked' || view.status === 'skipped') && !emittedBlocked.has(view.stepId)) {
        emittedBlocked.add(view.stepId);
      }
    }
    await materializeBlockedSkipped(snap);

    // Re-derive after materialization so allTerminal is accurate.
    const snap2 = deriveSchedulerState(graph, run.attempts, run.steps, deriveOpts());

    const runningCount = inFlight.size;
    const freeSlots = stopNewLaunches || cancelled ? 0 : Math.max(0, maxConc - runningCount);
    const toLaunch = pickReady(snap2.ready, freeSlots);

    for (const stepId of toLaunch) {
      if (inFlight.has(stepId)) continue;
      emit({
        type: 'step-scheduled',
        runId,
        stepId,
        slotsRemaining: Math.max(0, maxConc - inFlight.size - 1),
      });
      const promise = launchStep(stepId).finally(() => {
        inFlight.delete(stepId);
      });
      // attemptId filled after queued persist; track by step for concurrency.
      inFlight.set(stepId, { stepId, attemptId: '', promise });
    }

    if (inFlight.size === 0) {
      // Nothing running: either all terminal, or stuck pending (shouldn't happen), or cancelled.
      const finalSnap = deriveSchedulerState(graph, run.attempts, run.steps, deriveOpts());
      await materializeBlockedSkipped(finalSnap);
      break;
    }

    // Wait for any in-flight completion (bounded race — only currently running set), or
    // an abort, which must not wait for a step that may block for minutes.
    await Promise.race([...[...inFlight.values()].map((f) => f.promise), abortWake]);
  }

  // Drain remaining in-flight after stop/cancel — unless aborted (now or mid-drain).
  if (!aborted && inFlight.size > 0) {
    await Promise.race([Promise.all([...inFlight.values()].map((f) => f.promise)), abortWake]);
  }

  if (aborted) {
    // Terminated (SIGTERM after cancel, or a plain kill) or superseded by another live
    // owner: let an in-progress write land, then stop WITHOUT writing — a
    // cancelled/finalized status or the new owner's record stays as written; a
    // still-`running` record of ours reconciles to orphaned once this process is gone.
    stopHeartbeat();
    await persistChain;
    return (await readRun(runId)) ?? run;
  }

  if (cancelled) {
    // Prefer disk state written by cancelWorkflow; fall back to local finalize.
    const disk = await readRun(runId);
    if (disk && disk.status === 'cancelled') {
      emit({ type: 'run-done', runId, status: 'cancelled', run: disk });
      return disk;
    }
    const ts = now();
    run.attempts = (run.attempts ?? []).map((a) =>
      TERMINAL_ATTEMPT_PHASES.has(a.phase)
        ? a
        : {
            ...a,
            phase: 'cancelled' as const,
            updatedAt: ts,
            finishedAt: ts,
            errorCategory: 'cancelled',
            errorMessage: 'run cancelled',
          },
    );
    run.status = 'cancelled';
    run.finishedAt = run.finishedAt ?? ts;
    try {
      run = await writeRunOwned(run);
    } catch (e) {
      if (!(e instanceof FinalizedRunError || e instanceof LiveOwnerError)) throw e;
      const again = await readRun(runId);
      if (again) {
        emit({ type: 'run-done', runId, status: again.status, run: again });
        return again;
      }
    }
    emit({ type: 'run-done', runId, status: run.status, run });
    return run;
  }

  // Final status: done only if every plan step succeeded.
  const allSucceeded = graph.order.every((id) => {
    const r = resultsById[id];
    const latest = latestAttemptForStep(run.attempts, id);
    return r?.ok === true || latest?.phase === 'succeeded';
  });
  run.status = allSucceeded ? 'done' : 'failed';
  if (opts.resume && defWithConc.steps.every((s) => resultsById[s.id]?.ok)) run.status = 'done';
  run.finishedAt = now();
  stopHeartbeat();
  await persistChain;
  try {
    run = await writeRunOwned(run);
  } catch (e) {
    // Cancelled concurrently (after the last loop check) or superseded by another live
    // owner: their record stands.
    if (!(e instanceof FinalizedRunError || e instanceof LiveOwnerError)) throw e;
    const disk = await readRun(runId);
    if (!disk) throw e;
    emit({ type: 'run-done', runId, status: disk.status, run: disk });
    return disk;
  }
  emit({ type: 'run-done', runId, status: run.status, run });
  return run;
}

export function reconcileRunStatus(
  recordStatus: WorkflowRun['status'],
  runnerAlive: boolean | null,
  opts?: { leaseLive?: boolean | null },
): WorkflowRun['status'] {
  if (recordStatus !== 'running') return recordStatus;
  if (runnerAlive === false) return 'orphaned';
  if (opts?.leaseLive === false) return 'orphaned';
  return 'running';
}

/**
 * Liveness of a `running` record's owner (design §4.6, D1): the detached `runner`
 * process (pid + start time) when there is one — a legacy tmux runner is always dead —
 * and the lease (not expired AND its owner alive). Null = unknowable (trusted).
 */
export function runOwnerLiveness(run: WorkflowRun): {
  runnerAlive: boolean | null;
  leaseLive: boolean | null;
} {
  const runnerAlive = run.runner
    ? isSameProcessAlive(run.runner)
    : run.legacyRunnerTmux
      ? false
      : null;
  const leaseLive = run.lease
    ? isLeaseLive(run.lease, { runnerAlive, runner: run.runner ?? null })
    : null;
  return { runnerAlive, leaseLive };
}

/**
 * Don't trust a stale `running`: when its owner is dead (runner gone, lease expired or
 * its owner process gone) persist and return `orphaned` (resumable). The write is
 * conditional on the record being unchanged since it was judged, so a live owner's
 * concurrent write is never clobbered.
 */
export async function reconcileRun(run: WorkflowRun): Promise<WorkflowRun> {
  if (run.status !== 'running') return run;
  const { runnerAlive, leaseLive } = runOwnerLiveness(run);
  const effective = reconcileRunStatus(run.status, runnerAlive, { leaseLive });
  if (effective === run.status) return run;
  try {
    const written = await updateRun(run.id, (cur) =>
      cur && cur.status === 'running' && (cur.revision ?? 0) === (run.revision ?? 0)
        ? { ...cur, status: effective, finishedAt: cur.finishedAt ?? new Date().toISOString() }
        : null,
    );
    return written ?? run;
  } catch {
    return (await readRun(run.id)) ?? run;
  }
}

/**
 * Status preconditions shared by foreground and detached resume/retry (D7): a `done`
 * run is never resurrected, a `cancelled` run can only be retried, and a `running`
 * run must have a dead owner (pass the RECONCILED record).
 */
export function assertRecoveryAllowed(run: WorkflowRun, action: 'resume' | 'retry'): void {
  if (run.status === 'done') {
    throw new FinalizedRunError(run.id, run.status);
  }
  if (run.status === 'cancelled' && action === 'resume') {
    throw new Error(`run '${run.id}' is cancelled; use retry to create new attempts`);
  }
  if (run.status === 'running') {
    throw new LiveOwnerError(run.id, run.runner?.pid ?? run.lease?.pid ?? 0);
  }
}

export interface StepLog {
  step: string;
  provider: Provider;
  turns: Turn[];
}

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

export interface ResumeOptions {
  onEvent?: (e: WorkflowEvent) => void;
  execStep?: StepExecutor;
  /** Adoption of in-flight attempts (D10). Injectable for tests. */
  adoptStep?: StepAdopter;
  probeAdoption?: AdoptionProbe;
  sourcePath?: string;
  workflowSourcePath?: string;
  /** The detached runner performing this resume/retry (see RunWorkflowOptions.runner). */
  runner?: RunnerInfo;
  /** Abort the runner (see RunWorkflowOptions.signal). */
  signal?: AbortSignal;
  leaseMs?: number;
  ownerId?: string;
  allowUnknownDeliveryRetry?: boolean;
}

export interface RetryOptions extends ResumeOptions {
  stepId?: string;
}

export interface CancelOptions {
  cascade?: boolean;
  /** SIGTERM the run's live detached runner (default true). */
  signalRunner?: boolean;
  onEvent?: (e: WorkflowEvent) => void;
  killSession?: (sessionId: string) => Promise<void>;
  reason?: string;
}

export interface CleanupOptions {
  sessions?: boolean;
  worktrees?: boolean;
  killSession?: (sessionId: string, removeWorktree: boolean) => Promise<void>;
}

export async function loadWorkflowFile(file: string): Promise<{ def: WorkflowDef; absPath: string }> {
  const absPath = await resolveContainedWorkflowFile(file);
  const mod = (await import(absPath)) as { default?: WorkflowDef };
  if (!mod.default) throw new Error(`workflow file '${file}' has no default export`);
  validateWorkflowDef(mod.default);
  return { def: mod.default, absPath };
}

/**
 * Definition preconditions shared by resume/retry and their detached launchers: the
 * definition must match the run's persisted plan digest (and supply any function `done`
 * predicates), and a retry `stepId` must exist. Throws; nothing is written.
 */
export function assertRecoveryDefinition(
  existing: WorkflowRun,
  def: WorkflowDef,
  opts?: { stepId?: string; sourcePath?: string },
): void {
  assertDigestMatches(existing, def, opts?.sourcePath ?? existing.sourcePath ?? existing.workflowSourcePath);
  if (opts?.stepId && !def.steps.some((s) => s.id === opts.stepId)) {
    throw new Error(`run '${existing.id}' has no step '${opts.stepId}'`);
  }
}

function assertDigestMatches(existing: WorkflowRun, def: WorkflowDef, sourcePath?: string): void {
  // A run-time/CLI override is persisted in the original plan and intentionally
  // need not be repeated in the source definition on resume or retry.
  const plan = buildPlan({
    ...def,
    maxConcurrency: existing.plan?.maxConcurrency ?? def.maxConcurrency,
  });
  const digest = planDigest(plan);
  const preDagDigestMatches =
    (existing.schemaVersion ?? 1) < 4 &&
    existing.plan?.maxConcurrency === undefined &&
    existing.definitionDigest === legacyPlanDigest(plan);
  if (existing.definitionDigest && existing.definitionDigest !== digest && !preDagDigestMatches) {
    throw new Error(
      `workflow definition digest mismatch for run '${existing.id}' — ` +
        `provide the original workflow file/definition`,
    );
  }
  for (const ps of existing.plan?.steps ?? plan.steps) {
    if (ps.hasDonePredicate) {
      const live = def.steps.find((s) => s.id === ps.id);
      if (!live || typeof live.done !== 'function') {
        throw new Error(
          `step '${ps.id}' requires the original \`done\` predicate for resume/retry ` +
            `(function predicates remain non-portable; use a portable verify descriptor or re-run from the source workflow file)` +
            (sourcePath ? ` (${sourcePath})` : ''),
        );
      }
    }
  }
}

export async function resumeWorkflow(
  runId: string,
  def: WorkflowDef,
  opts: ResumeOptions = {},
): Promise<WorkflowRun> {
  assertValidRunId(runId);
  let existing = await readRun(runId);
  if (!existing) throw new Error(`no run found for '${runId}'`);
  if (existing.status === 'cancelled') {
    throw new Error(`run '${runId}' is cancelled; use retryWorkflow to create new attempts`);
  }
  if (existing.status === 'done') return existing;
  const sourcePath =
    opts.workflowSourcePath ?? opts.sourcePath ?? existing.sourcePath ?? existing.workflowSourcePath;
  assertDigestMatches(existing, def, sourcePath);
  // One owner id for the recovery stamp AND the run, so the owner fence sees one owner.
  const ownerId = opts.ownerId ?? randomUUID().slice(0, 8);
  if (existing.status === 'failed' || existing.status === 'orphaned') {
    existing = await beginRunRecovery(runId, {
      ownerId,
      leaseMs: opts.leaseMs,
      runner: opts.runner,
      reason: 'resume',
    });
  }
  opts.onEvent?.({ type: 'run-resume', runId, fromStatus: existing.status });
  return runWorkflow(def, {
    runId,
    resume: true,
    continueExisting: true,
    onEvent: opts.onEvent,
    execStep: opts.execStep,
    adoptStep: opts.adoptStep,
    probeAdoption: opts.probeAdoption,
    allowUnknownDeliveryRetry: opts.allowUnknownDeliveryRetry,
    sourcePath,
    runner: opts.runner,
    signal: opts.signal,
    leaseMs: opts.leaseMs,
    ownerId,
    rootRunId: existing.rootRunId ?? existing.id,
    parentRunId: existing.parentRunId,
  });
}

export async function retryWorkflow(
  runId: string,
  def: WorkflowDef,
  opts: RetryOptions = {},
): Promise<WorkflowRun> {
  assertValidRunId(runId);
  let existing = await readRun(runId);
  if (!existing) throw new Error(`no run found for '${runId}'`);
  const sourcePath =
    opts.workflowSourcePath ?? opts.sourcePath ?? existing.sourcePath ?? existing.workflowSourcePath;
  assertDigestMatches(existing, def, sourcePath);
  if (opts.stepId) {
    const found = def.steps.some((s) => s.id === opts.stepId);
    if (!found) throw new Error(`run '${runId}' has no step '${opts.stepId}'`);
  }
  const ownerId = opts.ownerId ?? randomUUID().slice(0, 8);
  if (
    existing.status === 'failed' ||
    existing.status === 'orphaned' ||
    existing.status === 'cancelled'
  ) {
    existing = await beginRunRecovery(runId, {
      ownerId,
      leaseMs: opts.leaseMs,
      runner: opts.runner,
      reason: 'retry',
      allowCancelled: true,
    });
  }
  opts.onEvent?.({ type: 'run-retry', runId, stepId: opts.stepId });
  return runWorkflow(def, {
    runId,
    retryFromStepId: opts.stepId ?? '__failed__',
    continueExisting: true,
    onEvent: opts.onEvent,
    execStep: opts.execStep,
    adoptStep: opts.adoptStep,
    probeAdoption: opts.probeAdoption,
    sourcePath,
    runner: opts.runner,
    signal: opts.signal,
    leaseMs: opts.leaseMs,
    ownerId,
    rootRunId: existing.rootRunId ?? existing.id,
    parentRunId: existing.parentRunId,
  });
}

/** Signal a run's detached runner iff it is still that same process (never ourselves). */
function signalRunner(runner: RunnerInfo | undefined, signal: NodeJS.Signals): boolean {
  if (!runner || runner.pid === process.pid || !isSameProcessAlive(runner)) return false;
  try {
    process.kill(runner.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function cancelWorkflow(runId: string, opts: CancelOptions = {}): Promise<WorkflowRun> {
  assertValidRunId(runId);
  const emit = (e: WorkflowEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* ignore */
    }
  };
  let runner: RunnerInfo | undefined;
  const run = await updateRun(runId, (cur) => {
    if (!cur) return null;
    runner = cur.runner;
    if (cur.status === 'cancelled') return cur;
    if (cur.status === 'done' || cur.status === 'failed') return cur;
    const ts = new Date().toISOString();
    const attempts = (cur.attempts ?? []).map((a) =>
      TERMINAL_ATTEMPT_PHASES.has(a.phase)
        ? a
        : {
            ...a,
            phase: 'cancelled' as const,
            updatedAt: ts,
            finishedAt: ts,
            errorCategory: 'cancelled',
            errorMessage: opts.reason ?? 'run cancelled',
          },
    );
    return {
      ...cur,
      status: 'cancelled',
      cancelledAt: cur.cancelledAt ?? ts,
      finishedAt: cur.finishedAt ?? ts,
      attempts,
      steps: projectRunSteps(attempts),
      lease: undefined,
    };
  });
  if (!run) throw new Error(`no run found for '${runId}'`);
  emit({ type: 'run-cancel', runId, cascade: opts.cascade === true });
  // D5: a live detached runner is told to stop now (it exits without overwriting the
  // cancelled status) instead of noticing at its next write. The runner pid only —
  // agent sessions are governed by --cascade.
  if (run.status === 'cancelled' && opts.signalRunner !== false) signalRunner(runner, 'SIGTERM');
  if (opts.cascade) {
    const root = run.rootRunId ?? run.id;
    const records = await readRegistry();
    const owned = records.filter(
      (r) =>
        sessionStatusOf(r) !== 'dead' &&
        (r.rootRunId === root || r.parentRunId === runId || r.rootRunId === runId),
    );
    const kill =
      opts.killSession ??
      (async (id: string) => {
        const rec = await findRecord(id);
        if (!rec) return;
        await new Session(rec).kill().catch(() => {});
      });
    for (const r of owned) await kill(r.id);
  }
  return (await readRun(runId)) ?? run;
}

export async function cleanupWorkflow(
  runId: string,
  opts: CleanupOptions = {},
): Promise<{ runId: string; sessions: string[]; worktrees: string[] }> {
  assertValidRunId(runId);
  const run = await readRun(runId);
  if (!run) throw new Error(`no run found for '${runId}'`);
  if (!opts.sessions && !opts.worktrees) {
    throw new Error('cleanup requires --sessions and/or --worktrees');
  }
  const cleanedSessions: string[] = [];
  const cleanedWorktrees: string[] = [];
  const root = run.rootRunId ?? run.id;
  const records = await readRegistry();
  const owned = records.filter(
    (r) => r.rootRunId === root || r.parentRunId === runId || r.rootRunId === run.id,
  );
  const kill =
    opts.killSession ??
    (async (id: string, removeWorktree: boolean) => {
      const rec = await findRecord(id);
      if (!rec) return;
      await new Session(rec).kill({ removeWorktree, purge: false }).catch(() => {});
    });
  for (const r of owned) {
    if (!r.rootRunId && !r.parentRunId) continue;
    await kill(r.id, opts.worktrees === true);
    cleanedSessions.push(r.id);
    if (opts.worktrees && r.worktreePath) cleanedWorktrees.push(r.worktreePath);
  }
  return { runId, sessions: cleanedSessions, worktrees: cleanedWorktrees };
}

// Re-export lineage/policy for SDK consumers (src/index.ts).
export {
  resolveLineage,
  lineageEnv,
  lineageEnvVars,
  applyInheritedContext,
  enforceSpawnPolicy,
} from './lineage.ts';
export {
  assertPolicyAllowsSpawn,
  normalizePolicy,
  computeDeadlineAt,
  PolicyViolationError,
} from './policy.ts';
