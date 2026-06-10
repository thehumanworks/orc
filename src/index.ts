/**
 * orc SDK public entry.
 */
import fs from 'node:fs/promises';
import { getDriver } from './drivers/driver.ts';
import { readRegistry, findRecord, updateRegistry } from './registry.ts';
import type { Driver } from './drivers/driver.ts';
import { gitToplevel, removeWorktree } from './worktree.ts';
import { resolveWorkspace } from './agent.ts';
import { Session } from './session.ts';
import type { SessionRecord } from './types.ts';

export { agent, validateOptions } from './agent.ts';
export { Session } from './session.ts';
export type { WaitForOptions } from './session.ts';
export { classifyState, reduceWait, isSettled } from './state.ts';
export type { StateMatchers, WaitTracking } from './state.ts';
export { conversationTurns, parseTranscript, renderTurns, selectTurns } from './transcript.ts';
export type { Turn, TurnRole, TurnSelection } from './transcript.ts';
export {
  defineWorkflow,
  runWorkflow,
  validateWorkflowDef,
  interpolate,
  evaluateStep,
  runnerTmuxName,
  reconcileRunStatus,
  reconcileRun,
  assembleStepLogs,
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
} from './workflow.ts';
export { writeRun, readRun, listRuns } from './runs.ts';
export type {
  Provider,
  AgentOptions,
  AgentState,
  SessionRecord,
  SessionStatus,
  SystemPromptMode,
  PaneInfo,
} from './types.ts';

/** Resolve the default workspace key for filtering (git toplevel of cwd, else realpath cwd). */
async function defaultWorkspace(): Promise<string> {
  const cwd = await fs.realpath(process.cwd());
  return (await gitToplevel(cwd)) ?? cwd;
}

/**
 * List sessions. Default filter = the workspace of process.cwd(); `all` returns every
 * workspace. Records explicitly marked dead (killed) are HIDDEN by default and shown
 * only with `all` or `dead` (BUG 3) — dead records are retained so transcript reads
 * still resolve after kill.
 */
export async function listSessions(filter?: {
  workspace?: string;
  all?: boolean;
  dead?: boolean;
}): Promise<Session[]> {
  const records = await readRegistry();
  let selected: SessionRecord[] = records;
  if (!filter?.all) {
    // Normalize an explicit workspace filter the SAME way agent() normalizes the stored
    // workspace (realpath an existing path; keep a logical string verbatim) so a caller
    // passing e.g. /tmp/x (→ /private/tmp/x) still matches. Implicit = workspace of cwd.
    const ws =
      filter?.workspace !== undefined
        ? await resolveWorkspace(filter.workspace, process.cwd())
        : await defaultWorkspace();
    selected = records.filter((r) => r.workspace === ws);
  }
  // Hide killed (status==='dead') records unless explicitly requested.
  if (!filter?.all && !filter?.dead) {
    selected = selected.filter((r) => r.status !== 'dead');
  }
  return selected.map((r) => new Session(r));
}

/**
 * Prune dead records from the registry. Returns the ids removed. With
 * `removeWorktree`, also removes each pruned record's git worktree.
 */
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
        // A liveness backend error is not proof that the session is gone.
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
  if (opts?.removeWorktree) {
    for (const r of dead) {
      if (r.worktreePath) {
        await removeWorktree(r.workspace, r.worktreePath).catch(() => {});
      }
    }
  }
  return dead.map((r) => r.id);
}

/** Get a single session by short id, full sessionId, or tmux name. */
export async function getSession(idOrName: string): Promise<Session | null> {
  const rec = await findRecord(idOrName);
  return rec ? new Session(rec) : null;
}

/** Reconcile + return live status for a list of sessions. */
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
