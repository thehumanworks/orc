import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectOutputArtifact, materializeInput, refFromManifest } from '../src/artifacts.ts';
import { runArtifactBlobPath, runStepInputsDir } from '../src/paths.ts';
import { readRun } from '../src/runs.ts';
import { deliverInstructions, runWorkflow, type StepResult, type WorkflowStep } from '../src/workflow.ts';

const homes: string[] = [];
const originalHome = process.env.ORC_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalHome;
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

async function freshHome() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orc-inputs-')));
  homes.push(home);
  process.env.ORC_HOME = home;
  return home;
}

function step(id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, provider: 'claude', prompt: 'work', ...extra };
}

function result(s: WorkflowStep, artifacts?: StepResult['artifacts']): StepResult {
  return { id: s.id, provider: s.provider, sessionId: `session-${s.id}`, state: 'done', ok: true,
    commitsAhead: 0, artifacts };
}

async function produce(runId: string, stepId: string, content: string) {
  const cwd = process.env.ORC_HOME!;
  await Bun.write(path.join(cwd, `${stepId}.txt`), content);
  return refFromManifest((await collectOutputArtifact({
    runId, stepId, attemptId: `${stepId}-attempt`, cwd,
    decl: { name: 'report', path: `${stepId}.txt` },
  }))!);
}

test('concurrent consumers get separate files and hyphenated input references', async () => {
  await freshHome();
  const files: Record<string, string> = {};
  const run = await runWorkflow({ name: 'consumer-paths', maxConcurrency: 2, steps: [
    step('producer'),
    ...['one', 'two'].map((id) => step(id, {
      inputs: [{ name: 'source-report', fromStep: 'producer', artifact: 'report', materializeAs: 'docs/report.md' }],
      prompt: 'Read ${inputs.source-report}; producer ${producer.sessionId}',
      cwd: '${inputs.source-report}',
    })),
  ] }, { execStep: async ({ step: s, runId, inputPaths }) => {
    if (s.id === 'producer') return result(s, { report: await produce(runId, s.id, 'research') });
    const file = inputPaths!['source-report']!;
    files[s.id] = file;
    expect(file).toBe(path.join(runStepInputsDir(runId, s.id), 'docs/report.md'));
    expect(s.cwd).toBe(file);
    expect(s.prompt).toBe(`Read ${file}; producer session-producer`);
    expect(await Bun.file(file).text()).toBe('research');
    return result(s);
  } });
  expect(run.status).toBe('done');
  expect(files.one).not.toBe(files.two);
  await Bun.write(files.one!, 'consumer edit');
  expect(await Bun.file(files.two!).text()).toBe('research');
});

test('input resolution uses each producer result even when manifest names overlap', async () => {
  await freshHome();
  const run = await runWorkflow({ name: 'producer-refs', steps: [
    step('first'), step('second'),
    step('consumer', { inputs: [
      { name: 'earlier', fromStep: 'first', artifact: 'report' },
      { name: 'later', fromStep: 'second', artifact: 'report' },
    ] }),
  ] }, { execStep: async ({ step: s, runId, inputPaths }) => {
    if (s.id !== 'consumer') return result(s, { report: await produce(runId, s.id, s.id) });
    expect(await Bun.file(inputPaths!.earlier!).text()).toBe('first');
    expect(await Bun.file(inputPaths!.later!).text()).toBe('second');
    return result(s);
  } });
  expect(run.status).toBe('done');
});

test('a prior step named inputs keeps existing step-field interpolation', async () => {
  await freshHome();
  const run = await runWorkflow({ name: 'legacy-inputs-step', steps: [step('inputs'),
    step('consumer', { prompt: 'Continue ${inputs.sessionId}' }),
  ] }, { execStep: async ({ step: s }) => {
    if (s.id === 'consumer') expect(s.prompt).toBe('Continue session-inputs');
    return result(s);
  } });
  expect(run.status).toBe('done');
});

for (const failure of ['missing', 'tampered', 'escape'] as const) {
  test(`${failure} artifact input fails durably before consumer execution`, async () => {
    await freshHome();
    const calls: string[] = [];
    const run = await runWorkflow({ name: `failed-${failure}`, steps: [step('producer'), step('consumer', {
      inputs: [{ name: 'report', fromStep: 'producer',
        ...(failure === 'escape' ? { materializeAs: '../escaped' } : {}) }],
    })] }, { execStep: async ({ step: s, runId }) => {
      calls.push(s.id);
      const ref = failure === 'missing' ? undefined : await produce(runId, s.id, 'original');
      if (failure === 'tampered') await Bun.write(runArtifactBlobPath(runId, ref!.digest), 'changed');
      return result(s, ref ? { report: ref } : undefined);
    } });
    expect(calls).toEqual(['producer']);
    expect(run.status).toBe('failed');
    const stored = (await readRun(run.id))!;
    const attempt = stored.attempts!.find((a) => a.stepId === 'consumer')!;
    expect(attempt.phase).toBe('failed');
    expect(attempt.errorMessage).toMatch(failure === 'missing' ? /no artifact/ : failure === 'tampered' ? /hash verification/ : /\.\./);
    expect(stored.steps.find((s) => s.id === 'consumer')?.ok).toBe(false);
  });
}

test('taskFile interpolation and delivered instructions expose absolute input paths', async () => {
  await freshHome();
  const messages: string[] = [];
  const run = await runWorkflow({ name: 'input-task-file', steps: [step('producer'), step('consumer', {
    prompt: undefined, taskFile: '${inputs.task-file}',
    inputs: [{ name: 'task-file', fromStep: 'producer', artifact: 'report' }],
  })] }, { execStep: async ({ step: s, runId, inputPaths }) => {
    if (s.id === 'producer') return result(s, { report: await produce(runId, s.id, 'Do the research.') });
    expect(s.taskFile).toBe(inputPaths!['task-file']);
    await deliverInstructions({ send: async (message) => {
      messages.push(message);
      return { phase: 'acknowledged', messageId: 'test-message', replayed: false };
    } }, s, runId, { inputPaths });
    return result(s);
  } });
  expect(run.status).toBe('done');
  expect(messages[0]).toContain(`task-file: ${path.join(runStepInputsDir(run.id, 'consumer'), 'task-file')}`);
});

test('materialization reads the producing run and rejects symlinks outside the consumer inputs', async () => {
  const home = await freshHome();
  const ref = await produce('producer-run', 'producer', 'source');
  const dest = await materializeInput({ runId: 'consumer-run', stepId: 'consumer', ref, destName: 'nested/source' });
  expect(dest).toBe(path.join(runStepInputsDir('consumer-run', 'consumer'), 'nested/source'));
  expect(await Bun.file(dest).text()).toBe('source');
  const outside = path.join(home, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(runStepInputsDir('consumer-run', 'consumer'), 'link'));
  await expect(materializeInput({ runId: 'consumer-run', stepId: 'consumer', ref, destName: 'link/source' }))
    .rejects.toThrow(/outside|escape/);
  expect(await Bun.file(path.join(outside, 'source')).exists()).toBe(false);
});
