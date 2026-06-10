import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertValidRunId, runPath, runInstructionsDir } from '../src/paths.ts';
import { writeRun, readRun } from '../src/runs.ts';
import { runnerTmuxName } from '../src/workflow.ts';
import type { WorkflowRun } from '../src/workflow.ts';

const tmpHomes: string[] = [];
async function freshHome(): Promise<void> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-runid-'));
  tmpHomes.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
}
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fs.rm(d, { recursive: true, force: true });
});

describe('assertValidRunId', () => {
  test('accepts deadbeef and mint-style ids', () => {
    expect(() => assertValidRunId('deadbeef')).not.toThrow();
    expect(() => assertValidRunId('a1b2_c3-d4')).not.toThrow();
  });

  test('rejects traversal and unsafe ids', () => {
    for (const bad of ['', '   ', '.', '..', '../evil', 'foo/bar', 'foo\\bar', 'a\0b']) {
      expect(() => assertValidRunId(bad)).toThrow(/invalid runId/);
    }
  });

  test('runPath and runInstructionsDir enforce validation', () => {
    expect(() => runPath('../evil')).toThrow(/invalid runId/);
    expect(() => runInstructionsDir('foo/bar')).toThrow(/invalid runId/);
    expect(runPath('deadbeef')).toMatch(/deadbeef\.json$/);
  });

  test('runnerTmuxName validates and sanitizes', () => {
    expect(runnerTmuxName('deadbeef')).toBe('orc-wf-deadbeef');
    expect(() => runnerTmuxName('../x')).toThrow(/invalid runId/);
  });
});

describe('run persistence with valid ids', () => {
  beforeEach(() => freshHome());

  test('writeRun with ../x throws; readRun(../x) throws; valid round-trip', async () => {
    const bad: WorkflowRun = {
      id: '../x',
      name: 'n',
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: [],
    };
    await expect(writeRun(bad)).rejects.toThrow(/invalid runId/);
    await expect(readRun('../x')).rejects.toThrow(/invalid runId/);

    const good: WorkflowRun = {
      id: 'deadbeef',
      name: 'n',
      startedAt: new Date().toISOString(),
      status: 'done',
      steps: [],
    };
    await writeRun(good);
    expect(await readRun('deadbeef')).toMatchObject({ id: 'deadbeef', status: 'done' });
  });
});