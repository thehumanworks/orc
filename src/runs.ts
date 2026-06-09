/**
 * Workflow-run persistence. Each run is a single JSON file ~/.orc/runs/<runId>.json,
 * written ATOMICALLY (tmp + rename) like the session registry. The runner re-persists
 * after every step transition so a crash mid-run leaves an inspectable record — and so
 * a later status/`logs` reader (a separate task) can read it without the runner present.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runsDir, runPath } from './paths.ts';
import type { WorkflowRun } from './workflow.ts';

/** Write (or overwrite) a run record atomically. */
export async function writeRun(run: WorkflowRun): Promise<void> {
  const dir = runsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = runPath(run.id);
  const tmp = path.join(dir, `.run.${randomUUID()}.tmp`);
  await Bun.write(tmp, JSON.stringify(run, null, 2));
  await fs.rename(tmp, target);
}

/** Read a single run record by id. Missing/corrupt => null. */
export async function readRun(runId: string): Promise<WorkflowRun | null> {
  const f = Bun.file(runPath(runId));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as WorkflowRun;
  } catch {
    return null;
  }
}

/** List all persisted runs, newest first (by startedAt). */
export async function listRuns(): Promise<WorkflowRun[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir());
  } catch {
    return [];
  }
  const runs: WorkflowRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skip per-run instruction dirs
    const run = await readRun(name.slice(0, -'.json'.length)).catch(() => null);
    if (run) runs.push(run);
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return runs;
}
