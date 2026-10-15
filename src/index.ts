/**
 * orc SDK public entry.
 */
import fs from 'node:fs/promises';
import { readRegistry, findRecord, findRecordByAlias, parseAliasSelector, updateRegistry } from './registry.ts';
import { gitToplevel, removeWorktree } from './worktree.ts';
import { resolveWorkspace } from './agent.ts';
import { Session } from './session.ts';
import { removeSessionDir } from './session-files.ts';
import { isSpawnPending, kernelLiveness, sessionStatusOf } from './session-status.ts';
import type { LivenessProbe } from './session-status.ts';
import { stop as kernelStop } from './runtime/client.ts';
import type { SessionRecord, SessionStatus } from './types.ts';

export { agent, validateOptions } from './agent.ts';
export { Session, SessionNotControllableError } from './session.ts';
export type {
  WaitForOptions,
  WaitForResult,
  SendOptions,
  SendResult,
  SessionStateDetail,
  TakeoverResult,
  AttachOptions,
} from './session.ts';
export { isSettled, resolveUntil } from './state.ts';
export { sessionStatusOf, countLiveSessions } from './session-status.ts';
export type { LivenessProbe } from './session-status.ts';
export { renderJournal, renderJournalEntry, renderCapture, lastAssistantText } from './journal-render.ts';
export { nativeResumeCommand } from './provider-cli.ts';
export type { JournalEntry, JournalEvent } from './runtime/types.ts';
export { conversationTurns, parseTranscript, renderTurns, selectTurns } from './transcript.ts';
export type { Turn, TurnRole, TurnSelection } from './transcript.ts';
export {
  defineWorkflow,
  runWorkflow,
  resumeWorkflow,
  retryWorkflow,
  cancelWorkflow,
  cleanupWorkflow,
  validateWorkflowDef,
  assertValidStepId,
  interpolate,
  evaluateStep,
  stepOutcomeFromWait,
  reconcileRunStatus,
  reconcileRun,
  runOwnerLiveness,
  assertRecoveryAllowed,
  assembleStepLogs,
  resolveContainedWorkflowFile,
  workflowImportRoots,
  buildPlan,
  buildWorkflowPlan,
  planDigest,
  digestPlanSteps,
  adoptionDecision,
  decideAdoption,
  probeAttemptSession,
  instructionMessageId,
  createAttempt,
  transitionAttempt,
  nextAttemptNumber,
  projectStepsFromAttempts,
  latestAttemptForStep,
  loadWorkflowFile,
  runnerLineageEnv,
  resolveLineage,
  lineageEnv,
  lineageEnvVars,
  enforceSpawnPolicy,
  applyInheritedContext,
  assertPolicyAllowsSpawn,
  normalizePolicy,
  computeDeadlineAt,
  PolicyViolationError,
  WORKFLOW_ROOTS_ENV,
  TERMINAL_ATTEMPT_PHASES,
  buildNormalizedGraph,
  deriveSchedulerState,
  effectiveConcurrency,
  normalizeMaxConcurrency,
  validateStepGraph,
  schedulingSummary,
  GraphValidationError,
} from './workflow.ts';
export type {
  WorkflowStep,
  WorkflowDef,
  WorkflowRun,
  StepResult,
  StepDoneCtx,
  StepLog,
  WorkflowEvent,
  RunWorkflowOptions,
  StepExecutor,
  StepAdopter,
  AdoptionProbe,
  StepAttempt,
  AttemptPhase,
  WorkflowPlan,
  PlanStep,
  RunLease,
  RunnerInfo,
  OwnerLease,
  WorkflowRunStatus,
  ResumeOptions,
  RetryOptions,
  CancelOptions,
  CleanupOptions,
  NormalizedStepGraph,
  SchedulerSnapshot,
  StepSchedStatus,
} from './workflow.ts';
export {
  assertValidRunId,
  assertValidMessageId,
  assertValidAttemptId,
  assertValidArtifactName,
  runArtifactsDir,
  runResultPath,
  runAttemptDir,
  runnerLogPath,
} from './paths.ts';
export {
  launchDetachedRun,
  launchDetachedRecovery,
  followRunnerLog,
  trapRunnerTermination,
  currentRunnerInfo,
  RunnerSpawnError,
} from './workflow-runner.ts';
export type {
  RunnerSpawner,
  LaunchRunnerOptions,
  DetachedLaunch,
  FollowRunnerLogOptions,
} from './workflow-runner.ts';
export {
  runVerify,
  executeVerify,
  assertValidVerifyDescriptor,
  captureBaselineSha,
  cloneVerifyDescriptor,
  mapToStepOutcome,
  VERIFIER_OUTPUT_BOUND,
} from './verification.ts';
export type {
  VerifyDescriptor,
  VerifierObservation,
  StepOutcome as VerifyStepOutcome,
  OutcomeInputs,
} from './verification.ts';
export {
  collectArtifact,
  collectOutputArtifact,
  collectDeclaredOutputs,
  materializeArtifact,
  materializeInput,
  materializeStepInputs,
  readArtifactManifest,
  listArtifactManifests,
  verifyArtifactBlob,
  verifyStoredBlob,
  ensureArtifactDirs,
  resolveContainedPath,
  sha256Buffer,
  sha256Hex,
  sha256File,
  hashFile,
  DEFAULT_ARTIFACT_MAX_BYTES,
  DEFAULT_MAX_ARTIFACT_BYTES,
  refFromManifest,
} from './artifacts.ts';
export type {
  ArtifactInputDecl,
  ArtifactOutputDecl,
  ArtifactRef,
  ArtifactManifest,
} from './artifacts.ts';
export {
  validateResultEnvelope,
  readResultEnvelope,
  writeResultEnvelope,
  RESULT_ENVELOPE_VERSION,
  ORC_RESULT_PATH,
} from './result-envelope.ts';
export type { ResultEnvelope } from './result-envelope.ts';
export {
  gitHead,
  gitHeadSha,
  commitCountSince,
  hasDiffSince,
  commitCountVsMain,
  hasWorkingTreeChanges,
} from './worktree.ts';
export type { DeliveryPhase } from './messages.ts';
export { withLock, acquireLock } from './lock.ts';
export {
  writeRun,
  readRun,
  listRuns,
  writeRunCAS,
  casWriteRun,
  writeRunOwned,
  updateRun,
  updateRunRetry,
  makeLease,
  heartbeatLease,
  isLeaseLive,
  isTerminalStatus,
  isFinalStatus,
  isActiveAttemptPhase,
  normalizeRun,
  projectStepsFromAttempts as projectRunStepsFromAttempts,
  latestAttempt,
  patchAttempt,
  classifyOwnerLiveness,
  stampRunner,
  CasConflictError,
  FinalizedRunError,
  LiveOwnerError,
  RUN_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSION,
  DEFAULT_LEASE_MS,
} from './runs.ts';
export type {
  Provider,
  AgentOptions,
  AgentState,
  SessionRecord,
  SessionStatus,
  SystemPromptMode,
  ExecutionPolicy,
  ExecutionLineage,
} from './types.ts';
export { ORC_ENV } from './types.ts';

