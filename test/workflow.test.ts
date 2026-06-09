import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defineWorkflow,
  validateWorkflowDef,
  interpolate,
  evaluateStep,
  runWorkflow,
  deliverInstructions,
  runnerTmuxName,
  reconcileRunStatus,
  assembleStepLogs,
} from '../src/workflow.ts';
import type {
  WorkflowDef,
  WorkflowStep,
  StepResult,
  StepExecutor,
  WorkflowEvent,
} from '../src/workflow.ts';
import type { Turn } from '../src/transcript.ts';
import type { Session } from '../src/session.ts';
import { readRun, listRuns } from '../src/runs.ts';
import { runInstructionsDir } from '../src/paths.ts';

/**
 * The runner's PURE logic — step ordering, `${...}` interpolation, done-predicate
 * evaluation, run-status transitions — exercised with a FAKE step executor (injected via
 * `opts.execStep`) so no real agent is spawned. Persistence runs against a throwaway
 * ORC_HOME.
 */

const tmpHomes: string[] = [];
async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-wf-'));
  tmpHomes.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
  return process.env.ORC_HOME;
}
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fs.rm(d, { recursive: true, force: true });
});

/** A fake executor returning a canned result per step id, recording call order + cwd. */
function fakeExec(
  results: Record<string, Partial<StepResult>>,
  calls: { id: string; cwd?: string }[],
): StepExecutor {
  return async ({ step }) => {
    calls.push({ id: step.id, cwd: step.cwd });
    return {
      id: step.id,
      sessionId: `sid-${step.id}`,
      provider: step.provider,
      state: 'done',
      ok: true,
      commitsAhead: 0,
      ...results[step.id],
    } as StepResult;
  };
}

function step(over: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { provider: 'claude', prompt: 'x', ...over };
}

describe('validateWorkflowDef / defineWorkflow', () => {
  test('accepts a valid def and returns it (identity)', () => {
    const def: WorkflowDef = { name: 'ok', steps: [step({ id: 'a' })] };
    expect(defineWorkflow(def)).toBe(def);
  });
  test('rejects empty steps', () => {
    expect(() => validateWorkflowDef({ name: 'x', steps: [] })).toThrow(/non-empty array/);
  });
  test('rejects duplicate step ids', () => {
    expect(() =>
      validateWorkflowDef({ name: 'x', steps: [step({ id: 'a' }), step({ id: 'a' })] }),
    ).toThrow(/duplicate step id 'a'/);
  });
  test('requires exactly one of taskFile|prompt', () => {
    // neither
    expect(() =>
      validateWorkflowDef({ name: 'x', steps: [{ id: 'a', provider: 'claude' }] }),
    ).toThrow(/exactly one of/);
    // both
    expect(() =>
      validateWorkflowDef({
        name: 'x',
        steps: [{ id: 'a', provider: 'claude', prompt: 'p', taskFile: 'f' }],
      }),
    ).toThrow(/exactly one of/);
  });
  test('rejects invalid provider', () => {
    expect(() =>
      validateWorkflowDef({
        name: 'x',
        // @ts-expect-error bad provider on purpose
        steps: [{ id: 'a', provider: 'gpt', prompt: 'p' }],
      }),
    ).toThrow(/invalid provider/);
  });
});

describe('interpolate ${stepId.field}', () => {
  const results: Record<string, StepResult> = {
    implement: {
      id: 'implement',
      sessionId: 'sid',
      provider: 'claude',
      state: 'done',
      ok: true,
      commitsAhead: 2,
      worktree: '/wt/impl',
      branch: 'orc/impl',
    },
  };
  test('substitutes a prior field', () => {
    expect(interpolate('${implement.worktree}', results)).toBe('/wt/impl');
  });
  test('substitutes within a larger string and multiple refs', () => {
    expect(interpolate('cd ${implement.worktree} # ${implement.branch}', results)).toBe(
      'cd /wt/impl # orc/impl',
    );
  });
  test('non-string field is stringified', () => {
    expect(interpolate('${implement.commitsAhead}', results)).toBe('2');
  });
  test('throws on unknown step', () => {
    expect(() => interpolate('${nope.worktree}', results)).toThrow(/unknown step 'nope'/);
  });
  test('throws on absent field (e.g. worktree of a non-worktree step)', () => {
    expect(() => interpolate('${implement.cwd}', results)).toThrow(/no value for field 'cwd'/);
  });
  test('leaves a string with no refs unchanged', () => {
    expect(interpolate('/plain/path', results)).toBe('/plain/path');
  });
});

