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
import { initialActorState, leaseLive, readActorState, withActorLock } from './runtime/actor-state.ts';
import { finalizeStopLocked } from './runtime/stop.ts';
import type { ActorStateFile } from './runtime/types.ts';
import { readSpawnSpec } from './runtime/spec.ts';
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
// Settings (ORC_HOST + settings.toml): the SDK never reads them on its own; callers who want
// the CLI's resolution call loadSettings() and pass the values explicitly.
export {
  loadSettings,
  decideHost,
  resolveSpawnDefaults,
  defaultModelsOf,
  hasOrcLineage,
  isTrustedPeer,
  parseSettingsToml,
  SettingsError,
  ORC_HOST_ENV,
} from './settings.ts';
export type {
  Settings,
  Setting,
  SettingSource,
  SettingsFileValues,
  SettingsFs,
  LoadSettingsOptions,
  ConsideredFile,
  HostDecision,
} from './settings.ts';
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
 * Remove dead records (killed / legacy / no runtime state) and their session dirs.
 * - Suspended (resumable) sessions are NEVER removed unless `suspended: true`, which also
 *   stops them first.
 * - Sessions TAKEN OVER by a human (`orc takeover`) are kept unless `takenOver: true`:
 *   their dir holds the system prompt the printed provider resume command refers to.
 * - A young record whose spawn is still in progress is kept.
 * Each removal re-checks the session under its actor lock and deletes the record + dir
 * while holding it, so a concurrent `orc resume` (reopen → wake, same lock) either wins
 * (the session is kept) or finds nothing to revive — never an actor in a deleted dir.
 */
/**
 * Under the actor lock: may this session's record + dir go? Legacy, never created (no
 * spawn.json) and `stopped` sessions may; live ones never; suspended ones only with
 * `suspendedToo` (they are stopped first).
 */
async function settleForRemoval(rec: SessionRecord, suspendedToo: boolean): Promise<boolean> {
  if (rec.legacy) return true;
  let st: ActorStateFile | undefined;
  try {
    if (!readSpawnSpec(rec.sessionId)) return true;
    st = readActorState(rec.sessionId);
  } catch {
    return true; // invalid id / unreadable: nothing the kernel can run
  }
  if (leaseLive(st)) return false; // never remove a live session
  if (st?.phase === 'stopped') return true;
  // Not stopped: suspended — possibly reopened by a concurrent `orc resume` (reopen runs
  // under this same lock before it un-kills the record). Kept, unless prune --suspended:
  // then its sticky stop is finalized HERE, in the same lock section, so no wake can slip
  // between the stop and the removal.
  if (!suspendedToo) return false;
  await finalizeStopLocked(rec.sessionId, st ?? initialActorState(rec.sessionId, 'suspended'), 'prune');
  return true;
}

export async function pruneSessions(opts?: {
  removeWorktree?: boolean;
  suspended?: boolean;
  takenOver?: boolean;
  liveness?: LivenessProbe;
}): Promise<string[]> {
  const probe = opts?.liveness ?? kernelLiveness;
  const prunable = (r: SessionRecord): SessionStatus | undefined => {
    let status: SessionStatus;
    try {
      status = probe(r);
    } catch {
      return undefined; // liveness unknowable → keep
    }
    if (status === 'running' || status === 'spawning') return undefined;
    if (status === 'suspended' && !opts?.suspended) return undefined;
    if (status === 'dead' && isSpawnPending(r)) return undefined;
    if (r.stoppedBy === 'takeover' && !opts?.takenOver) return undefined;
    return status;
  };
  const candidates = (await readRegistry()).filter((r) => prunable(r) !== undefined);
  const removed: SessionRecord[] = [];
  for (const cand of candidates) {
    const gone = await withActorLock(cand.sessionId, async () => {
      const current = await findRecord(cand.id);
      // Only the exact record that was judged (a replacement with the same id survives),
      // and only if it is STILL prunable now that no resume can interleave. The kernel is
      // authoritative here: `orc resume` reopens under this lock BEFORE it clears the
      // record's dead marker, so a session the kernel no longer calls stopped is kept.
      if (!current || current.sessionId !== cand.sessionId || prunable(current) === undefined) return undefined;
      if (!(await settleForRemoval(current, opts?.suspended === true))) return undefined;
      const taken = await updateRegistry((records) => {
        const hit = records.find((r) => r.id === cand.id && r.sessionId === cand.sessionId);
        return { records: hit ? records.filter((r) => r !== hit) : records, value: hit };
      });
      if (taken) await removeSessionDir(taken.sessionId);
      return taken;
    });
    if (!gone) continue;
    removed.push(gone);
    if (opts?.removeWorktree && gone.worktreePath) {
      // The branch is kept (it may hold the agent's commits); only the checkout goes.
      await removeWorktree(gone.cwd, gone.worktreePath).catch(() => {});
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
