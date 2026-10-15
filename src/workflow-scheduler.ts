/**
 * Pure DAG / fleet scheduler for workflow steps.
 *
 * Derives ready / blocked / running / terminal sets from the durable plan +
 * attempt history. No I/O, no side effects — the runner owns persistence.
 *
 * ## Semantics
 *
 * - **Default `maxConcurrency` is 1** (absent ⇒ 1). With cap 1 and no `needs`,
 *   definition-order ready picks reproduce strict array-order sequential runs.
 * - **`needs?: string[]`** are explicit hard dependencies. Ready when every
 *   needed step has a terminal *success* (phase `succeeded` or result.ok).
 * - **Artifact rule (inferred deps):** each `inputs[].fromStep` is unioned into
 *   the step's effective dependency set. A declared artifact input from another
 *   step therefore always waits on that producer (explicit `needs` optional).
 *   Missing / self `fromStep` fail validation.
 * - **Dependency failure:** if any required dep terminally failed / cancelled /
 *   timed out / unverified / blocked / skipped, the dependent is **blocked**
 *   and must never launch.
 * - **continueOnFail:** when a step fails without `continueOnFail`, the run
 *   stops launching *new* work (including independent branches) after in-flight
 *   settle. When `continueOnFail` is true, independent branches continue;
 *   dependents of the failed step remain blocked.
 * - **Deterministic ready order:** among ready steps, pick by definition order.
 * - **Caps:** never launch more than `effectiveConcurrency(maxConcurrency,
 *   policy.maxConcurrentSessions)`.
 */

import type { AttemptPhase, PlanStep, StepAttempt, StepResult, WorkflowPlan } from './run-schema.ts';
import type { ExecutionPolicy } from './types.ts';

/** Terminal attempt phases (including scheduler-owned blocked/skipped). */
export const SCHEDULER_TERMINAL_PHASES: ReadonlySet<AttemptPhase> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
  'blocked',
  'skipped',
]);

export const IN_FLIGHT_PHASES: ReadonlySet<AttemptPhase> = new Set([
  'queued',
  'spawning',
  'dispatched',
  'running',
  'verifying',
  'waiting',
]);

export type StepSchedStatus =
  | 'pending' // never attempted / not yet considered
  | 'ready'
  | 'blocked'
  | 'running' // in-flight attempt
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface NormalizedStepGraph {
  /** Step ids in definition order. */
  order: string[];
  /** Effective needs (explicit + inferred artifact fromStep), deduped, definition-stable. */
  needs: Map<string, string[]>;
  /** Reverse edges: step → dependents. */
  dependents: Map<string, string[]>;
  /** Plan maxConcurrency (normalized ≥ 1). */
  maxConcurrency: number;
}

export interface StepView {
  stepId: string;
  status: StepSchedStatus;
  /** Why blocked/skipped, if any. */
  reason?: string;
  blockedBy?: string[];
  /** Latest attempt phase if present. */
  phase?: AttemptPhase;
  attemptId?: string;
}

export interface SchedulerSnapshot {
  steps: StepView[];
  ready: string[];
  blocked: string[];
  running: string[];
  terminal: string[];
  pending: string[];
  /** True when a hard-fail step finished without continueOnFail — stop new launches. */
  stopNewLaunches: boolean;
  /** All plan steps are terminal. */
  allTerminal: boolean;
}

export class GraphValidationError extends Error {
  readonly code = 'GRAPH_VALIDATION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

/** Normalize a positive integer concurrency (default 1). Throws on invalid values. */
export function normalizeMaxConcurrency(value: unknown, label = 'maxConcurrency'): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new GraphValidationError(`${label} must be a positive integer (>= 1), got ${String(value)}`);
  }
  // Bound absurd values to keep launch loops finite.
  if (value > 10_000) {
    throw new GraphValidationError(`${label} must be <= 10000`);
  }
  return value;
}

/**
 * Enforceable launch cap: min(workflow maxConcurrency, policy maxConcurrentSessions).
 * Absent policy bound ⇒ workflow max only. Always ≥ 1.
 */
