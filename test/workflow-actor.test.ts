/**
 * S5 cutover — workflows on the actor runtime with the DEFAULT step executor (agent() →
 * instructions through the inbox → journal-derived wait → capture), over the fake
 * provider; plus a detached run followed with `orc workflow attach` from the CLI.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { runWorkflow } from '../src/workflow.ts';
import type { StepDoneCtx, WorkflowDef, WorkflowEvent } from '../src/workflow.ts';
import { readRegistry } from '../src/registry.ts';
import { readRun } from '../src/runs.ts';
import { readSpawnSpec } from '../src/runtime/spec.ts';
import { killSessionProcesses, mkTmp, plainCliEnv } from './runtime-helpers.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 60_000;
const prevHome = process.env.ORC_HOME;
const prevFake = process.env[FAKE_PROVIDER_ENV];
const root = mkTmp('orc-wf-actor-');
const home = path.join(root, 'orc');
const work = path.join(root, 'work');

beforeAll(() => {
  process.env.ORC_HOME = home;
  process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ rules: [{ match: 'BOOM', action: 'fail', error: 'kaboom' }] });
  fs.mkdirSync(work, { recursive: true });
});

afterAll(async () => {
  const sids = (await readRegistry()).map((r) => r.sessionId);
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  fs.rmSync(root, { recursive: true, force: true });
}, TEARDOWN_TIMEOUT_MS);

/** attempt-transition phases per step, in emission order. */
function phasesByStep(events: WorkflowEvent[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of events) if (e.type === 'attempt-transition') (out[e.stepId] ??= []).push(e.phase);
  return out;
}

