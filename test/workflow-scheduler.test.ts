/**
 * Pure DAG/scheduler tests — no I/O, no agent spawns.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateStepGraph,
  buildNormalizedGraph,
  deriveSchedulerState,
  effectiveConcurrency,
  effectiveNeedsOf,
  normalizeMaxConcurrency,
  pickReady,
  retryClosure,
  GraphValidationError,
} from '../src/workflow-scheduler.ts';
import type { PlanStep, StepAttempt, StepResult, WorkflowPlan } from '../src/run-schema.ts';

function plan(steps: PlanStep[], maxConcurrency = 1): WorkflowPlan {
  return { name: 't', maxConcurrency, steps };
}

function att(
  stepId: string,
  phase: StepAttempt['phase'],
  n = 1,
  extra: Partial<StepAttempt> = {},
): StepAttempt {
  const now = new Date().toISOString();
  return {
    attemptId: `${stepId}-${n}`,
    attemptNumber: n,
    stepId,
    provider: 'claude',
    phase,
    startedAt: now,
    updatedAt: now,
    createdAt: now,
    ...extra,
  };
}

function ok(id: string): StepResult {
  return {
    id,
    sessionId: `s-${id}`,
    provider: 'claude',
    state: 'done',
    ok: true,
    commitsAhead: 0,
  };
}

function fail(id: string): StepResult {
  return {
    id,
    sessionId: `s-${id}`,
    provider: 'claude',
    state: 'failed',
    ok: false,
    commitsAhead: 0,
  };
}

describe('normalizeMaxConcurrency / effectiveConcurrency', () => {
  test('default 1 when absent', () => {
    expect(normalizeMaxConcurrency(undefined)).toBe(1);
    expect(effectiveConcurrency(undefined)).toBe(1);
  });
  test('rejects non-positive', () => {
    expect(() => normalizeMaxConcurrency(0)).toThrow(GraphValidationError);
    expect(() => normalizeMaxConcurrency(-1)).toThrow(/positive integer/);
    expect(() => normalizeMaxConcurrency(1.5)).toThrow(/positive integer/);
  });
  test('min with policy maxConcurrentSessions', () => {
    expect(effectiveConcurrency(4, { maxConcurrentSessions: 2 })).toBe(2);
    expect(effectiveConcurrency(1, { maxConcurrentSessions: 8 })).toBe(1);
  });
});

describe('validateStepGraph', () => {
  test('accepts empty needs and diamond', () => {
    expect(() =>
      validateStepGraph([
        { id: 'a' },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['a'] },
        { id: 'd', needs: ['b', 'c'] },
      ]),
    ).not.toThrow();
  });

  test('rejects missing dependency id', () => {
    expect(() => validateStepGraph([{ id: 'a', needs: ['nope'] }], { workflowName: 'w' })).toThrow(
      /unknown step id 'nope'/,
    );
  });

  test('rejects self-dependency', () => {
    expect(() => validateStepGraph([{ id: 'a', needs: ['a'] }])).toThrow(/self-dependency/);
  });

  test('rejects duplicate needs entries', () => {
    expect(() =>
      validateStepGraph([
        { id: 'a' },
        { id: 'b', needs: ['a', 'a'] },
      ]),
    ).toThrow(/duplicate needs entry 'a'/);
  });

  test('rejects cycles with cycle path', () => {
    expect(() =>
      validateStepGraph([
        { id: 'a', needs: ['c'] },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['b'] },
      ]),
    ).toThrow(/cycle detected/);
  });

  test('artifact fromStep must exist and is inferred into needs', () => {
    expect(() =>
      validateStepGraph([
        { id: 'a' },
        {
          id: 'b',
          inputs: [{ name: 'x', fromStep: 'missing' }],
        },
      ]),
    ).toThrow(/fromStep 'missing'/);

    expect(() =>
      validateStepGraph([
        {
          id: 'a',
          inputs: [{ name: 'x', fromStep: 'a' }],
        },
      ]),
    ).toThrow(/cannot reference self/);

    const eff = effectiveNeedsOf({
      id: 'b',
      needs: ['a'],
      inputs: [{ name: 'art', fromStep: 'c' }],
    });
    expect(eff).toEqual(['a', 'c']);
  });

  test('artifact-only edge participates in cycle detection', () => {
    expect(() =>
      validateStepGraph([
        { id: 'a', inputs: [{ name: 'x', fromStep: 'b' }] },
        { id: 'b', inputs: [{ name: 'y', fromStep: 'a' }] },
      ]),
    ).toThrow(/cycle detected/);
  });
});

describe('deriveSchedulerState / ready ordering', () => {
  test('stable definition-order ready among independent roots', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'z', provider: 'claude' },
          { id: 'a', provider: 'claude' },
          { id: 'm', provider: 'claude' },
        ],
        3,
      ),
    );
    const snap = deriveSchedulerState(g, [], []);
    expect(snap.ready).toEqual(['z', 'a', 'm']);
    expect(pickReady(snap.ready, 2)).toEqual(['z', 'a']);
  });

  test('diamond: fan-out then fan-in', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'a', provider: 'claude' },
          { id: 'b', provider: 'claude', needs: ['a'] },
          { id: 'c', provider: 'claude', needs: ['a'] },
          { id: 'd', provider: 'claude', needs: ['b', 'c'] },
        ],
        2,
      ),
    );
    let snap = deriveSchedulerState(g, [], []);
    expect(snap.ready).toEqual(['a']);

    snap = deriveSchedulerState(g, [att('a', 'succeeded', 1, { result: ok('a') })], [ok('a')]);
    expect(snap.ready).toEqual(['b', 'c']);
    expect(snap.pending).toContain('d');

    snap = deriveSchedulerState(
      g,
      [
        att('a', 'succeeded', 1, { result: ok('a') }),
        att('b', 'succeeded', 1, { result: ok('b') }),
        att('c', 'succeeded', 1, { result: ok('c') }),
      ],
      [ok('a'), ok('b'), ok('c')],
    );
    expect(snap.ready).toEqual(['d']);
  });

  test('dependency failure blocks dependents', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'a', provider: 'claude' },
          { id: 'b', provider: 'claude', needs: ['a'] },
          { id: 'c', provider: 'claude' },
        ],
        2,
      ),
    );
    const snap = deriveSchedulerState(
      g,
      [att('a', 'failed', 1, { result: fail('a') })],
      [fail('a')],
      {
        continueOnFail: { a: true }, // independent c may continue; b blocked
      },
    );
    expect(snap.steps.find((s) => s.stepId === 'b')?.status).toBe('blocked');
    expect(snap.ready).toEqual(['c']);
    expect(snap.stopNewLaunches).toBe(false);
  });

  test('hard fail without continueOnFail stops new launches', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'a', provider: 'claude' },
          { id: 'b', provider: 'claude' },
        ],
        2,
      ),
    );
    const snap = deriveSchedulerState(
      g,
      [att('a', 'failed', 1, { result: fail('a') })],
      [fail('a')],
      { continueOnFail: { a: false } },
    );
    expect(snap.stopNewLaunches).toBe(true);
    expect(snap.steps.find((s) => s.stepId === 'b')?.status).toBe('skipped');
  });

  test('running steps appear in running set', () => {
    const g = buildNormalizedGraph(plan([{ id: 'a', provider: 'claude' }], 1));
    const snap = deriveSchedulerState(g, [att('a', 'running')], []);
    expect(snap.running).toEqual(['a']);
    expect(snap.ready).toEqual([]);
  });
});

describe('retryClosure', () => {
  test('sequential maxConcurrency=1 includes definition-order tail', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'a', provider: 'claude' },
          { id: 'b', provider: 'claude' },
          { id: 'c', provider: 'claude' },
        ],
        1,
      ),
    );
    expect([...retryClosure(g, 'b')].sort()).toEqual(['b', 'c']);
  });

  test('concurrent only re-runs graph descendants', () => {
    const g = buildNormalizedGraph(
      plan(
        [
          { id: 'a', provider: 'claude' },
          { id: 'b', provider: 'claude', needs: ['a'] },
          { id: 'c', provider: 'claude' },
        ],
        3,
      ),
    );
    const set = retryClosure(g, 'a');
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(false);
  });
});
