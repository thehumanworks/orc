/**
 * D10 — adoption of in-flight attempts on resume. A run whose owner died leaves an
 * attempt in `running` with a session id; resume asks the kernel for the instruction's
 * delivery verdict and adopts (queued/acknowledged/completed), requires an explicit
 * retry (unknown) or relaunches (failed/absent/session gone).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adoptionDecision,
  buildPlan,
  createAttempt,
  instructionMessageId,
  planDigest,
  resumeWorkflow,
  retryWorkflow,
  transitionAttempt,
} from '../src/workflow.ts';
import type {
  AdoptionProbe,
  StepAdopter,
  StepExecutor,
  StepResult,
  WorkflowDef,
  WorkflowEvent,
} from '../src/workflow.ts';
import { readRun, writeRun, WORKFLOW_SCHEMA_VERSION } from '../src/runs.ts';
import type { DeliveryVerdict } from '../src/runtime/client.ts';
import { FAKE_PROVIDER_ENV, agent } from '../src/agent.ts';
import { killSessionProcesses, mkTmp } from './runtime-helpers.ts';

const prevHome = process.env.ORC_HOME;
const root = mkTmp('orc-adopt-');
let n = 0;
const sids: string[] = [];

beforeEach(() => {
  process.env.ORC_HOME = path.join(root, `home-${++n}`);
  fs.mkdirSync(process.env.ORC_HOME, { recursive: true });
});

afterAll(async () => {
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const def: WorkflowDef = {
  name: 'adopt',
  steps: [
    { id: 'a', provider: 'claude', prompt: 'do a', allowUnverified: true },
    { id: 'b', provider: 'claude', prompt: 'do b', allowUnverified: true, needs: ['a'] },
  ],
};

function ok(stepId: string, sessionId = `sid-${stepId}`): StepResult {
  return { id: stepId, sessionId, provider: 'claude', state: 'done', ok: true, outcome: 'succeeded', commitsAhead: 0 };
}

/** An orphaned run whose step `a` attempt is still `running` in session `sessionId`. */
async function orphanedRun(runId: string, sessionId = 'sess-a') {
  const plan = buildPlan(def);
  let a = createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 });
  a = transitionAttempt(a, 'spawning');
  a = transitionAttempt(a, 'dispatched', { sessionId });
  a = transitionAttempt(a, 'running', {
    sessionId,
    messageId: instructionMessageId(runId, 'a', a.attemptId),
    deliveryPhase: 'acknowledged',
  });
  await writeRun({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: 1,
    id: runId,
    name: def.name,
    startedAt: new Date().toISOString(),
    status: 'orphaned',
    steps: [],
    plan,
    definitionDigest: planDigest(plan),
    rootRunId: runId,
    attempts: [a],
  });
  return a;
}

function harness(verdict: DeliveryVerdict | undefined, sessionAlive: boolean | null = true) {
  const execCalls: string[] = [];
  const adoptCalls: string[] = [];
  const events: WorkflowEvent[] = [];
  const execStep: StepExecutor = async ({ step }) => {
    execCalls.push(step.id);
    return ok(step.id);
  };
  const adoptStep: StepAdopter = async ({ step, attempt }) => {
    adoptCalls.push(`${step.id}:${attempt.attemptId}`);
    return ok(step.id, attempt.sessionId);
  };
  const probeAdoption: AdoptionProbe = async () => ({ sessionAlive, ...(verdict ? { verdict } : {}) });
  return { execCalls, adoptCalls, events, opts: { execStep, adoptStep, probeAdoption, onEvent: (e: WorkflowEvent) => events.push(e) } };
}