async function defaultWorkspace(): Promise<string> {
  const cwd = await fs.realpath(process.cwd());
  return (await gitToplevel(cwd)) ?? cwd;
}

export async function listSessions(filter?: {
  workspace?: string;
  all?: boolean;
  dead?: boolean;
  runId?: string;
  rootRunId?: string;
  liveness?: LivenessProbe;
}): Promise<Session[]> {
  const records = await readRegistry();
  let selected: SessionRecord[] = records;
  if (filter?.runId) {
    selected = selected.filter(
      (r) => r.parentRunId === filter.runId || r.rootRunId === filter.runId,
    );
  }
  if (filter?.rootRunId) {
    selected = selected.filter((r) => r.rootRunId === filter.rootRunId);
  }
  if (!filter?.all && !filter?.runId && !filter?.rootRunId) {
    const ws =
      filter?.workspace !== undefined
        ? await resolveWorkspace(filter.workspace, process.cwd())
        : await defaultWorkspace();
    selected = selected.filter((r) => r.workspace === ws);
  } else if (filter?.workspace !== undefined) {
    const ws = await resolveWorkspace(filter.workspace, process.cwd());
    selected = selected.filter((r) => r.workspace === ws);
  }
  if (!filter?.all && !filter?.dead) {
    // D1: running + suspended (resumable) by default; dead only with --dead/--all. A
    // spawn in progress (record reserved, actor not created yet) is shown too.
    const probe = filter?.liveness ?? kernelLiveness;
    selected = selected.filter((r) => probe(r) !== 'dead' || isSpawnPending(r));
  }
  return selected.map((r) => new Session(r));
}

