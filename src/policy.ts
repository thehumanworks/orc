/**
 * Bounded recursive delegation — enforceable ExecutionPolicy checks.
 * Fail closed with clear errors. Token/cost budgets are not measurable and are not enforced.
 */
import type { ExecutionPolicy, SessionRecord } from './types.ts';
import { ORC_ENV } from './types.ts';

function deadlineAtFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[ORC_ENV.POLICY_DEADLINE_AT];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export class PolicyViolationError extends Error {
  readonly code = 'POLICY_VIOLATION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

/** Normalize / validate a policy object (reject negative numbers). */
export function normalizePolicy(p: ExecutionPolicy | undefined): ExecutionPolicy | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: ExecutionPolicy = {};
  for (const key of ['maxDepth', 'maxSessions', 'maxConcurrentSessions', 'deadlineMs'] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new PolicyViolationError(`execution policy ${key} must be a non-negative integer`);
    }
    out[key] = v;
  }
  if (p.canDelegate !== undefined) {
    if (typeof p.canDelegate !== 'boolean') {
      throw new PolicyViolationError('execution policy canDelegate must be a boolean');
    }
    out.canDelegate = p.canDelegate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface PolicyCheckContext {
  /** Depth of the session about to be spawned. */
  depth: number;
  /** Effective policy (already merged). */
  policy?: ExecutionPolicy;
  /** Absolute deadline ISO if known (from env or root start + deadlineMs). */
  deadlineAt?: string;
  /** Now (ms) — injectable for tests. */
  nowMs?: number;
  /** Sessions already attributed to this root (registry snapshot). */
  rootSessions?: SessionRecord[];
  /**
   * How many of those currently hold a live actor (lease live, or a spawn in progress).
   * Callers compute it from the kernel (src/session-status.ts `countLiveSessions`);
   * without it, only records explicitly marked `status: 'running'` count.
   */
  liveCount?: number;
  /** Total sessions under root including the one about to spawn (usually rootSessions.length + 1). */
  totalAfterSpawn?: number;
  /** Whether this spawn is a delegated (child) spawn. */
  isDelegation?: boolean;
}

/**
 * Enforce policy before spawning. Throws PolicyViolationError on violation.
 * Pure decision over the provided counts — registry liveness is the caller's job.
 */
export function assertPolicyAllowsSpawn(ctx: PolicyCheckContext): void {
  const policy = ctx.policy;
  if (!policy) return;

  const depth = ctx.depth;
  if (policy.maxDepth !== undefined && depth > policy.maxDepth) {
    throw new PolicyViolationError(
      `execution policy maxDepth=${policy.maxDepth} exceeded (spawn depth ${depth})`,
    );
  }

  if (policy.canDelegate === false && (ctx.isDelegation || depth > 0)) {
    // depth 0 is the root process itself; children inherit depth >= 1.
    if (depth > 0 || ctx.isDelegation) {
      throw new PolicyViolationError(
        'execution policy canDelegate=false forbids further session spawns',
      );
    }
  }

  const deadlineAt = ctx.deadlineAt ?? deadlineAtFromEnv();
  if (deadlineAt) {
    const end = Date.parse(deadlineAt);
    const now = ctx.nowMs ?? Date.now();
    if (Number.isFinite(end) && now >= end) {
      throw new PolicyViolationError(`execution policy deadline exceeded (${deadlineAt})`);
    }
  } else if (policy.deadlineMs !== undefined && policy.deadlineMs === 0) {
    // deadlineMs=0 with no absolute deadline is a no-op wall clock; ignore.
  }

  const sessions = ctx.rootSessions ?? [];
  const totalAfter = ctx.totalAfterSpawn ?? sessions.length + 1;
  if (policy.maxSessions !== undefined && totalAfter > policy.maxSessions) {
    throw new PolicyViolationError(
      `execution policy maxSessions=${policy.maxSessions} exceeded (would be ${totalAfter})`,
    );
  }

  // D2: concurrency counts LIVE actors (not merely "not marked dead"): a suspended
  // session holds no process and does not use a slot until it is woken.
  const live = ctx.liveCount ?? sessions.filter((s) => s.status === 'running').length;
  // The new session will be live after spawn.
  if (policy.maxConcurrentSessions !== undefined && live + 1 > policy.maxConcurrentSessions) {
    throw new PolicyViolationError(
      `execution policy maxConcurrentSessions=${policy.maxConcurrentSessions} exceeded ` +
        `(live ${live}, spawn would make ${live + 1})`,
    );
  }
}

/** Compute absolute deadline ISO from a start time + deadlineMs. */
export function computeDeadlineAt(startedAt: string, deadlineMs: number | undefined): string | undefined {
  if (deadlineMs === undefined) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  return new Date(start + deadlineMs).toISOString();
}