describe('resume adopts in-flight attempts (D10)', () => {
  for (const verdict of ['acknowledged', 'queued', 'completed'] as const) {
    test(`verdict ${verdict} → adopt (no relaunch)`, async () => {
      const a = await orphanedRun(`adopt-${verdict}`);
      const h = harness(verdict);
      const run = await resumeWorkflow(`adopt-${verdict}`, def, h.opts);
      expect(run.status).toBe('done');
      expect(h.adoptCalls).toEqual([`a:${a.attemptId}`]);
      expect(h.execCalls).toEqual(['b']);
      expect(h.events.some((e) => e.type === 'attempt-adopt' && e.stepId === 'a' && e.sessionId === 'sess-a')).toBe(true);
      const aAttempts = run.attempts!.filter((x) => x.stepId === 'a');
      expect(aAttempts).toHaveLength(1);
      expect(aAttempts[0]!.phase).toBe('succeeded');
    });
  }

  test('verdict unknown → failed (delivery_unknown), not relaunched; retry relaunches', async () => {
    await orphanedRun('adopt-unknown');
    const h = harness('unknown');
    const run = await resumeWorkflow('adopt-unknown', def, h.opts);
    expect(run.status).toBe('failed');
    expect(h.adoptCalls).toEqual([]);
    expect(h.execCalls).toEqual([]);
    const a = run.attempts!.find((x) => x.stepId === 'a')!;
    expect(a).toMatchObject({ phase: 'failed', errorCategory: 'delivery_unknown', deliveryPhase: 'unknown' });

    // A second resume still does not re-send it.
    const again = await resumeWorkflow('adopt-unknown', def, harness('unknown').opts);
    expect(again.attempts!.filter((x) => x.stepId === 'a')).toHaveLength(1);

    const r = harness(undefined);
    const retried = await retryWorkflow('adopt-unknown', def, r.opts);
    expect(retried.status).toBe('done');
    expect(r.execCalls).toEqual(['a', 'b']);
  });

  for (const verdict of ['failed', 'absent', 'interrupted'] as const) {
    test(`verdict ${verdict} → abandoned and relaunched`, async () => {
      await orphanedRun(`adopt-${verdict}`);
      const h = harness(verdict);
      const run = await resumeWorkflow(`adopt-${verdict}`, def, h.opts);
      expect(run.status).toBe('done');
      expect(h.adoptCalls).toEqual([]);
      expect(h.execCalls).toEqual(['a', 'b']);
      const phases = run.attempts!.filter((x) => x.stepId === 'a').map((x) => x.phase);
      expect(phases).toEqual(['abandoned', 'succeeded']);
    });
  }

  test('session gone or stopped → abandoned and relaunched', async () => {
    await orphanedRun('adopt-gone');
    const h = harness(undefined, false);
    const run = await resumeWorkflow('adopt-gone', def, h.opts);
    expect(run.status).toBe('done');
    expect(h.execCalls).toEqual(['a', 'b']);
  });

  test('allowUnknownDeliveryRetry relaunches an unknown delivery on resume', async () => {
    await orphanedRun('adopt-allow');
    const h = harness('unknown');
    const run = await resumeWorkflow('adopt-allow', def, { ...h.opts, allowUnknownDeliveryRetry: true });
    expect(run.status).toBe('done');
    expect(h.execCalls).toEqual(['a', 'b']);
  });
});

describe('adoptionDecision with kernel verdicts', () => {
  const running = transitionAttempt(createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }), 'running', {
    sessionId: 'sid',
  });
  test('maps verdicts', () => {
    const d = (verdict: DeliveryVerdict) => adoptionDecision({ attempt: running, sessionAlive: true, verdict });
    expect(d('queued')).toBe('adopt');
    expect(d('acknowledged')).toBe('adopt');
    expect(d('completed')).toBe('adopt');
    expect(d('unknown')).toBe('require_retry');
    expect(d('failed')).toBe('spawn_new');
    expect(d('absent')).toBe('spawn_new');
    expect(d('interrupted')).toBe('spawn_new');
    expect(adoptionDecision({ attempt: running, sessionAlive: true, verdict: 'unknown', allowUnknownDeliveryRetry: true })).toBe(
      'spawn_new',
    );
    expect(adoptionDecision({ attempt: running, sessionAlive: false, verdict: 'acknowledged' })).toBe('spawn_new');
    const noSession = transitionAttempt(createAttempt({ stepId: 'a', provider: 'claude', attemptNumber: 1 }), 'spawning');
    expect(adoptionDecision({ attempt: noSession, sessionAlive: true })).toBe('spawn_new');
  });
});