export function effectiveConcurrency(
  maxConcurrency: number | undefined,
  policy?: Pick<ExecutionPolicy, 'maxConcurrentSessions'> | null,
): number {
  const wf = normalizeMaxConcurrency(maxConcurrency ?? 1);
  const pol = policy?.maxConcurrentSessions;
  if (pol === undefined || pol === null) return wf;
  if (typeof pol !== 'number' || !Number.isFinite(pol) || !Number.isInteger(pol) || pol < 0) {
    // Fail closed: treat invalid policy as 1.
    return 1;
  }
  if (pol === 0) return 1; // zero concurrent sessions is unusable; fail closed to 1 and let policy spawn checks reject
  return Math.min(wf, pol);
}

/** Latest attempt per step id (highest attemptNumber). */
export function latestAttemptsByStep(
  attempts: StepAttempt[] | undefined,
): Map<string, StepAttempt> {
  const map = new Map<string, StepAttempt>();
  for (const a of attempts ?? []) {
    const prev = map.get(a.stepId);
    if (!prev || a.attemptNumber >= prev.attemptNumber) map.set(a.stepId, a);
  }
  return map;
}

function isSuccessPhase(phase: AttemptPhase | undefined, result?: StepResult): boolean {
  if (phase === 'succeeded') return true;
  if (result?.ok === true && result.outcome !== 'unverified') return true;
  // allowUnverified ok=true with outcome unverified still counts as "succeeded attempt" if phase succeeded.
  if (result?.ok === true && phase === undefined) return true;
  return false;
}

function isHardFailure(phase: AttemptPhase | undefined, result?: StepResult): boolean {
  if (phase === 'failed' || phase === 'cancelled' || phase === 'abandoned' || phase === 'blocked' || phase === 'skipped') {
    return true;
  }
  if (result && result.ok === false) return true;
  if (result?.outcome === 'timed_out' || result?.outcome === 'cancelled' || result?.outcome === 'unverified') {
    // unverified with ok:false is hard failure for dependents
    if (result.ok === false || result.outcome !== 'unverified') return true;
    if (result.outcome === 'unverified' && result.ok !== true) return true;
  }
  return false;
}

function isInFlight(phase: AttemptPhase | undefined): boolean {
  return phase !== undefined && IN_FLIGHT_PHASES.has(phase);
}

function isTerminalPhase(phase: AttemptPhase | undefined): boolean {
  return phase !== undefined && SCHEDULER_TERMINAL_PHASES.has(phase);
}

/**
 * Collect effective needs for a plan step: explicit `needs` ∪ `inputs[].fromStep`.
 * Deduped, preserves first-seen order (needs first, then inferred).
 */
export function effectiveNeedsOf(
  step: Pick<PlanStep, 'id' | 'needs' | 'inputs'>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (Array.isArray(step.needs)) {
    for (const n of step.needs) {
      if (typeof n === 'string' && n.length > 0) add(n);
    }
  }
  const inputs = step.inputs;
  if (Array.isArray(inputs)) {
    for (const raw of inputs) {
      if (!raw || typeof raw !== 'object') continue;
      const from = (raw as { fromStep?: unknown }).fromStep;
      if (typeof from === 'string' && from.length > 0) add(from);
    }
  }
  return out;
}

/**
 * Validate dependency graph + artifact fromStep edges.
 * Throws GraphValidationError with actionable step ids.
 */
