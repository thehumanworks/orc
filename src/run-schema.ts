/**
 * Durable workflow run schema types (phase 2 + phase 3).
 * Separated so runs.ts can import without cycling through workflow.ts.
 *
 * Uses structural / local types for phase-3 fields to avoid circular type imports
 * with verification/artifacts modules (callers re-export richer types from workflow).
 */
import type { AgentState, Provider, ExecutionPolicy } from './types.ts';
import type { DeliveryPhase } from './messages.ts';
import type { ProcessIdentity } from './runtime/types.ts';

export type { AgentState, Provider, ExecutionPolicy };

export type AttemptPhase =
  | 'queued'
  | 'spawning'
  | 'dispatched'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'waiting'
  | 'cancelled'
  | 'abandoned'
  /** Dependency failed/cancelled/timed out/unverified — never launched. */
  | 'blocked'
  /** Not launched because the run stopped (hard fail without continueOnFail) or cancelled before start. */
  | 'skipped';

export const TERMINAL_ATTEMPT_PHASES: ReadonlySet<AttemptPhase> = new Set<AttemptPhase>([
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
  'blocked',
  'skipped',
]);

/**
 * Persisted step/attempt *outcome* — distinct from AgentState (TUI/process lifecycle).
 * - succeeded: verified hard signal or explicit portable contract
 * - failed: verifier rejected, crash, or explicit failure
 * - needs_input: agent asked a question / envelope needs_input; fail-closed without policy
 * - unverified: yielded with no verifier (ok:false unless allowUnverified)
 * - timed_out: waitFor deadline
 * - cancelled: run/step cancelled
 */
export type StepOutcome =
  | 'succeeded'
  | 'failed'
  | 'needs_input'
  | 'unverified'
  | 'timed_out'
  | 'cancelled';

/** JSON-safe bounded multi-turn policy on a WorkflowStep. */
export interface TurnPolicy {
  /** Max agent settles (turns) per attempt. Default 1 = single-turn. */
  maxTurns?: number;
  /**
   * When the agent needs input (envelope outcome needs_input or clear question):
   * - `fail` (default): persist needs_input and stop fail-closed
   * - `send`: send the configured `response` (required) with an idempotency key
   */
  onNeedsInput?: 'fail' | 'send';
  /** Explicit response text when onNeedsInput is `send`. Never invented. */
  response?: string;
}

/** Bounded turn event recorded on an attempt. */
export interface AttemptTurnEvent {
  turn: number;
  at: string;
  /** What triggered the turn end: settle state or policy action. */
  kind: 'settle' | 'steer' | 'timeout' | 'needs_input';
  state?: AgentState;
  envelopeOutcome?: string;
  messageId?: string;
  summary?: string;
}

/** Minimal artifact ref shape stored on StepResult (matches artifacts.ArtifactRef). */
export interface StoredArtifactRef {
  name: string;
  sha256: string;
  bytes: number;
  runId: string;
  stepId?: string;
  attemptId?: string;
  mediaType?: string;
  digest?: string;
  producerRunId?: string;
}

/** Minimal verifier observation shape (matches verification.VerifierObservation). */
export interface StoredVerifierObservation {
  kind?: string;
  type?: string;
  passed?: boolean;
  ok?: boolean;
  detail?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  data?: Record<string, string | number | boolean | null>;
  details?: Record<string, unknown>;
}

export interface StepResult {
  id: string;
  /** Short session handle; '' if spawn failed. */
  sessionId: string;
  provider: Provider;
  /** TUI/process lifecycle state at settle (NOT success). */
  state: AgentState;
  ok: boolean;
  /**
   * Explicit outcome (phase 3). Absent on legacy records — derive from ok/unverified/state.
   */
  outcome?: StepOutcome;
  worktree?: string;
  branch?: string;
  commitsAhead: number;
  /** Baseline SHA captured before spawn (for gitDiff). */
  baselineSha?: string;
  /** True when ok was inferred without a real success signal (legacy); phase 3 sets ok:false. */
  unverified?: boolean;
  /** Artifact refs produced by this step (logical name → ref). */
  artifacts?: Record<string, StoredArtifactRef>;
  /** Structured verifier observations (bounded). */
  observations?: StoredVerifierObservation[];
  /** Validated envelope if present (agent testimony). */
  envelope?: unknown;
  /** Absolute step cwd at completion. */
  cwd?: string;
  /** Path to result envelope if written. */
  resultEnvelopePath?: string;
  resultPath?: string;
}