/**
 * Remove dead records (killed / taken over / legacy / no runtime state) and their session
 * dirs. Suspended (resumable) sessions are NEVER removed unless `suspended: true`, which
 * also stops them first. A young record whose spawn is still in progress is kept.
 */
export async function pruneSessions(opts?: {
  removeWorktree?: boolean;
  suspended?: boolean;
  liveness?: LivenessProbe;
}): Promise<string[]> {
  const probe = opts?.liveness ?? kernelLiveness;
  const records = await readRegistry();
  const observed = new Map<string, { sessionId: string; status: SessionStatus }>();
  for (const r of records) {
    let status: SessionStatus;
    try {
      status = probe(r);
    } catch {
      continue; // liveness unknowable → keep
    }
    if (status === 'running') continue;
    if (status === 'suspended' && !opts?.suspended) continue;
    if (status === 'dead' && isSpawnPending(r)) continue;
    observed.set(r.id, { sessionId: r.sessionId, status });
  }
  if (observed.size === 0) return [];
  // Suspended sessions selected by --suspended: make the stop sticky before removal so a
  // concurrent sender cannot wake an actor into a deleted dir.
  for (const r of records) {
    const o = observed.get(r.id);
    if (o?.status === 'suspended' && !r.legacy) {
      await kernelStop(r.sessionId, { reason: 'prune', graceMs: 1_000 }).catch(() => {});
    }
  }
  const removed = await updateRegistry((current) => {
    const toRemove = new Set<string>();
    for (const r of current) {
      // Only the exact record that was judged (a replacement with the same id survives).
      if (observed.get(r.id)?.sessionId === r.sessionId) toRemove.add(r.id);
    }
    return {
      records: current.filter((r) => !toRemove.has(r.id)),
      value: current.filter((r) => toRemove.has(r.id)),
    };
  });
  for (const r of removed) {
    // A legacy record's dir holds at most its old codex persona file: remove it too.
    await removeSessionDir(r.sessionId);
    if (opts?.removeWorktree && r.worktreePath) {
      await removeWorktree(r.cwd, r.worktreePath, { branch: r.branch }).catch(() => {});
    }
  }
  return removed.map((r) => r.id);
}

export async function getSession(
  idOrName: string,
  opts?: { liveness?: LivenessProbe },
): Promise<Session | null> {
  const alias = parseAliasSelector(idOrName);
  const rec = alias
    ? await findRecordByAlias(alias, {
        defaultWorkspace: await defaultWorkspace(),
        ...(opts?.liveness ? { liveness: opts.liveness } : {}),
      })
    : await findRecord(idOrName);
  return rec ? new Session(rec) : null;
}

/** Lifecycle status (running | suspended | dead) per session id. */
export async function statusOf(sessions: Session[]): Promise<Map<string, SessionStatus>> {
  const out = new Map<string, SessionStatus>();
  for (const s of sessions) out.set(s.id, sessionStatusOf(s.toJSON()));
  return out;
}