export function validateStepGraph(
  steps: ReadonlyArray<Pick<PlanStep, 'id' | 'needs' | 'inputs'>>,
  opts?: { workflowName?: string },
): void {
  const label = opts?.workflowName ? `workflow '${opts.workflowName}'` : 'workflow';
  const ids = new Set(steps.map((s) => s.id));
  const order = steps.map((s) => s.id);

  for (const step of steps) {
    const needs = step.needs;
    if (needs !== undefined) {
      if (!Array.isArray(needs)) {
        throw new GraphValidationError(`${label} step '${step.id}': needs must be a string array`);
      }
      const seenLocal = new Set<string>();
      for (const n of needs) {
        if (typeof n !== 'string' || n.length === 0) {
          throw new GraphValidationError(
            `${label} step '${step.id}': needs entries must be non-empty strings`,
          );
        }
        if (n === step.id) {
          throw new GraphValidationError(
            `${label} step '${step.id}': self-dependency is not allowed (needs includes '${n}')`,
          );
        }
        if (!ids.has(n)) {
          throw new GraphValidationError(
            `${label} step '${step.id}': needs unknown step id '${n}' ` +
              `(known: ${order.join(', ') || 'none'})`,
          );
        }
        if (seenLocal.has(n)) {
          throw new GraphValidationError(
            `${label} step '${step.id}': duplicate needs entry '${n}'`,
          );
        }
        seenLocal.add(n);
      }
    }

    // Artifact fromStep validation (inferred edge rule).
    const inputs = step.inputs;
    if (Array.isArray(inputs)) {
      for (const raw of inputs) {
        if (!raw || typeof raw !== 'object') continue;
        const from = (raw as { fromStep?: unknown }).fromStep;
        if (from === undefined) continue;
        if (typeof from !== 'string' || from.length === 0) {
          throw new GraphValidationError(
            `${label} step '${step.id}': inputs.fromStep must be a non-empty string`,
          );
        }
        if (from === step.id) {
          throw new GraphValidationError(
            `${label} step '${step.id}': artifact input cannot reference self (fromStep='${from}')`,
          );
        }
        if (!ids.has(from)) {
          throw new GraphValidationError(
            `${label} step '${step.id}': artifact input fromStep '${from}' is not a step id ` +
              `(known: ${order.join(', ') || 'none'})`,
          );
        }
      }
    }
  }

  // Cycle detection on effective edges (needs ∪ fromStep).
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    adj.set(s.id, effectiveNeedsOf(s));
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of order) color.set(id, WHITE);
  const stack: string[] = [];

  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // cycle: v ... u → v
        const idx = stack.indexOf(v);
        const cycle = [...stack.slice(idx), v];
        return cycle;
      }
      if (c === WHITE) {
        const cyc = dfs(v);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };

  for (const id of order) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const cycle = dfs(id);
      if (cycle) {
        throw new GraphValidationError(
          `${label}: dependency cycle detected: ${cycle.join(' → ')}`,
        );
      }
    }
  }
}

/** Build normalized graph from a durable plan (after validation). */
export function buildNormalizedGraph(plan: WorkflowPlan): NormalizedStepGraph {
  validateStepGraph(plan.steps, { workflowName: plan.name });
  const order = plan.steps.map((s) => s.id);
  const needs = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const id of order) dependents.set(id, []);

  for (const s of plan.steps) {
    const eff = effectiveNeedsOf(s);
    needs.set(s.id, eff);
    for (const n of eff) {
      const list = dependents.get(n) ?? [];
      if (!list.includes(s.id)) list.push(s.id);
      dependents.set(n, list);
    }
  }

  return {
    order,
    needs,
    dependents,
    maxConcurrency: normalizeMaxConcurrency(plan.maxConcurrency ?? 1),
  };
}

/** Transitive dependents of a step (not including the step itself), definition order. */
export function transitiveDependents(graph: NormalizedStepGraph, stepId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(graph.dependents.get(stepId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const d of graph.dependents.get(id) ?? []) stack.push(d);
  }
  // Stable: definition order.
  return graph.order.filter((id) => seen.has(id));
}

/**
 * Steps that must be re-attempted on retry from `fromStepId` (self + affected descendants).
 * - Always includes transitive `needs` descendants.
 * - At maxConcurrency === 1 (legacy sequential), also includes every subsequent
 *   definition-order step (matches historical retry --step tail semantics).
 * - At maxConcurrency > 1, also closes over any step whose effective needs intersect
 *   the set (fixed-point), without re-running independent branches.
 */
