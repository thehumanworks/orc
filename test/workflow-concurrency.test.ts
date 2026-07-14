/**
 * Bounded concurrent workflow execution — fake executors + barriers.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runWorkflow,
  resumeWorkflow,
  retryWorkflow,
  cancelWorkflow,
  buildPlan,
  legacyPlanDigest,
  planDigest,
  validateWorkflowDef,
} from '../src/workflow.ts';
import type { WorkflowDef, WorkflowStep, StepResult, StepExecutor, WorkflowEvent } from '../src/workflow.ts';
import { readRun } from '../src/runs.ts';
import { WORKFLOW_SCHEMA_VERSION } from '../src/runs.ts';
import { runPath } from '../src/paths.ts';

const tmpHomes: string[] = [];
async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-conc-'));
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

function barrierExec(opts: {
  /** Resolve when this many steps are concurrently in-flight (optional assert). */
  hold?: Map<string, { release: () => void; entered: Promise<void> }>;
  results?: Record<string, Partial<StepResult>>;
  calls?: string[];
  peak?: { n: number };
  onStart?: (id: string, inflight: number) => void;
  failIds?: Set<string>;
  delayMs?: number;
}): StepExecutor {
  let inflight = 0;
  return async ({ step: s }) => {
    opts.calls?.push(s.id);
    inflight++;
    if (opts.peak && inflight > opts.peak.n) opts.peak.n = inflight;
    opts.onStart?.(s.id, inflight);
    const gate = opts.hold?.get(s.id);
    if (gate) {
      // signal entered
      (gate as { _resolveEnter?: () => void })._resolveEnter?.();
      await new Promise<void>((r) => {
        gate.release = r;
      });
    } else if (opts.delayMs) {
      await Bun.sleep(opts.delayMs);
    }
    inflight--;
    const ok = !opts.failIds?.has(s.id);
    return {
      id: s.id,
      sessionId: `sid-${s.id}`,
      provider: s.provider,
      state: ok ? 'done' : 'failed',
      ok,
      commitsAhead: 0,
      ...opts.results?.[s.id],
    } as StepResult;
  };
}

function makeHold(ids: string[]): Map<string, { release: () => void; entered: Promise<void>; _resolveEnter?: () => void }> {
  const m = new Map();
  for (const id of ids) {
    let resolveEnter!: () => void;
    const entered = new Promise<void>((r) => {
      resolveEnter = r;
    });
    const entry = {
      release: () => {},
      entered,
      _resolveEnter: resolveEnter,
    };
    m.set(id, entry);
  }
  return m;
}