describe('default adopter + kernel probe (real actor, fake provider)', () => {
  test('a run orphaned mid-step is adopted and finishes on the same session', async () => {
    const prevFake = process.env[FAKE_PROVIDER_ENV];
    process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ default: { delayMs: 800 } });
    try {
      const cwd = mkTmp('orc-adopt-cwd-');
      const s = await agent({ provider: 'claude', cwd, rootRunId: 'adopt-real' });
      sids.push(s.sessionId);
      const a = await orphanedRun('adopt-real', s.id);
      // The dead runner had delivered the instruction before dying.
      const sent = await s.send('do a', { messageId: instructionMessageId('adopt-real', 'a', a.attemptId) });
      expect(sent.phase).toBe('acknowledged');

      const execCalls: string[] = [];
      const events: WorkflowEvent[] = [];
      const run = await resumeWorkflow('adopt-real', def, {
        onEvent: (e) => events.push(e),
        execStep: async ({ step }) => {
          execCalls.push(step.id);
          return ok(step.id);
        },
      });
      expect(run.status).toBe('done');
      expect(execCalls).toEqual(['b']);
      expect(events.some((e) => e.type === 'attempt-adopt')).toBe(true);
      const adopted = run.attempts!.find((x) => x.stepId === 'a')!;
      expect(adopted.phase).toBe('succeeded');
      expect(adopted.sessionId).toBe(s.id);
      // One instruction turn only: adoption never re-sends.
      expect(s.journal().filter((e) => e.type === 'turn.intent')).toHaveLength(1);
      const disk = await readRun('adopt-real');
      expect(disk!.steps.find((x) => x.id === 'a')!.sessionId).toBe(s.id);
      await s.kill();
    } finally {
      if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
      else process.env[FAKE_PROVIDER_ENV] = prevFake;
    }
  }, 45_000);

  test('a suspended session (actor crashed mid-turn) is woken by the adopter, never re-sent', async () => {
    const prevFake = process.env[FAKE_PROVIDER_ENV];
    process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ default: { delayMs: 5_000 } });
    try {
      const cwd = mkTmp('orc-adopt-cwd-');
      const s = await agent({ provider: 'claude', cwd, rootRunId: 'adopt-susp' });
      sids.push(s.sessionId);
      const a = await orphanedRun('adopt-susp', s.id);
      await s.send('do a', { messageId: instructionMessageId('adopt-susp', 'a', a.attemptId) });
      const { readActorState, leaseLive } = await import('../src/runtime/actor-state.ts');
      process.kill(readActorState(s.sessionId)!.lease!.pid, 'SIGKILL');
      const { waitFor } = await import('./runtime-helpers.ts');
      await waitFor(() => !leaseLive(readActorState(s.sessionId)), 'actor to die');
      expect(await s.status()).toBe('suspended');

      const run = await resumeWorkflow('adopt-susp', def, {
        execStep: async ({ step }) => ok(step.id),
      });
      expect(run.status).toBe('done');
      expect(await s.status()).toBe('running');
      expect(run.attempts!.filter((x) => x.stepId === 'a').map((x) => x.phase)).toEqual(['succeeded']);
      // The cut turn was recovered, not re-delivered.
      expect(s.journal().filter((e) => e.type === 'turn.intent')).toHaveLength(1);
      expect(s.journal().some((e) => e.type === 'turn.interrupted' && e.reason === 'recovered')).toBe(true);
      await s.kill();
    } finally {
      if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
      else process.env[FAKE_PROVIDER_ENV] = prevFake;
    }
  }, 45_000);
});