export function retryClosure(graph: NormalizedStepGraph, fromStepId: string): Set<string> {
  const set = new Set<string>([fromStepId, ...transitiveDependents(graph, fromStepId)]);
  if (graph.maxConcurrency <= 1) {
    const idx = graph.order.indexOf(fromStepId);
    if (idx >= 0) {
      for (let i = idx + 1; i < graph.order.length; i++) set.add(graph.order[i]!);
    }
    return set;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of graph.order) {
      if (set.has(id)) continue;
      const needs = graph.needs.get(id) ?? [];
      if (needs.some((n) => set.has(n))) {
        set.add(id);
        changed = true;
      }
    }
  }
  return set;
}

/**
 * When retrying without an explicit step, find the first failed/blocked step in
 * definition order; retry that node + descendants. If none, empty set means re-run all incomplete.
 */
export function defaultRetryRoots(
  graph: NormalizedStepGraph,
  attempts: StepAttempt[] | undefined,
  results: StepResult[] | undefined,
): Set<string> {
  const latest = latestAttemptsByStep(attempts);
  const byResult = new Map((results ?? []).map((r) => [r.id, r]));
  for (const id of graph.order) {
    const a = latest.get(id);
    const r = byResult.get(id) ?? a?.result;
    if (isSuccessPhase(a?.phase, r)) continue;
    if (!a && !r) continue; // never started — will be scheduled by resume semantics
    // failed / blocked / cancelled / incomplete terminal
    if (a && isTerminalPhase(a.phase) && !isSuccessPhase(a.phase, r)) {
      return retryClosure(graph, id);
    }
    if (r && r.ok === false) return retryClosure(graph, id);
  }
  // No explicit failure root: empty means "all incomplete".
  return new Set();
}

export interface DeriveOpts {
  /**
   * When set (retry), only these step ids may receive new launches if not already
   * succeeded after a post-baseline attempt. Empty set = resume-like incomplete scheduling.
   */
  retrySet?: Set<string>;
  /**
   * Per-step max attemptNumber at retry start. Steps in `retrySet` with
   * `latest.attemptNumber <= baseline` are re-opened as pending; once a new
   * attempt (number > baseline) terminates, that outcome is kept.
   */
  retryBaseline?: Map<string, number> | Record<string, number>;
  /**
   * Resume mode: succeeded steps are terminal; failed/blocked/skipped/incomplete
   * are re-scheduled (deps still gate blocked dependents until producers succeed).
   */
  resume?: boolean;
  /**
   * continueOnFail by step id (from live def or plan).
   */
  continueOnFail?: Map<string, boolean> | Record<string, boolean | undefined>;
  /**
   * When true, a hard failure without continueOnFail forces stopNewLaunches.
   * Default true.
   */
  honorContinueOnFail?: boolean;
}

function baselineOf(
  map: DeriveOpts['retryBaseline'],
  stepId: string,
): number {
  if (!map) return 0;
  if (map instanceof Map) return map.get(stepId) ?? 0;
  return map[stepId] ?? 0;
}

function continueOnFailOf(
  map: DeriveOpts['continueOnFail'],
  stepId: string,
): boolean {
  if (!map) return false;
  if (map instanceof Map) return map.get(stepId) === true;
  return map[stepId] === true;
}

/**
 * Deterministically derive scheduler snapshot from durable attempt history.
 */
