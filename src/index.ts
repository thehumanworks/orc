/**
 * orc SDK public entry.
 */
import fs from 'node:fs/promises';
import { getDriver } from './drivers/driver.ts';
import { readRegistry, findRecord, findRecordByAlias, parseAliasSelector, updateRegistry } from './registry.ts';
import type { Driver } from './drivers/driver.ts';
import { gitToplevel, removeWorktree } from './worktree.ts';
import { resolveWorkspace } from './agent.ts';
import { Session } from './session.ts';
import { removeSessionInstructions } from './session-files.ts';
import type { SessionRecord } from './types.ts';

export { agent, validateOptions } from './agent.ts';
export { Session } from './session.ts';
export type { WaitForOptions, SendOptions, SendResult } from './session.ts';
export { classifyState, reduceWait, isSettled } from './state.ts';
export type { StateMatchers, WaitTracking } from './state.ts';
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
  runnerTmuxName,
  reconcileRunStatus,
  reconcileRun,
  assembleStepLogs,
  resolveContainedWorkflowFile,
  workflowImportRoots,
  buildPlan,
  buildWorkflowPlan,
  planDigest,
  digestPlanSteps,
  adoptionDecision,
  decideAdoption,
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
  StepAttempt,
  AttemptPhase,
  WorkflowPlan,
  PlanStep,
  RunLease,
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
} from './paths.ts';
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
export {
  hashPayload,
  evaluateDeliveryReplay,
  readDelivery,
  persistDelivery,
} from './messages.ts';
export type { DeliveryPhase, DeliveryRecord } from './messages.ts';
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
  CasConflictError,
  FinalizedRunError,
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
  PaneInfo,
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
    selected = selected.filter((r) => r.status !== 'dead');
  }
  return selected.map((r) => new Session(r));
}

export async function pruneSessions(opts?: {
  removeWorktree?: boolean;
  driver?: Driver;
}): Promise<string[]> {
  const driver = opts?.driver ?? getDriver();
  const records = await readRegistry();
  const deadById = new Map<string, string>();
  await Promise.all(
    records.map(async (r) => {
      if (r.status === 'dead') {
        deadById.set(r.id, r.tmuxName);
        return;
      }
      try {
        if (!(await driver.isAlive(r.tmuxName))) deadById.set(r.id, r.tmuxName);
      } catch {
        /* ignore */
      }
    }),
  );
  const dead = await updateRegistry((current) => {
    const toRemove = new Set<string>();
    for (const r of current) {
      const observedTmuxName = deadById.get(r.id);
      if (r.status === 'dead' || observedTmuxName === r.tmuxName) toRemove.add(r.id);
    }
    return {
      records: current.filter((r) => !toRemove.has(r.id)),
      value: current.filter((r) => toRemove.has(r.id)),
    };
  });
  if (dead.length === 0) return [];
  for (const r of dead) {
    // Drop orc-owned codex instruction sidecars for purged records (not user files).
    await removeSessionInstructions(r).catch(() => {});
    if (opts?.removeWorktree && r.worktreePath) {
      await removeWorktree(r.cwd, r.worktreePath, { branch: r.branch }).catch(() => {});
    }
  }
  return dead.map((r) => r.id);
}

export async function getSession(idOrName: string): Promise<Session | null> {
  const alias = parseAliasSelector(idOrName);
  const rec = alias
    ? await findRecordByAlias(alias, {
        defaultWorkspace: await defaultWorkspace(),
        driver: getDriver(),
      })
    : await findRecord(idOrName);
  return rec ? new Session(rec) : null;
}

export async function statusOf(sessions: Session[]): Promise<Map<string, 'running' | 'dead'>> {
  const driver = getDriver();
  const out = new Map<string, 'running' | 'dead'>();
  await Promise.all(
    sessions.map(async (s) => {
      out.set(s.id, (await driver.isAlive(s.tmuxName)) ? 'running' : 'dead');
    }),
  );
  return out;
}