describe('evaluateStep — yield is NOT success', () => {
  const base = { state: 'done' as const, commitsAhead: 0, capture: '' };

  test('explicit done predicate decides ok (unverified false)', () => {
    expect(evaluateStep({ done: () => true }, base)).toEqual({ ok: true, unverified: false });
    expect(evaluateStep({ done: () => false }, base)).toEqual({ ok: false, unverified: false });
  });
  test('worktree default: needs a commit (commitsAhead>=1)', () => {
    expect(evaluateStep({ worktree: true }, { ...base, commitsAhead: 0 })).toEqual({
      ok: false,
      unverified: false,
    });
    expect(evaluateStep({ worktree: true }, { ...base, commitsAhead: 1 })).toEqual({
      ok: true,
      unverified: false,
    });
  });
  test('worktree that only yielded (no commit) is ok:false — the 3b reliability case', () => {
    expect(evaluateStep({ worktree: true }, { state: 'done', commitsAhead: 0, capture: '' }).ok).toBe(
      false,
    );
  });
  test('non-worktree, no predicate: ok from yield but flagged unverified', () => {
    expect(evaluateStep({}, base)).toEqual({ ok: true, unverified: true });
  });
  test('non-worktree, no predicate, non-done state: honest failure (not unverified)', () => {
    expect(evaluateStep({}, { ...base, state: 'failed' })).toEqual({ ok: false, unverified: false });
  });
});

describe('deliverInstructions — large input becomes a SHORT pointer + a file', () => {
  beforeEach(async () => {
    await freshHome();
  });

  /** Stub session capturing what would be sent to the pane (no live agent). */
  function stubSession(): { session: Pick<Session, 'send'>; sent: string[] } {
    const sent: string[] = [];
    return { session: { send: async (p: string) => void sent.push(p) }, sent };
  }

  test('small inline prompt is sent verbatim (no file dropped)', async () => {
    const { session, sent } = stubSession();
    await deliverInstructions(session, step({ id: 's', prompt: 'do the small thing' }), 'run1');
    expect(sent).toEqual(['do the small thing']);
    // No instruction file written for the small path.
    const dir = runInstructionsDir('run1');
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });

  test('large prompt (>1KB) drops a file and sends only a short pointer', async () => {
    const { session, sent } = stubSession();
    const body = 'X'.repeat(2048); // >1KB → file+pointer path
    await deliverInstructions(session, step({ id: 'big', prompt: body }), 'run2');
    expect(sent.length).toBe(1);
    const pointer = sent[0]!;
    // The pointer must NOT contain the multi-KB body (that's the whole point — send() drops it).
    expect(pointer).not.toContain(body);
    expect(pointer.length).toBeLessThan(400);
    // The dropped file holds the FULL body, under ~/.orc/runs/<runId>/.
    const dropped = path.join(runInstructionsDir('run2'), 'big.md');
    expect(pointer).toContain(dropped);
    expect(await Bun.file(dropped).text()).toBe(body);
  });

  test('taskFile is read, dropped outside the worktree, and delivered by pointer', async () => {
    const { session, sent } = stubSession();
    const specDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-spec-'));
    tmpHomes.push(specDir);
    const specPath = path.join(specDir, 'spec.md');
    const spec = '# Spec\n' + 'line\n'.repeat(500);
    await Bun.write(specPath, spec);

    await deliverInstructions(session, step({ id: 't', prompt: undefined, taskFile: specPath }), 'run3');
    expect(sent.length).toBe(1);
    const pointer = sent[0]!;
    const dropped = path.join(runInstructionsDir('run3'), 't.md');
    expect(pointer).toContain(dropped);
    expect(pointer).not.toContain(spec); // pointer is short, not the body
    expect(await Bun.file(dropped).text()).toBe(spec);
  });

  test('a missing taskFile throws a clear error', async () => {
    const { session } = stubSession();
    await expect(
      deliverInstructions(
        session,
        step({ id: 't', prompt: undefined, taskFile: '/no/such/spec.md' }),
        'run4',
      ),
    ).rejects.toThrow(/taskFile not found/);
  });
});