export function deriveSchedulerState(
  graph: NormalizedStepGraph,
  attempts: StepAttempt[] | undefined,
  results: StepResult[] | undefined,
  opts: DeriveOpts = {},
): SchedulerSnapshot {
  const latest = latestAttemptsByStep(attempts);
  const byResult = new Map((results ?? []).map((r) => [r.id, r]));
  const honorCof = opts.honorContinueOnFail !== false;

  // First pass: classify terminal / running from attempts + results.
  const status = new Map<string, StepSchedStatus>();
  const reason = new Map<string, string>();
  const blockedBy = new Map<string, string[]>();
  const phaseOf = new Map<string, AttemptPhase>();
  const attemptIdOf = new Map<string, string>();

  for (const id of graph.order) {
    const a = latest.get(id);
    const r = byResult.get(id) ?? a?.result;
    if (a) {
      phaseOf.set(id, a.phase);
      attemptIdOf.set(id, a.attemptId);
    }

    // Retry set: re-open steps whose latest attempt is still the pre-retry baseline.
    if (opts.retrySet && opts.retrySet.size > 0 && opts.retrySet.has(id)) {
      const baseline = baselineOf(opts.retryBaseline, id);
      const n = a?.attemptNumber ?? 0;
      if (a && isInFlight(a.phase)) {
        status.set(id, 'running');
        continue;
      }
      if (n > baseline) {
        // New attempt from this retry — classify normally below (fall through).
      } else {
        // Pre-retry history: schedule a fresh attempt.
        status.set(id, 'pending');
        continue;
      }
    }

    if (a && isInFlight(a.phase)) {
      status.set(id, 'running');
      continue;
    }
    if (isSuccessPhase(a?.phase, r)) {
      status.set(id, 'succeeded');
      continue;
    }

    // Resume re-opens non-success terminals so incomplete work can finish.
    // Dependents of still-failed producers become blocked in the second pass. An attempt
    // whose instruction delivery is unknown is NOT re-opened: it was never proven
    // undelivered, so only an explicit retry may send it again.
    if (
      opts.resume &&
      !(opts.retrySet && opts.retrySet.size > 0) &&
      a?.errorCategory !== 'delivery_unknown'
    ) {
      if (
        a?.phase === 'blocked' ||
        a?.phase === 'skipped' ||
        a?.phase === 'failed' ||
        a?.phase === 'cancelled' ||
        a?.phase === 'abandoned' ||
        (r && r.ok === false) ||
        (a && isTerminalPhase(a.phase) && !isSuccessPhase(a.phase, r))
      ) {
        status.set(id, 'pending');
        continue;
      }
    }

    if (a?.phase === 'blocked') {
      status.set(id, 'blocked');
      if (a.errorMessage) reason.set(id, a.errorMessage);
      continue;
    }
    if (a?.phase === 'skipped') {
      status.set(id, 'skipped');
      if (a.errorMessage) reason.set(id, a.errorMessage);
      continue;
    }
    if (a?.phase === 'cancelled' || r?.outcome === 'cancelled') {
      status.set(id, 'cancelled');
      continue;
    }
    if (isHardFailure(a?.phase, r) || (a && isTerminalPhase(a.phase) && !isSuccessPhase(a.phase, r))) {
      status.set(id, 'failed');
      continue;
    }
    // No attempt / incomplete
    status.set(id, 'pending');
  }

  // Hard-stop detection: any failed step without continueOnFail.
  let stopNewLaunches = false;
  if (honorCof) {
    for (const id of graph.order) {
      const st = status.get(id);
      if (st === 'failed' || st === 'cancelled') {
        if (!continueOnFailOf(opts.continueOnFail, id)) {
          // Only stop if this is a real executed failure, not a pre-blocked node.
          const a = latest.get(id);
          if (a?.phase === 'blocked' || a?.phase === 'skipped') continue;
          if (st === 'failed' || st === 'cancelled') {
            stopNewLaunches = true;
            break;
          }
        }
      }
    }
  }

  // Second pass: pending → ready | blocked based on deps.
  for (const id of graph.order) {
    if (status.get(id) !== 'pending') continue;

    const deps = graph.needs.get(id) ?? [];
    const failedDeps: string[] = [];
    let waiting = false;
    for (const d of deps) {
      const ds = status.get(d) ?? 'pending';
      if (ds === 'succeeded') continue;
      if (ds === 'failed' || ds === 'blocked' || ds === 'skipped' || ds === 'cancelled') {
        failedDeps.push(d);
        continue;
      }
      // pending / ready / running
      waiting = true;
    }
    if (failedDeps.length > 0) {
      status.set(id, 'blocked');
      blockedBy.set(id, failedDeps);
      reason.set(
        id,
        `blocked: required dependenc${failedDeps.length === 1 ? 'y' : 'ies'} ` +
          `${failedDeps.map((x) => `'${x}'`).join(', ')} did not succeed`,
      );
      continue;
    }
    if (waiting) {
      // still pending (waiting on running/pending deps)
      continue;
    }
    // All deps succeeded (or no deps) → ready, unless stopNewLaunches.
    if (stopNewLaunches) {
      status.set(id, 'skipped');
      reason.set(id, 'skipped: run stopped after a failed step without continueOnFail');
      continue;
    }
    status.set(id, 'ready');
  }

  // If stopNewLaunches, demote remaining ready → skipped (except already running).
  if (stopNewLaunches) {
    for (const id of graph.order) {
      if (status.get(id) === 'ready' || status.get(id) === 'pending') {
        status.set(id, 'skipped');
        if (!reason.has(id)) {
          reason.set(id, 'skipped: run stopped after a failed step without continueOnFail');
        }
      }
    }
  }

  const steps: StepView[] = graph.order.map((stepId) => {
    const st = status.get(stepId) ?? 'pending';
    const view: StepView = { stepId, status: st };
    if (reason.has(stepId)) view.reason = reason.get(stepId);
    if (blockedBy.has(stepId)) view.blockedBy = blockedBy.get(stepId);
    if (phaseOf.has(stepId)) view.phase = phaseOf.get(stepId);
    if (attemptIdOf.has(stepId)) view.attemptId = attemptIdOf.get(stepId);
    return view;
  });

  const ready = graph.order.filter((id) => status.get(id) === 'ready');
  const blocked = graph.order.filter((id) => status.get(id) === 'blocked');
  const running = graph.order.filter((id) => status.get(id) === 'running');
  const terminal = graph.order.filter((id) => {
    const st = status.get(id);
    return (
      st === 'succeeded' ||
      st === 'failed' ||
      st === 'blocked' ||
      st === 'skipped' ||
      st === 'cancelled'
    );
  });
  const pending = graph.order.filter((id) => status.get(id) === 'pending');
  const allTerminal = terminal.length === graph.order.length;

  return {
    steps,
    ready,
    blocked,
    running,
    terminal,
    pending,
    stopNewLaunches,
    allTerminal,
  };
}

