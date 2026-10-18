import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import research from '../orc.workflows/research.ts';
import { readRun, writeRun } from '../src/runs.ts';
import {
  buildPlan, canonicalPlanJson, legacyPlanDigest, planDigest, resumeWorkflow,
  retryWorkflow, runWorkflow, validateWorkflowDef,
  type StepExecutor, type WorkflowDef, type WorkflowStep,
} from '../src/workflow.ts';

let dir: string;
let oldHome: string | undefined;
beforeEach(async () => {
  oldHome = process.env.ORC_HOME;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-workflow-models-'));
  process.env.ORC_HOME = path.join(dir, 'home');
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = oldHome;
  await fs.rm(dir, { recursive: true, force: true });
});

function definition(overrides: Partial<WorkflowStep> = {}): WorkflowDef {
  return { name: 'models', steps: [{ id: 'one', provider: 'claude', prompt: 'task', ...overrides }] };
}
const success: StepExecutor = async ({ step }) => ({
  id: step.id, sessionId: '', provider: step.provider, state: 'done', ok: true, commitsAhead: 0,
});
const failure: StepExecutor = async (args) => ({ ...await success(args), state: 'failed', ok: false });

describe('workflow step model and reasoning effort', () => {
  test('research selects each stage model and effort explicitly', () => {
    const def = research({ prompt: 'Compare coding agents' });
    validateWorkflowDef(def);
    expect(def.steps.map(({ id, provider, model, reasoningEffort }) => ({ id, provider, model, reasoningEffort }))).toEqual([
      { id: 'search-query-optimizer', provider: 'pi', model: 'openai/gpt-6.1-sol', reasoningEffort: 'medium' },
      { id: 'search-runner', provider: 'claude', model: 'haiku', reasoningEffort: 'high' },
    ]);
  });

  test('explicit models override provider defaults and absent models retain defaults', async () => {
    const seen: Array<{ id: string; model?: string; effort?: string }> = [];
    const run = await runWorkflow({ name: 'precedence', steps: [
      { id: 'override', provider: 'claude', prompt: 'task', model: 'haiku', reasoningEffort: 'high' },
      { id: 'fallback', provider: 'claude', prompt: 'task' },
      { id: 'unset', provider: 'pi', prompt: 'task', reasoningEffort: 'low' },
    ] }, {
      defaultModels: { claude: 'sonnet' },
      execStep: async (args) => {
        seen.push({ id: args.step.id, model: args.model, effort: args.step.reasoningEffort });
        return success(args);
      },
    });
    expect(run.status).toBe('done');
    expect(seen).toEqual([
      { id: 'override', model: 'haiku', effort: 'high' },
      { id: 'fallback', model: 'sonnet', effort: undefined },
      { id: 'unset', model: undefined, effort: 'low' },
    ]);
    const saved = (await readRun(run.id))!;
    expect(saved.plan!.steps[0]).toMatchObject({ model: 'haiku', reasoningEffort: 'high' });
    expect(saved.plan!.steps[1]).not.toHaveProperty('model');
    expect(saved.plan!.steps[1]).not.toHaveProperty('reasoningEffort');
    expect(saved.defaultModels).toEqual({ claude: 'sonnet' });
    expect(saved.definitionDigest).toBe(planDigest(saved.plan!));
  });

  test('canonical plans distinguish adding, removing, or changing execution selections', () => {
    const plans = [
      definition(), definition({ model: 'haiku' }), definition({ model: 'sonnet' }),
      definition({ reasoningEffort: 'low' }), definition({ reasoningEffort: 'high' }),
      definition({ model: 'haiku', reasoningEffort: 'high' }),
    ].map(buildPlan);
    expect(new Set(plans.map(planDigest)).size).toBe(plans.length);
    expect(JSON.parse(canonicalPlanJson(plans[5]!)).steps[0]).toMatchObject({ model: 'haiku', reasoningEffort: 'high' });
  });

  test('invalid models and provider-incompatible effort fail before run creation', async () => {
    for (const overrides of [
      { model: '' }, { model: ' haiku' }, { model: 42 },
      { provider: 'pi', model: 'openai/' },
      { reasoningEffort: 'nonsense' }, { reasoningEffort: 'off' },
    ]) {
      const def = definition(overrides as Partial<WorkflowStep>);
      expect(() => validateWorkflowDef(def)).toThrow();
      await expect(runWorkflow(def, { runId: 'invalid-selection', execStep: success })).rejects.toThrow();
      expect(await readRun('invalid-selection')).toBeNull();
    }
  });

  test('resume and retry reject changed selections without modifying the saved run', async () => {
    const def = definition({ model: 'haiku', reasoningEffort: 'high' });
    const run = await runWorkflow(def, { execStep: failure });
    expect(run.status).toBe('failed');
    const saved = await readRun(run.id);
    for (const recover of [resumeWorkflow, retryWorkflow]) {
      for (const changed of [
        definition({ model: 'sonnet', reasoningEffort: 'high' }),
        definition({ model: 'haiku', reasoningEffort: 'low' }),
        definition({ model: 'haiku' }),
        definition({ reasoningEffort: 'high' }),
      ]) {
        await expect(recover(run.id, changed, { execStep: success })).rejects.toThrow('digest mismatch');
        expect(await readRun(run.id)).toEqual(saved);
      }
    }
    const observed: string[] = [];
    const retried = await retryWorkflow(run.id, def, {
      defaultModels: { claude: 'sonnet' },
      execStep: async (args) => {
        observed.push(`${args.model}/${args.step.reasoningEffort}`);
        return success(args);
      },
    });
    expect(retried.status).toBe('done');
    expect(observed).toEqual(['haiku/high']);
  });

  test('legacy digest compatibility cannot silently introduce model or effort', async () => {
    const def = definition();
    const run = await runWorkflow(def, { execStep: failure });
    const plan = { ...buildPlan(def), maxConcurrency: undefined };
    await writeRun({ ...run, schemaVersion: 3, plan, definitionDigest: legacyPlanDigest(plan) });
    for (const changed of [definition({ model: 'haiku' }), definition({ reasoningEffort: 'high' })]) {
      await expect(retryWorkflow(run.id, changed, { execStep: success })).rejects.toThrow('digest mismatch');
    }
  });

});