describe('runWorkflow with a fake executor', () => {
  beforeEach(async () => {
    await freshHome();
  });

  test('runs steps strictly in order; status done when all ok', async () => {
    const calls: { id: string; cwd?: string }[] = [];
    const def: WorkflowDef = {
      name: 'order',
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    };
    const run = await runWorkflow(def, { execStep: fakeExec({}, calls) });
    expect(calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(run.status).toBe('done');
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.finishedAt).toBeDefined();
  });

  test('a failed step (no continueOnFail) sets status failed and STOPS the run', async () => {
    const calls: { id: string; cwd?: string }[] = [];
    const def: WorkflowDef = {
      name: 'stop',
      steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
    };
    const run = await runWorkflow(def, {
      execStep: fakeExec({ b: { ok: false } }, calls),
    });
    // c never runs.
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b']);
  });

  test('continueOnFail keeps going but final status is failed (not all ok)', async () => {
    const calls: { id: string; cwd?: string }[] = [];
    const def: WorkflowDef = {
      name: 'cont',
      steps: [step({ id: 'a', continueOnFail: true }), step({ id: 'b' })],
    };
    const run = await runWorkflow(def, {
      execStep: fakeExec({ a: { ok: false } }, calls),
    });
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']); // b still ran
    expect(run.status).toBe('failed');
  });

  test('interpolates a later step cwd from a prior step result', async () => {
    const calls: { id: string; cwd?: string }[] = [];
    const def: WorkflowDef = {
      name: 'interp',
      steps: [
        step({ id: 'impl', worktree: true }),
        step({ id: 'review', cwd: '${impl.worktree}' }),
      ],
    };
    await runWorkflow(def, {
      execStep: fakeExec({ impl: { worktree: '/wt/impl', commitsAhead: 1 } }, calls),
    });
    expect(calls.find((c) => c.id === 'review')?.cwd).toBe('/wt/impl');
  });

  test('persists the run record + re-persists each transition (crash-inspectable)', async () => {
    const def: WorkflowDef = { name: 'persist', steps: [step({ id: 'a' }), step({ id: 'b' })] };
    const run = await runWorkflow(def, { execStep: fakeExec({}, []) });
    const onDisk = await readRun(run.id);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.id).toBe(run.id);
    expect(onDisk!.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(onDisk!.status).toBe('done');
    const all = await listRuns();
    expect(all.map((r) => r.id)).toContain(run.id);
  });

  test('emits run-start, per-step start/done, and run-done events', async () => {
    const events: WorkflowEvent[] = [];
    const def: WorkflowDef = { name: 'events', steps: [step({ id: 'a' })] };
    await runWorkflow(def, {
      execStep: fakeExec({}, []),
      onEvent: (e) => events.push(e),
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('run-start');
    expect(types).toContain('step-start');
    expect(types).toContain('step-done');
    expect(types).toContain('run-done');
  });

  test('emits a loud warning when a step is unverified', async () => {
    const events: WorkflowEvent[] = [];
    const def: WorkflowDef = { name: 'warn', steps: [step({ id: 'a' })] };
    await runWorkflow(def, {
      execStep: fakeExec({ a: { unverified: true } }, []),
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === 'step-warn')).toBe(true);
  });

  test('an executor that throws records a failed step and stops', async () => {
    const calls: { id: string }[] = [];
    const def: WorkflowDef = { name: 'throw', steps: [step({ id: 'a' }), step({ id: 'b' })] };
    const run = await runWorkflow(def, {
      execStep: async ({ step: s }) => {
        calls.push({ id: s.id });
        if (s.id === 'a') throw new Error('boom');
        return {
          id: s.id,
          sessionId: '',
          provider: s.provider,
          state: 'done',
          ok: true,
          commitsAhead: 0,
        };
      },
    });
    expect(calls.map((c) => c.id)).toEqual(['a']); // stopped after the throw
    expect(run.status).toBe('failed');
    expect(run.steps[0]!.state).toBe('failed');
  });

  test('opts.runId/runnerTmux are honored and persisted (the --detach entrypoint)', async () => {
    const def: WorkflowDef = { name: 'detached', steps: [step({ id: 'a' })] };
    const run = await runWorkflow(def, {
      execStep: fakeExec({}, []),
      runId: 'deadbeef',
      runnerTmux: 'orc-wf-deadbeef',
    });
    expect(run.id).toBe('deadbeef'); // used INSTEAD of a generated one
    expect(run.runnerTmux).toBe('orc-wf-deadbeef');
    const onDisk = await readRun('deadbeef');
    expect(onDisk!.runnerTmux).toBe('orc-wf-deadbeef'); // survives the runner's re-persist
    expect(onDisk!.status).toBe('done');
  });
});

describe('runnerTmuxName', () => {
  test('builds the orc-wf-<runId> session name', () => {
    expect(runnerTmuxName('deadbeef')).toBe('orc-wf-deadbeef');
  });
});

describe('reconcileRunStatus — stale running vs runner liveness', () => {
  test('a running record whose runner is dead is orphaned', () => {
    expect(reconcileRunStatus('running', false)).toBe('orphaned');
  });
  test('a running record whose runner is alive stays running', () => {
    expect(reconcileRunStatus('running', true)).toBe('running');
  });
  test('a running record with unknowable liveness (no runnerTmux) is trusted as running', () => {
    expect(reconcileRunStatus('running', null)).toBe('running');
  });
  test('a finalized status is trusted regardless of liveness', () => {
    // even if the (now-gone) runner reads not-alive, done/failed/orphaned are deliberate.
    expect(reconcileRunStatus('done', false)).toBe('done');
    expect(reconcileRunStatus('failed', false)).toBe('failed');
    expect(reconcileRunStatus('failed', null)).toBe('failed');
    expect(reconcileRunStatus('orphaned', true)).toBe('orphaned');
  });
});

describe('assembleStepLogs — per-step transcript assembly', () => {
  const steps: StepResult[] = [
    { id: 'a', sessionId: 'sid-a', provider: 'claude', state: 'done', ok: true, commitsAhead: 0 },
    { id: 'b', sessionId: 'sid-b', provider: 'codex', state: 'done', ok: true, commitsAhead: 0 },
  ];
  // Fake transcript reader: returns a single assistant turn naming the step's session.
  const reader = async (s: StepResult): Promise<Turn[]> => [
    { role: 'assistant', text: `transcript of ${s.sessionId}` },
  ];

  test('assembles a log per step (label data + injected turns), in order', async () => {
    const logs = await assembleStepLogs(steps, reader);
    expect(logs).toEqual([
      { step: 'a', provider: 'claude', turns: [{ role: 'assistant', text: 'transcript of sid-a' }] },
      { step: 'b', provider: 'codex', turns: [{ role: 'assistant', text: 'transcript of sid-b' }] },
    ]);
  });

  test('--step narrows to one step', async () => {
    const logs = await assembleStepLogs(steps, reader, 'b');
    expect(logs.map((l) => l.step)).toEqual(['b']);
    expect(logs[0]!.provider).toBe('codex');
  });

  test('an unknown --step throws a clear error listing the steps', async () => {
    await expect(assembleStepLogs(steps, reader, 'zzz')).rejects.toThrow(
      /no step 'zzz' \(steps: a, b\)/,
    );
  });

  test('the reader is used verbatim (e.g. empty turns for a step with no transcript)', async () => {
    const empty = async (): Promise<Turn[]> => [];
    const logs = await assembleStepLogs(steps, empty, 'a');
    expect(logs[0]!.turns).toEqual([]);
  });
});
