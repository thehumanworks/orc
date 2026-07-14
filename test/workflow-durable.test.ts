/**
 * Phase-2 durable execution tree: attempts, CAS, leases, resume/retry/cancel,
 * adoption, lineage, and policy bounds. Uses fake step executors + throwaway ORC_HOME.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runWorkflow,
  resumeWorkflow,
  retryWorkflow,
  cancelWorkflow,
  cleanupWorkflow,
  createAttempt,
  transitionAttempt,
  adoptionDecision,
  buildPlan,
  planDigest,
  TERMINAL_ATTEMPT_PHASES,
  reconcileRunStatus,
} from '../src/workflow.ts';
import type { WorkflowDef, WorkflowStep, StepResult, StepExecutor } from '../src/workflow.ts';
import {
  readRun,
  writeRunCAS,
  writeRun,
  updateRun,
  makeLease,
  isLeaseLive,
  classifyOwnerLiveness,
  isFinalStatus,
  CasConflictError,
  projectStepsFromAttempts,
  normalizeRun,
  WORKFLOW_SCHEMA_VERSION,
} from '../src/runs.ts';
import { resolveLineage, lineageEnvVars, applyInheritedContext } from '../src/lineage.ts';
import { assertPolicyAllowsSpawn, PolicyViolationError } from '../src/policy.ts';
import { ORC_ENV } from '../src/types.ts';
import { matchRoute } from '../src/daemon/routes.ts';
import { HELP_TEXT } from '../src/cli/output.ts';
import { resolveCommand } from '../src/cli/index.ts';

const tmpHomes: string[] = [];
async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-dur-'));
  tmpHomes.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
  return process.env.ORC_HOME;
}
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fs.rm(d, { recursive: true, force: true });
});

function step(over: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { provider: 'claude', prompt: 'x', ...over };
}

function fakeExec(
  results: Record<string, Partial<StepResult>>,
  calls: { id: string }[],
): StepExecutor {
  return async ({ step: s }) => {
    calls.push({ id: s.id });
    return {
      id: s.id,
      sessionId: `sid-${s.id}`,
      provider: s.provider,
      state: 'done',
      ok: true,
      commitsAhead: 0,
      ...results[s.id],
    } as StepResult;
  };
}

// ── Attempt transitions (pure) ──────────────────────────────────────────────

describe('attempt phase transitions', () => {
  test('createAttempt starts queued with stable ids', () => {
    const a = createAttempt({ stepId: 's1', provider: 'claude', attemptNumber: 1 });
    expect(a.phase).toBe('queued');
    expect(a.attemptNumber).toBe(1);
    expect(a.attemptId.length).toBeGreaterThan(0);
    expect(a.startedAt).toBeTruthy();
    expect(a.createdAt).toBeTruthy();
  });

  test('transition boundary table: queued→spawning→dispatched→running→verifying→succeeded', () => {
    let a = createAttempt({ stepId: 's', provider: 'pi', attemptNumber: 1 });
    a = transitionAttempt(a, 'spawning');
    expect(a.phase).toBe('spawning');
    a = transitionAttempt(a, 'dispatched', { sessionId: 'abc' });
    expect(a.sessionId).toBe('abc');
    a = transitionAttempt(a, 'running');
    a = transitionAttempt(a, 'verifying');
    a = transitionAttempt(a, 'succeeded', {
      result: {
        id: 's',
        sessionId: 'abc',
        provider: 'pi',
        state: 'done',
        ok: true,
        commitsAhead: 0,
      },
    });
    expect(a.phase).toBe('succeeded');
    expect(a.finishedAt).toBeTruthy();
    expect(TERMINAL_ATTEMPT_PHASES.has(a.phase)).toBe(true);
  });

  test('spawn-success/send-failure retains session id (ownership)', () => {
    let a = createAttempt({ stepId: 's', provider: 'claude', attemptNumber: 1 });
    a = transitionAttempt(a, 'spawning');
    a = transitionAttempt(a, 'dispatched', { sessionId: 'live-sess' });
    a = transitionAttempt(a, 'failed', {
      sessionId: 'live-sess',
      errorCategory: 'send',
      errorMessage: 'delivery failed after spawn',
      deliveryPhase: 'failed',
    });
    expect(a.sessionId).toBe('live-sess');
    expect(a.phase).toBe('failed');
  });

  test('SendResult.phase maps onto attempt.deliveryPhase (not delivery.deliveryPhase)', () => {
    // Mirrors defaultExecStep: SendResult uses `phase`, attempt stores `deliveryPhase`.
    const sendResult = {
      phase: 'unknown' as const,
      attempts: 1,
      messageId: 'msg-1',
    };
    let a = createAttempt({ stepId: 's', provider: 'claude', attemptNumber: 1 });
    a = transitionAttempt(a, 'dispatched', { sessionId: 'sid' });
    a = transitionAttempt(a, 'running', {
      sessionId: 'sid',
      messageId: sendResult.messageId,
      deliveryPhase: sendResult.phase, // correct mapping from SendResult.phase
    });
    expect(a.deliveryPhase).toBe('unknown');
    expect(a.messageId).toBe('msg-1');
    // adoption must refuse duplicate when delivery is unknown
    expect(adoptionDecision({ attempt: a, sessionAlive: true })).toBe('require_retry');
  });
});

// ── CAS / leases / normalize ────────────────────────────────────────────────

describe('revision-safe persistence and leases', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('CAS write bumps revision; stale writer conflicts', async () => {
    const run = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 0,
      id: 'cas1',
      name: 't',
      startedAt: new Date().toISOString(),
      status: 'running' as const,
      steps: [],
      attempts: [],
    };
    const first = await writeRunCAS(run, 0);
    expect(first.revision).toBe(1);
    await expect(writeRunCAS({ ...first, name: 'stale' }, 0)).rejects.toBeInstanceOf(
      CasConflictError,
    );
    const second = await writeRunCAS({ ...first, name: 'ok' }, 1);
    expect(second.revision).toBe(2);
    expect(second.name).toBe('ok');
  });

  test('never downgrade finalized status', async () => {
    const done = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      id: 'fin1',
      name: 't',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'done' as const,
      steps: [],
    };
    await writeRun(done);
    expect(isFinalStatus('done')).toBe(true);
    // updateRun mutator form refuses downgrade (returns current).
    const after = await updateRun('fin1', (cur) =>
      cur ? { ...cur, status: 'running' } : null,
    );
    expect(after?.status).toBe('done');
  });

  test('legacy run JSON without new fields normalizes safely', () => {
    const legacy = {
      id: 'leg1',
      name: 'old',
      startedAt: '2020-01-01T00:00:00.000Z',
      status: 'done',
      steps: [
        {
          id: 'a',
          sessionId: 's',
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        },
      ],
    };
    const n = normalizeRun(legacy);
    expect(n).not.toBeNull();
    expect(n!.schemaVersion).toBe(1);
    expect(n!.revision).toBe(0);
    expect(n!.steps).toHaveLength(1);
    expect(n!.attempts).toBeUndefined();
  });

  test('lease liveness: live / expired / finalized', () => {
    const now = Date.now();
    const live = makeLease({ nowMs: now, leaseMs: 60_000 });
    const expired = makeLease({ nowMs: now - 120_000, leaseMs: 1_000 });
    expect(isLeaseLive(live, { nowMs: now, checkPid: false })).toBe(true);
    expect(isLeaseLive(expired, { nowMs: now, checkPid: false })).toBe(false);
    expect(
      classifyOwnerLiveness({ status: 'done', lease: live }, { nowMs: now, checkPid: false }),
    ).toBe('finalized');
    expect(
      classifyOwnerLiveness(
        { status: 'running', lease: live },
        { nowMs: now, checkPid: false, runnerAlive: true },
      ),
    ).toBe('live');
    expect(
      classifyOwnerLiveness(
        { status: 'running', lease: expired },
        { nowMs: now, checkPid: false },
      ),
    ).toBe('expired');
  });

  test('expired foreground lease reconciles to orphaned', () => {
    expect(reconcileRunStatus('running', null, { leaseLive: false })).toBe('orphaned');
    expect(reconcileRunStatus('running', true, { leaseLive: true })).toBe('running');
    expect(reconcileRunStatus('done', false, { leaseLive: false })).toBe('done');
  });

  test('projectStepsFromAttempts builds compatibility projection', () => {
    const attempts = [
      transitionAttempt(
        createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
        'succeeded',
        {
          sessionId: 's1',
          result: {
            id: 'a',
            sessionId: 's1',
            provider: 'claude',
            state: 'done',
            ok: true,
            commitsAhead: 0,
          },
        },
      ),
    ];
    const steps = projectStepsFromAttempts(attempts);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.ok).toBe(true);
  });
});

// ── runWorkflow durable plan + resume/retry/cancel ──────────────────────────

describe('durable runWorkflow transitions', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('persists plan + attempts before completion; steps projection works', async () => {
    const def: WorkflowDef = { name: 'plan', steps: [step({ id: 'a' }), step({ id: 'b' })] };
    const calls: { id: string }[] = [];
    const run = await runWorkflow(def, { execStep: fakeExec({}, calls), runId: 'planrun1' });
    const onDisk = await readRun('planrun1');
    expect(onDisk!.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(onDisk!.plan?.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(onDisk!.definitionDigest).toBe(planDigest(buildPlan(def)));
    expect(onDisk!.attempts!.length).toBeGreaterThanOrEqual(2);
    expect(onDisk!.steps.every((s) => s.ok)).toBe(true);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('failure mid-run keeps prior successful attempt history', async () => {
    const def: WorkflowDef = {
      name: 'fail',
      steps: [step({ id: 'ok' }), step({ id: 'bad' }), step({ id: 'never' })],
    };
    const run = await runWorkflow(def, {
      runId: 'fail1',
      execStep: fakeExec(
        {
          bad: { ok: false, state: 'failed' },
        },
        [],
      ),
    });
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.id === 'ok')?.ok).toBe(true);
    // Phase 5: unstarted steps after a hard fail are durably skipped (never launched).
    const neverPhase = run.attempts?.filter((a) => a.stepId === 'never').pop()?.phase;
    expect(neverPhase === 'skipped' || neverPhase === undefined).toBe(true);
    expect(run.attempts!.some((a) => a.stepId === 'ok' && a.phase === 'succeeded')).toBe(true);
  });

  test('resume skips successful steps and re-runs incomplete', async () => {
    const def: WorkflowDef = {
      name: 'res',
      steps: [step({ id: 'a' }), step({ id: 'b' })],
    };
    await runWorkflow(def, {
      runId: 'res1',
      execStep: fakeExec({ b: { ok: false, state: 'failed' } }, []),
    });
    const calls: { id: string }[] = [];
    const resumed = await resumeWorkflow('res1', def, {
      execStep: fakeExec({}, calls),
    });
    expect(resumed.status).toBe('done');
    // Only b should re-execute.
    expect(calls.map((c) => c.id)).toEqual(['b']);
    const onDisk = await readRun('res1');
    const bAttempts = (onDisk!.attempts ?? []).filter((a) => a.stepId === 'b');
    expect(bAttempts.length).toBeGreaterThanOrEqual(2);
  });

  test('retry creates new attempt history for failed step', async () => {
    const def: WorkflowDef = { name: 'rt', steps: [step({ id: 'x' })] };
    await runWorkflow(def, {
      runId: 'rt1',
      execStep: fakeExec({ x: { ok: false, state: 'failed' } }, []),
    });
    const before = await readRun('rt1');
    const nBefore = (before!.attempts ?? []).length;
    const retried = await retryWorkflow('rt1', def, {
      execStep: fakeExec({}, []),
    });
    expect(retried.status).toBe('done');
    const after = await readRun('rt1');
    expect((after!.attempts ?? []).length).toBeGreaterThan(nBefore);
  });

  test('idempotent cancel marks run cancelled twice safely', async () => {
    const def: WorkflowDef = { name: 'c', steps: [step({ id: 'a' })] };
    // Start a run that "hangs" by never being finalized — simulate running record.
    await runWorkflow(def, {
      runId: 'can1',
      execStep: fakeExec({ a: { ok: false, state: 'failed' } }, []),
    });
    // Force running status for cancel path (failed is final and cancel no-ops).
    await updateRun('can1', (cur) => (cur ? { ...cur, status: 'orphaned' } : null));
    // Orphaned is final — cancel should leave it or re-mark. Use a fresh running run.
    await writeRun({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      id: 'can2',
      name: 'c2',
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: [],
      attempts: [
        createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
      ].map((a) => transitionAttempt(a, 'running', { sessionId: 's' })),
    });
    const c1 = await cancelWorkflow('can2');
    expect(c1.status).toBe('cancelled');
    const c2 = await cancelWorkflow('can2');
    expect(c2.status).toBe('cancelled');
    expect(c2.attempts!.every((a) => a.phase === 'cancelled' || TERMINAL_ATTEMPT_PHASES.has(a.phase))).toBe(
      true,
    );
  });

  test('cleanup without flags errors; with sessions only touches owned', async () => {
    await writeRun({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      id: 'cl1',
      name: 'cl',
      startedAt: new Date().toISOString(),
      status: 'cancelled',
      steps: [],
      rootRunId: 'cl1',
    });
    await expect(cleanupWorkflow('cl1', {})).rejects.toThrow(/--sessions|--worktrees|at least one/);
    const result = await cleanupWorkflow('cl1', {
      sessions: true,
      killSession: async () => {},
    });
    expect(result.runId).toBe('cl1');
    expect(result.sessions).toEqual([]);
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────

describe('adoptionDecision', () => {
  test('unknown delivery requires explicit retry policy', () => {
    const attempt = transitionAttempt(
      createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
      'running',
      { sessionId: 'sid', deliveryPhase: 'unknown' },
    );
    expect(adoptionDecision({ attempt, sessionAlive: true })).toBe('require_retry');
  });

  test('live session after spawn → adopt', () => {
    const attempt = transitionAttempt(
      createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
      'running',
      { sessionId: 'sid', deliveryPhase: 'acknowledged' },
    );
    expect(adoptionDecision({ attempt, sessionAlive: true })).toBe('adopt');
  });

  test('dead session → spawn_new', () => {
    const attempt = transitionAttempt(
      createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
      'running',
      { sessionId: 'sid' },
    );
    expect(adoptionDecision({ attempt, sessionAlive: false })).toBe('spawn_new');
  });

  test('succeeded → skip', () => {
    const attempt = transitionAttempt(
      createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }),
      'succeeded',
      { sessionId: 'sid' },
    );
    expect(adoptionDecision({ attempt, sessionAlive: true })).toBe('skip_succeeded');
  });

  test('spawn-success/send-failure attempt retains sessionId via transitionAttempt', () => {
    // Pure helper equivalent of mid-flight ownership retention (spawn then send fails).
    let a = createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 });
    a = transitionAttempt(a, 'spawning');
    a = transitionAttempt(a, 'dispatched', { sessionId: 'live-sid' });
    a = transitionAttempt(a, 'failed', {
      sessionId: 'live-sid',
      errorCategory: 'send',
      errorMessage: 'send failed after spawn',
    });
    expect(a.sessionId).toBe('live-sid');
    expect(a.phase).toBe('failed');
  });
});

// ── Lineage + policy ────────────────────────────────────────────────────────

describe('lineage inheritance', () => {
  test('resolveLineage: explicit overrides env', () => {
    const env = {
      [ORC_ENV.ROOT_RUN_ID]: 'env-root',
      [ORC_ENV.DEPTH]: '2',
    } as NodeJS.ProcessEnv;
    const r = resolveLineage({ rootRunId: 'explicit', depth: 1 }, env);
    expect(r.rootRunId).toBe('explicit');
    expect(r.depth).toBe(1);
  });

  test('lineageEnvVars emits ORC_* keys', () => {
    const env = lineageEnvVars({
      rootRunId: 'r',
      parentRunId: 'p',
      depth: 1,
      policy: { maxDepth: 3, canDelegate: true },
    });
    expect(env[ORC_ENV.ROOT_RUN_ID]).toBe('r');
    expect(env[ORC_ENV.POLICY_MAX_DEPTH]).toBe('3');
  });

  test('applyInheritedContext fills gaps from env', () => {
    const env = { [ORC_ENV.OWNER]: 'alice' } as NodeJS.ProcessEnv;
    const m = applyInheritedContext({ provider: 'claude' }, env);
    expect(m.owner).toBe('alice');
    expect(m.provider).toBe('claude');
  });
});

describe('execution policy bounds', () => {
  test('maxDepth fail closed', () => {
    expect(() =>
      assertPolicyAllowsSpawn({ depth: 2, policy: { maxDepth: 1 } }),
    ).toThrow(PolicyViolationError);
  });

  test('maxSessions fail closed', () => {
    const rootSessions = Array.from({ length: 2 }, (_, i) => ({
      id: String(i),
      sessionId: String(i),
      provider: 'claude' as const,
      tmuxName: `t${i}`,
      cwd: '/',
      workspace: '/',
      createdAt: new Date().toISOString(),
      rootRunId: 'root',
    }));
    expect(() =>
      assertPolicyAllowsSpawn({
        depth: 0,
        policy: { maxSessions: 2 },
        rootSessions,
        totalAfterSpawn: 3,
      }),
    ).toThrow(/maxSessions/);
  });

  test('canDelegate=false blocks nested depth', () => {
    expect(() =>
      assertPolicyAllowsSpawn({
        depth: 1,
        policy: { canDelegate: false },
        isDelegation: true,
      }),
    ).toThrow(/canDelegate/);
  });
});

// ── CLI / daemon mapping ────────────────────────────────────────────────────

describe('CLI/daemon phase-2 surface', () => {
  test('help documents resume/retry/cancel/cleanup and list --run', () => {
    expect(HELP_TEXT).toContain('workflow resume');
    expect(HELP_TEXT).toContain('workflow retry');
    expect(HELP_TEXT).toContain('workflow cancel');
    expect(HELP_TEXT).toContain('workflow cleanup');
    expect(HELP_TEXT).toContain('--run');
  });

  test('resolveCommand maps workflow alias', () => {
    expect(resolveCommand('wf')).toBe('workflow');
    expect(resolveCommand('workflow')).toBe('workflow');
  });

  test('daemon routes for resume/retry/cancel/cleanup', () => {
    expect(matchRoute('POST', '/workflows/runs/abc/resume')?.name).toBe('workflows.runs.resume');
    expect(matchRoute('POST', '/workflows/runs/abc/retry')?.name).toBe('workflows.runs.retry');
    expect(matchRoute('POST', '/workflows/runs/abc/cancel')?.name).toBe('workflows.runs.cancel');
    expect(matchRoute('POST', '/workflows/runs/abc/cleanup')?.name).toBe('workflows.runs.cleanup');
    // Specific routes must not be swallowed by GET :id
    expect(matchRoute('GET', '/workflows/runs/abc')?.name).toBe('workflows.runs.get');
  });
});