/**
 * Pick up to `slots` ready step ids in definition order (already sorted by derive).
 */
export function pickReady(ready: readonly string[], slots: number): string[] {
  if (slots <= 0) return [];
  return ready.slice(0, slots);
}

/**
 * Persistable plan scheduling fields for status views (no prompts).
 */
export function schedulingSummary(
  plan: WorkflowPlan | undefined,
  attempts: StepAttempt[] | undefined,
  results: StepResult[] | undefined,
  opts?: DeriveOpts,
): {
  maxConcurrency: number;
  steps: Array<{
    id: string;
    needs: string[];
    status: StepSchedStatus;
    reason?: string;
    blockedBy?: string[];
    phase?: AttemptPhase;
  }>;
} | null {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  try {
    const graph = buildNormalizedGraph(plan);
    const snap = deriveSchedulerState(graph, attempts, results, opts);
    return {
      maxConcurrency: graph.maxConcurrency,
      steps: snap.steps.map((s) => ({
        id: s.stepId,
        needs: graph.needs.get(s.stepId) ?? [],
        status: s.status,
        ...(s.reason ? { reason: s.reason } : {}),
        ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
        ...(s.phase ? { phase: s.phase } : {}),
      })),
    };
  } catch {
    return {
      maxConcurrency: normalizeMaxConcurrency(plan.maxConcurrency ?? 1),
      steps: plan.steps.map((s) => ({
        id: s.id,
        needs: effectiveNeedsOf(s),
        status: 'pending' as const,
      })),
    };
  }
}