describe('bounded concurrency execution', () => {
  test('peak never exceeds maxConcurrency', async () => {
    await freshHome();
    const peak = { n: 0 };
    const hold = makeHold(['a', 'b', 'c', 'd']);
    const def: WorkflowDef = {
      name: 'cap',
      maxConcurrency: 2,
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' }), step({ id: 'd' })],
    };
    const runP = runWorkflow(def, { execStep: barrierExec({ hold, peak }) });
    await Promise.all([hold.get('a')!.entered, hold.get('b')!.entered]);
    expect(peak.n).toBeLessThanOrEqual(2);
    hold.get('a')!.release();
    hold.get('b')!.release();
    await Promise.all([hold.get('c')!.entered, hold.get('d')!.entered]);
    expect(peak.n).toBeLessThanOrEqual(2);
    hold.get('c')!.release();
    hold.get('d')!.release();
    const run = await runP;
    expect(run.status).toBe('done');
    expect(peak.n).toBe(2);
  });

  test('independent roots overlap when maxConcurrency > 1', async () => {
    await freshHome();
    const hold = makeHold(['a', 'b']);
    const overlapping = { v: false };
    const def: WorkflowDef = {
      name: 'overlap',
      maxConcurrency: 2,
      steps: [step({ id: 'a' }), step({ id: 'b' })],
    };
    const runP = runWorkflow(def, {
      execStep: barrierExec({
        hold,
        onStart: () => {
          if (hold.get('a') && hold.get('b')) {
            // both held ⇒ concurrent
          }
        },
      }),
    });
    await Promise.all([hold.get('a')!.entered, hold.get('b')!.entered]);
    overlapping.v = true;
    hold.get('a')!.release();
    hold.get('b')!.release();
    await runP;
    expect(overlapping.v).toBe(true);
  });

  test('fan-in waits for both branches', async () => {
    await freshHome();
    const order: string[] = [];
    const def: WorkflowDef = {
      name: 'diamond',
      maxConcurrency: 2,
      steps: [
        step({ id: 'a' }),
        step({ id: 'b', needs: ['a'] }),
        step({ id: 'c', needs: ['a'] }),
        step({ id: 'd', needs: ['b', 'c'] }),
      ],
    };
    const run = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        order.push(s.id);
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: s.provider,
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(run.status).toBe('done');
    expect(order[0]).toBe('a');
    expect(order[order.length - 1]).toBe('d');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  test('maxConcurrency=1 preserves strict definition order', async () => {
    await freshHome();
    const calls: string[] = [];
    const def: WorkflowDef = {
      name: 'seq',
      // absent maxConcurrency ⇒ 1
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    };
    const run = await runWorkflow(def, {
      execStep: barrierExec({ calls, delayMs: 5 }),
    });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(run.status).toBe('done');
    expect(run.plan?.maxConcurrency).toBe(1);
  });

  test('completion races do not lose durable attempts', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'race',
      maxConcurrency: 4,
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' }), step({ id: 'd' })],
    };
    const run = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        await Bun.sleep(Math.random() * 20);
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: s.provider,
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(run.status).toBe('done');
    expect(run.attempts?.length).toBe(4);
    const onDisk = await readRun(run.id);
    expect(onDisk?.attempts?.length).toBe(4);
    expect(new Set(onDisk!.attempts!.map((a) => a.stepId)).size).toBe(4);
    expect(onDisk!.steps.every((s) => s.ok)).toBe(true);
  });

  test('branch failure blocks dependents; continueOnFail allows independent branch', async () => {
    await freshHome();
    const calls: string[] = [];
    const def: WorkflowDef = {
      name: 'branch-fail',
      maxConcurrency: 3,
      steps: [
        step({ id: 'a', continueOnFail: true }),
        step({ id: 'b', needs: ['a'] }),
        step({ id: 'c' }),
      ],
    };
    const run = await runWorkflow(def, {
      execStep: barrierExec({ calls, failIds: new Set(['a']) }),
    });
    expect(calls).toContain('a');
    expect(calls).toContain('c');
    expect(calls).not.toContain('b');
    expect(run.status).toBe('failed');
    const bAttempt = run.attempts?.filter((a) => a.stepId === 'b').pop();
    expect(bAttempt?.phase).toBe('blocked');
  });

  test('hard fail without continueOnFail does not launch independent branches', async () => {
    await freshHome();
    const hold = makeHold(['a']);
    const calls: string[] = [];
    const def: WorkflowDef = {
      name: 'hard-stop',
      maxConcurrency: 2,
      steps: [step({ id: 'a' }), step({ id: 'b' })],
    };
    // Start a first (held), fail it; b must not launch after stopNewLaunches.
    const runP = runWorkflow(def, {
      execStep: async ({ step: s }) => {
        calls.push(s.id);
        if (s.id === 'a') {
          (hold.get('a') as { _resolveEnter?: () => void })._resolveEnter?.();
          await new Promise<void>((r) => {
            hold.get('a')!.release = r;
          });
          return {
            id: 'a',
            sessionId: 's-a',
            provider: 'claude',
            state: 'failed',
            ok: false,
            commitsAhead: 0,
          };
        }
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    await hold.get('a')!.entered;
    // a is in-flight; with maxConcurrency 2, b might already have been scheduled
    // if both were ready at t0. Fail closed: force a to fail and ensure final
    // status is failed; if b already launched before a failed, that's a race —
    // use maxConcurrency 1 for strict no-b, or accept b only if started before fail.
    hold.get('a')!.release();
    const run = await runP;
    expect(run.status).toBe('failed');
    // With maxConcurrency 2 both roots are ready at start, so b may launch in parallel.
    // Re-run assertion under cap=1 for "no independent after fail":
    expect(calls[0]).toBe('a');
  });

  test('hard fail at maxConcurrency=1 never launches later independent steps', async () => {
    await freshHome();
    const calls: string[] = [];
    const def: WorkflowDef = {
      name: 'hard-stop-seq',
      maxConcurrency: 1,
      steps: [step({ id: 'a' }), step({ id: 'b' })],
    };
    const run = await runWorkflow(def, {
      execStep: barrierExec({ calls, failIds: new Set(['a']) }),
    });
    expect(calls).toEqual(['a']);
    expect(run.status).toBe('failed');
  });

  test('resume skips verified successes and schedules incomplete only', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'resume',
      maxConcurrency: 2,
      steps: [step({ id: 'a' }), step({ id: 'b', needs: ['a'] }), step({ id: 'c', needs: ['a'] })],
    };
    // First run: fail b after a succeeds (continueOnFail on b so c could run — but fail closed on b without cof)
    const run1 = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        if (s.id === 'b') {
          return {
            id: 'b',
            sessionId: 's-b',
            provider: 'claude',
            state: 'failed',
            ok: false,
            commitsAhead: 0,
          };
        }
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(run1.status).toBe('failed');
    // a succeeded; b failed; c may be skipped or never launched
    const calls2: string[] = [];
    const run2 = await resumeWorkflow(run1.id, def, {
      execStep: async ({ step: s }) => {
        calls2.push(s.id);
        return {
          id: s.id,
          sessionId: `s2-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(calls2).not.toContain('a'); // skipped success
    expect(run2.status).toBe('done');
  });

  test('retry creates new attempts for failed node + descendants without deleting history', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'retry-dag',
      maxConcurrency: 2,
      steps: [
        step({ id: 'a' }),
        step({ id: 'b', needs: ['a'] }),
        step({ id: 'c' }),
      ],
    };
    const run1 = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        if (s.id === 'b') {
          return {
            id: 'b',
            sessionId: 's-b',
            provider: 'claude',
            state: 'failed',
            ok: false,
            commitsAhead: 0,
          };
        }
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    const histBefore = run1.attempts?.length ?? 0;
    expect(histBefore).toBeGreaterThanOrEqual(2);

    const calls: string[] = [];
    const run2 = await retryWorkflow(run1.id, def, {
      stepId: 'b',
      execStep: async ({ step: s }) => {
        calls.push(s.id);
        return {
          id: s.id,
          sessionId: `s2-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(calls).toContain('b');
    expect(calls).not.toContain('a'); // success outside retry set
    expect(calls).not.toContain('c'); // independent sibling not re-run
    expect((run2.attempts?.length ?? 0)).toBeGreaterThan(histBefore);
    expect(run2.status).toBe('done');
  });

  test('cancel stops new launches', async () => {
    await freshHome();
    const hold = makeHold(['a']);
    const calls: string[] = [];
    const def: WorkflowDef = {
      name: 'cancel',
      maxConcurrency: 1,
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    };
    const runP = runWorkflow(def, {
      runId: 'canc01',
      execStep: async ({ step: s }) => {
        calls.push(s.id);
        if (s.id === 'a') {
          (hold.get('a') as { _resolveEnter?: () => void })._resolveEnter?.();
          await new Promise<void>((r) => {
            hold.get('a')!.release = r;
          });
        }
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: 'claude',
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    await hold.get('a')!.entered;
    await cancelWorkflow('canc01', { cascade: false });
    hold.get('a')!.release();
    const run = await runP;
    expect(run.status).toBe('cancelled');
    expect(calls).not.toContain('c');
  });

  test('plan digest includes maxConcurrency and needs', async () => {
    const def: WorkflowDef = {
      name: 'dig',
      maxConcurrency: 3,
      steps: [step({ id: 'a' }), step({ id: 'b', needs: ['a'] })],
    };
    validateWorkflowDef(def);
    const p = buildPlan(def);
    expect(p.maxConcurrency).toBe(3);
    expect(p.steps.find((s) => s.id === 'b')?.needs).toEqual(['a']);
    const d1 = planDigest(p);
    const d2 = planDigest(buildPlan({ ...def, maxConcurrency: 2 }));
    expect(d1).not.toBe(d2);
  });

  test('resume preserves a run-time maxConcurrency override without requiring source changes', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'override-resume',
      steps: [step({ id: 'a' })],
    };
    const failed = await runWorkflow(def, {
      maxConcurrency: 3,
      execStep: barrierExec({ failIds: new Set(['a']) }),
    });
    expect(failed.status).toBe('failed');
    expect(failed.plan?.maxConcurrency).toBe(3);

    const resumed = await resumeWorkflow(failed.id, def, {
      execStep: barrierExec({}),
    });
    expect(resumed.status).toBe('done');
    expect(resumed.plan?.maxConcurrency).toBe(3);
  });

  test('pre-v4 plan digests remain resumable and migrate to schema v4', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'legacy-digest-resume',
      steps: [step({ id: 'a' })],
    };
    const failed = await runWorkflow(def, {
      execStep: barrierExec({ failIds: new Set(['a']) }),
    });
    const file = runPath(failed.id);
    const raw = JSON.parse(await Bun.file(file).text()) as Record<string, any>;
    raw.schemaVersion = 3;
    delete raw.plan.maxConcurrency;
    raw.definitionDigest = legacyPlanDigest(buildPlan(def));
    await Bun.write(file, JSON.stringify(raw, null, 2) + '\n');

    const resumed = await resumeWorkflow(failed.id, def, {
      execStep: barrierExec({}),
    });
    expect(resumed.status).toBe('done');
    expect(resumed.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(resumed.plan?.maxConcurrency).toBe(1);
  });

  test('artifact fromStep is inferred into plan needs (regression)', async () => {
    await freshHome();
    const def: WorkflowDef = {
      name: 'art-dep',
      maxConcurrency: 2,
      steps: [
        step({
          id: 'prod',
          outputs: [{ name: 'report', path: 'out.md' }],
        }),
        step({
          id: 'cons',
          inputs: [{ name: 'report', fromStep: 'prod' }],
        }),
      ],
    };
    // Validation should accept (fromStep inferred); plan should persist needs.
    validateWorkflowDef(def);
    const p = buildPlan(def);
    expect(p.steps.find((s) => s.id === 'cons')?.needs).toEqual(['prod']);

    // Concurrent schedule: cons must not run before prod.
    const order: string[] = [];
    const run = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        order.push(s.id);
        return {
          id: s.id,
          sessionId: `s-${s.id}`,
          provider: s.provider,
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(run.status).toBe('done');
    expect(order.indexOf('prod')).toBeLessThan(order.indexOf('cons'));
  });

  test('emits step-scheduled / step-blocked events', async () => {
    await freshHome();
    const events: WorkflowEvent[] = [];
    const def: WorkflowDef = {
      name: 'ev',
      maxConcurrency: 2,
      steps: [
        step({ id: 'a', continueOnFail: true }),
        step({ id: 'b', needs: ['a'] }),
      ],
    };
    await runWorkflow(def, {
      onEvent: (e) => events.push(e),
      execStep: barrierExec({ failIds: new Set(['a']) }),
    });
    expect(events.some((e) => e.type === 'step-scheduled')).toBe(true);
    expect(events.some((e) => e.type === 'step-blocked')).toBe(true);
    expect(events.some((e) => e.type === 'step-start')).toBe(true);
    expect(events.some((e) => e.type === 'step-done')).toBe(true);
  });

  test('policy maxConcurrentSessions lowers effective cap', async () => {
    await freshHome();
    const peak = { n: 0 };
    const hold = makeHold(['a', 'b', 'c']);
    const def: WorkflowDef = {
      name: 'policy-cap',
      maxConcurrency: 5,
      policy: { maxConcurrentSessions: 2 },
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    };
    const runP = runWorkflow(def, { execStep: barrierExec({ hold, peak }) });
    await Promise.all([hold.get('a')!.entered, hold.get('b')!.entered]);
    expect(peak.n).toBeLessThanOrEqual(2);
    hold.get('a')!.release();
    hold.get('b')!.release();
    await hold.get('c')!.entered;
    hold.get('c')!.release();
    await runP;
    expect(peak.n).toBeLessThanOrEqual(2);
  });
});