export interface StepAttempt {
  attemptId: string;
  attemptNumber: number;
  stepId: string;
  phase: AttemptPhase;
  provider: Provider;
  /** Short session id once spawn returns. */
  sessionId?: string;
  /** Delivery message id. */
  messageId?: string;
  /** @deprecated prefer messageId */
  deliveryMessageId?: string;
  deliveryPhase?: DeliveryPhase | string;
  errorCategory?: string;
  errorMessage?: string;
  result?: StepResult;
  /** Outcome mirror for quick scans (also on result). */
  outcome?: StepOutcome;
  /** Baseline git SHA before spawn. */
  baselineSha?: string;
  /** Absolute path to ORC_RESULT_PATH for this attempt. */
  resultPath?: string;
  /** @deprecated alias for resultPath */
  resultEnvelopePath?: string;
  /** Verifier observations. */
  observations?: StoredVerifierObservation[];
  /** @deprecated alias for observations */
  verifierObservations?: StoredVerifierObservation[];
  /** Multi-turn steer events. */
  turns?: AttemptTurnEvent[];
  /** Turn index for multi-turn steering (1-based). */
  turn?: number;
  /** Artifact names collected on this attempt. */
  artifacts?: string[];
  /** Set at attempt creation (legacy-friendly). */
  createdAt?: string;
  /** Attempt start (or creation for queued). Always present after normalize. */
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface PlanStep {
  id: string;
  provider: Provider;
  alias?: string;
  taskFile?: string;
  prompt?: string;
  worktree?: boolean;
  cwd?: string;
  timeoutMs?: number;
  continueOnFail?: boolean;
  /**
   * Explicit hard dependencies (step ids). Ready when every needed step succeeded.
   * Artifact `inputs[].fromStep` edges are also treated as dependencies (inferred).
   */
  needs?: string[];
  /**
   * Local/file-only escape hatch: a function `done` predicate.
   * Non-portable — daemon JSON/resume cannot rehydrate it without the source file.
   */
  hasDonePredicate?: boolean;
  /** Portable completion contract (JSON-safe). */
  verify?: unknown;
  /** Opt-in: treat yield-with-no-verifier as ok (default false — fail closed). */
  allowUnverified?: boolean;
  outputs?: unknown;
  inputs?: unknown;
  turns?: TurnPolicy | unknown;
}

export interface WorkflowPlan {
  name: string;
  steps: PlanStep[];
  /** Preserve failed sessions for inspection instead of automatic cleanup. */
  keepSessionsOnError?: boolean;
  /**
   * Max concurrent step executions for this plan (positive integer).
   * Absent or omitted on legacy plans ⇒ 1 (strict sequential array-order).
   * Persisted in the durable plan/digest so resume/retry cannot change semantics.
   */
  maxConcurrency?: number;
  /** Optional digest on the plan itself (also stored as run.definitionDigest). */
  digest?: string;
  sourcePath?: string;
}

export interface RunLease {
  ownerId: string;
  /**
   * Pid of the process that wrote the lease. When the run has a `runner`, the runner
   * identity is the liveness authority and this is informational; otherwise liveness
   * = lease not expired AND this process (pid + startTime) still alive. 0 = unknown.
   */
  pid?: number;
  /** Start-time token of `pid` (pid-reuse guard); null/absent = pid-only check. */
  startTime?: string | null;
  updatedAt: string;
  expiresAt: string;
}

/**
 * A detached workflow runner process (`orc workflow run --detach`, detached
 * resume/retry, daemon-spawned runs): a plain detached process whose stdout/stderr
 * go to `logPath` (~/.orc/runs/<runId>/runner.log).
 */
export interface RunnerInfo extends ProcessIdentity {
  /** Append-only runner stdout/stderr log (followed by `orc workflow attach`). */
  logPath: string;
  /** ISO time the runner was spawned. */
  startedAt: string;
}

/** @deprecated alias for RunLease */
export type OwnerLease = RunLease;

export interface RunCounters {
  sessionsSpawned: number;
  sessionsActive: number;
}

export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'orphaned' | 'cancelled';

export interface WorkflowRun {
  schemaVersion?: number;
  revision?: number;
  id: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  status: WorkflowRunStatus;
  /** Detached runner process that owns this run (absent for foreground/SDK runs). */
  runner?: RunnerInfo;
  /**
   * READ-ONLY legacy marker: the pre-v5 tmux runner session name, mapped by
   * `normalizeRun` from the legacy top-level or lease tmux-runner field. Treated as a
   * dead runner (→ orphaned, resumable). Never written back to disk.
   */
  legacyRunnerTmux?: string;
  steps: StepResult[];
  plan?: WorkflowPlan;
  attempts?: StepAttempt[];
  lease?: RunLease;
  policy?: ExecutionPolicy;
  rootRunId?: string;
  parentRunId?: string;
  cancelledAt?: string;
  cancelReason?: string;
  workflowSourcePath?: string;
  sourcePath?: string;
  definitionDigest?: string;
  /** Invocation input for reloading workflow factories; private like plan prompts. */
  prompt?: string;
  deadlineAt?: string;
  counters?: RunCounters;
  /**
   * Step default model per provider, fixed when the run started (the CLI's settings.toml
   * `[models]`); resume/retry reuse it.
   */
  defaultModels?: Partial<Record<Provider, string>>;
}