describe('runWorkflow with the default executor', () => {
  test('step execution selections reach the persisted actor spawn spec', async () => {
    const run = await runWorkflow({
      name: 'explicit-selection',
      steps: [{ id: 'selected', provider: 'pi', model: 'openai/gpt-6.1-sol',
        reasoningEffort: 'medium', cwd: work, prompt: 'check selection', allowUnverified: true }],
    }, { runId: 'wfselection', defaultModels: { pi: 'openai/fallback' } });
    expect(run.status).toBe('done');
    const record = (await readRegistry()).find((r) => r.id === run.steps[0]!.sessionId)!;
    const spec = readSpawnSpec(record.sessionId);
    expect(spec?.model).toBe('openai/gpt-6.1-sol');
    expect(spec?.reasoningEffort).toBe('medium');
  }, T);

  test(
    'attempt transitions are emitted once each, strictly forward (no duplicate spawning, no step back)',
    async () => {
      const events: WorkflowEvent[] = [];
      const def: WorkflowDef = {
        name: 'wf-events',
        steps: [{ id: 'evt', provider: 'claude', cwd: work, prompt: 'events please', allowUnverified: true }],
      };
      const run = await runWorkflow(def, { runId: 'wfev1', onEvent: (e) => events.push(e) });
      expect(run.status).toBe('done');
      expect(phasesByStep(events)).toEqual({
        evt: ['queued', 'spawning', 'dispatched', 'running', 'verifying', 'succeeded'],
      });
      // The data attached by the same-phase re-record is still persisted.
      const att = (await readRun('wfev1'))!.attempts!.find((a) => a.stepId === 'evt')!;
      expect(att.resultPath).toBeString();
      expect(att.phase).toBe('succeeded');

      // An executor reporting no mid-flight transitions is still walked forward.
      const stubEvents: WorkflowEvent[] = [];
      const stub = await runWorkflow(def, {
        runId: 'wfev2',
        onEvent: (e) => stubEvents.push(e),
        execStep: async ({ step }) => ({
          id: step.id,
          sessionId: 'sess-stub',
          provider: step.provider,
          state: 'done',
          ok: true,
          outcome: 'succeeded',
          commitsAhead: 0,
        }),
      });
      expect(stub.status).toBe('done');
      expect(phasesByStep(stubEvents)).toEqual({ evt: ['queued', 'spawning', 'dispatched', 'verifying', 'succeeded'] });
    },
    T,
  );

  test(
    'two steps: instructions delivered once, capture = last reply + final turn',
    async () => {
      const seen: StepDoneCtx[] = [];
      const def: WorkflowDef = {
        name: 'wf-actor',
        steps: [
          {
            id: 'one',
            provider: 'claude',
            cwd: work,
            prompt: 'step one\nwith two lines',
            done: (ctx) => {
              seen.push(ctx);
              return ctx.state === 'done' && ctx.capture.includes('echo: step one');
            },
          },
          {
            id: 'two',
            provider: 'pi',
            cwd: work,
            prompt: 'step two after ${one.sessionId}',
            needs: ['one'],
            allowUnverified: true,
          },
        ],
      };
      const run = await runWorkflow(def, { runId: 'wfa1' });
      expect(run.status).toBe('done');
      const ctx = seen[0]!;
      expect(ctx.lastAssistantText).toBe('echo: step one\nwith two lines');
      expect(ctx.capture).toContain('--- final turn ---');
      expect(ctx.capture).toContain('> step one');
      expect(ctx.capture).toContain('· turn completed');
      const recs0 = await readRegistry();
      const one = recs0.find((r) => r.stepId === 'one')!;
      const twoSid = recs0.find((r) => r.stepId === 'two')!.sessionId;
      const { readJournal } = await import('../src/runtime/journal.ts');
      const twoIntent = readJournal(twoSid).find((e) => e.type === 'turn.intent');
      expect(twoIntent && twoIntent.type === 'turn.intent' && twoIntent.text).toBe(`step two after ${one.id}`);
      const att = run.attempts!.find((a) => a.stepId === 'one')!;
      expect(att.messageId).toBe(`wf-wfa1-one-${att.attemptId}-t0`);
      expect(att.deliveryPhase).toBe('acknowledged');
      const recs = await readRegistry();
      expect(recs.filter((r) => r.rootRunId === 'wfa1')).toHaveLength(2);
      expect(recs.every((r) => r.runtime === 'actor' && r.stepId !== undefined)).toBe(true);
    },
    T,
  );

  test(
    'a failed turn fails the step (state failed)',
    async () => {
      const def: WorkflowDef = {
        name: 'wf-fail',
        steps: [{ id: 'bad', provider: 'claude', cwd: work, prompt: 'BOOM now', allowUnverified: true }],
      };
      const run = await runWorkflow(def, { runId: 'wfa2' });
      expect(run.status).toBe('failed');
      expect(run.steps[0]).toMatchObject({ id: 'bad', state: 'failed', ok: false });
    },
    T,
  );
});

describe('detached workflow from the CLI', () => {
  test(
    'workflow run --detach + workflow attach follows the runner to completion',
    async () => {
      const file = path.join(work, 'two-step.workflow.ts');
      fs.writeFileSync(
        file,
        `export default {
  name: 'detached-two',
  steps: [
    { id: 'a', provider: 'claude', prompt: 'first', allowUnverified: true },
    { id: 'b', provider: 'claude', prompt: 'second', needs: ['a'], allowUnverified: true },
  ],
};\n`,
      );
      const env = plainCliEnv({ ...process.env, ORC_HOME: home });
      const launch = Bun.spawn([process.execPath, CLI, 'workflow', 'run', file, '--detach', '--json'], {
        cwd: work,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = await new Response(launch.stdout).text();
      expect(await launch.exited).toBe(0);
      const { runId } = JSON.parse(out) as { runId: string };

      const attach = Bun.spawn([process.execPath, CLI, 'workflow', 'attach', runId], {
        cwd: work,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [followed, tail] = await Promise.all([
        new Response(attach.stdout).text(),
        new Response(attach.stderr).text(),
      ]);
      expect(await attach.exited).toBe(0);
      expect(followed).toContain('= run');
      expect(tail).toContain(`# run ${runId} done`);
      const run = (await readRun(runId))!;
      expect(run.status).toBe('done');
      expect(run.steps.map((s) => [s.id, s.ok])).toEqual([
        ['a', true],
        ['b', true],
      ]);
    },
    T,
  );
});
