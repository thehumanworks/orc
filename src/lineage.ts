/**
 * Execution lineage resolution and ORC_* environment propagation.
 * Explicit AgentOptions override inherited env. Policy enforcement lives in policy.ts
 * (pure) and is invoked from agent()/workflow before spawn.
 */
import type { AgentOptions, ExecutionLineage, ExecutionPolicy } from './types.ts';
import { ORC_ENV } from './types.ts';
import { normalizePolicy } from './policy.ts';

export function validateExecutionPolicy(policy: ExecutionPolicy, label = 'policy'): void {
  normalizePolicy(policy); // throws PolicyViolationError on bad shapes
  void label;
}

export function mergePolicy(
  base?: ExecutionPolicy,
  override?: ExecutionPolicy,
): ExecutionPolicy | undefined {
  if (!base && !override) return undefined;
  return normalizePolicy({ ...base, ...override });
}

/**
 * Resolve effective lineage: explicit options override inherited ORC_* env.
 */
export function resolveLineage(
  opts: ExecutionLineage,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionLineage {
  const depthEnv = env[ORC_ENV.DEPTH];
  const depthParsed = depthEnv !== undefined ? Number(depthEnv) : undefined;
  return {
    rootRunId: opts.rootRunId ?? env[ORC_ENV.ROOT_RUN_ID],
    parentRunId: opts.parentRunId ?? env[ORC_ENV.PARENT_RUN_ID] ?? env[ORC_ENV.RUN_ID],
    parentSessionId: opts.parentSessionId ?? env[ORC_ENV.PARENT_SESSION_ID],
    stepId: opts.stepId ?? env[ORC_ENV.STEP_ID],
    depth:
      opts.depth !== undefined
        ? opts.depth
        : depthParsed !== undefined && Number.isFinite(depthParsed)
          ? depthParsed
          : undefined,
    owner: opts.owner ?? env[ORC_ENV.OWNER],
  };
}

/** Parse ExecutionPolicy fields from ORC_POLICY_* env vars. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutionPolicy | undefined {
  const p: ExecutionPolicy = {};
  if (env[ORC_ENV.POLICY_MAX_DEPTH] !== undefined) {
    p.maxDepth = Number(env[ORC_ENV.POLICY_MAX_DEPTH]);
  }
  if (env[ORC_ENV.POLICY_MAX_SESSIONS] !== undefined) {
    p.maxSessions = Number(env[ORC_ENV.POLICY_MAX_SESSIONS]);
  }
  if (env[ORC_ENV.POLICY_MAX_CONCURRENT] !== undefined) {
    p.maxConcurrentSessions = Number(env[ORC_ENV.POLICY_MAX_CONCURRENT]);
  }
  if (env[ORC_ENV.POLICY_DEADLINE_MS] !== undefined) {
    p.deadlineMs = Number(env[ORC_ENV.POLICY_DEADLINE_MS]);
  }
  if (env[ORC_ENV.POLICY_CAN_DELEGATE] !== undefined) {
    const v = env[ORC_ENV.POLICY_CAN_DELEGATE]!.toLowerCase();
    p.canDelegate = v === '1' || v === 'true' || v === 'yes';
  }
  try {
    return normalizePolicy(p);
  } catch {
    return undefined;
  }
}

/**
 * Merge explicit AgentOptions with inherited ORC_* context.
 * Explicit fields win; missing fields fill from env.
 */
export function applyInheritedContext(opts: AgentOptions, env: NodeJS.ProcessEnv = process.env): AgentOptions {
  const lineage = resolveLineage(opts, env);
  const envPolicy = policyFromEnv(env);
  const policy = mergePolicy(envPolicy, opts.policy);
  return {
    ...opts,
    rootRunId: lineage.rootRunId,
    parentRunId: lineage.parentRunId,
    parentSessionId: lineage.parentSessionId,
    stepId: lineage.stepId,
    depth: lineage.depth,
    owner: lineage.owner,
    ...(policy ? { policy } : {}),
  };
}

export interface LineageEnvInput extends ExecutionLineage {
  policy?: ExecutionPolicy;
  deadlineAt?: string;
}

/**
 * Build ORC_* env vars for child processes (detached runners, nested orc CLIs).
 * Empty values are omitted.
 */
export function lineageEnvVars(input: LineageEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  if (input.rootRunId) env[ORC_ENV.ROOT_RUN_ID] = input.rootRunId;
  if (input.parentRunId) env[ORC_ENV.PARENT_RUN_ID] = input.parentRunId;
  if (input.parentSessionId) env[ORC_ENV.PARENT_SESSION_ID] = input.parentSessionId;
  if (input.stepId) env[ORC_ENV.STEP_ID] = input.stepId;
  if (input.depth !== undefined) env[ORC_ENV.DEPTH] = String(input.depth);
  if (input.owner) env[ORC_ENV.OWNER] = input.owner;
  if (input.deadlineAt) env[ORC_ENV.POLICY_DEADLINE_AT] = input.deadlineAt;
  if (input.policy?.maxDepth !== undefined) {
    env[ORC_ENV.POLICY_MAX_DEPTH] = String(input.policy.maxDepth);
  }
  if (input.policy?.maxSessions !== undefined) {
    env[ORC_ENV.POLICY_MAX_SESSIONS] = String(input.policy.maxSessions);
  }
  if (input.policy?.maxConcurrentSessions !== undefined) {
    env[ORC_ENV.POLICY_MAX_CONCURRENT] = String(input.policy.maxConcurrentSessions);
  }
  if (input.policy?.deadlineMs !== undefined) {
    env[ORC_ENV.POLICY_DEADLINE_MS] = String(input.policy.deadlineMs);
  }
  if (input.policy?.canDelegate !== undefined) {
    env[ORC_ENV.POLICY_CAN_DELEGATE] = input.policy.canDelegate ? '1' : '0';
  }
  return env;
}

/** Alias used by agent spawn env threading. */
export function lineageEnv(lineage: LineageEnvInput): Record<string, string> {
  return lineageEnvVars(lineage);
}

/**
 * Lightweight pre-spawn policy check used by agent().
 * Uses registry counts when a rootRunId is present.
 */
export async function enforceSpawnPolicy(args: {
  lineage: ExecutionLineage;
  policy?: ExecutionPolicy;
  isDelegation?: boolean;
}): Promise<void> {
  const { lineage } = args;
  const rootId = lineage.rootRunId;
  if (!rootId && !args.policy) return;

  const { readRegistry } = await import('./registry.ts');
  const { assertPolicyAllowsSpawn } = await import('./policy.ts');
  const { readRun } = await import('./runs.ts');

  const root = rootId ? await readRun(rootId) : null;
  const policy = mergePolicy(root?.policy, args.policy);
  if (!policy) return;

  const records = rootId
    ? (await readRegistry()).filter((r) => r.rootRunId === rootId || r.parentRunId === rootId)
    : [];

  assertPolicyAllowsSpawn({
    depth: lineage.depth ?? 0,
    policy,
    deadlineAt: root?.deadlineAt,
    rootSessions: records,
    isDelegation: args.isDelegation || (lineage.depth ?? 0) > 0,
    totalAfterSpawn: records.length + 1,
  });
}

/** Decrement is a no-op for registry-based counting; kept for kill-path symmetry. */
export async function releaseSessionPolicy(_rootRunId: string | undefined): Promise<void> {
  // Counts are derived from the registry at spawn time; no counter file to release.
}
