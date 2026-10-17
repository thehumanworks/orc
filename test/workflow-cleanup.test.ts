import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { readRegistry, upsertRecord } from '../src/registry.ts';
import { readRun, writeRun, WORKFLOW_SCHEMA_VERSION } from '../src/runs.ts';
import { sessionStateDir } from '../src/paths.ts';
import { Session } from '../src/session.ts';
import { isSameProcessAlive, processStartTime } from '../src/runtime/process.ts';
import { cleanupWorkflow, runWorkflow, retryWorkflow, type WorkflowDef, type WorkflowEvent } from '../src/workflow.ts';
import type { SessionRecord } from '../src/types.ts';

let root: string;
let prevHome: string | undefined;
let prevFake: string | undefined;
beforeEach(async () => {
  prevHome = process.env.ORC_HOME;
  prevFake = process.env[FAKE_PROVIDER_ENV];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-workflow-cleanup-'));
  process.env.ORC_HOME = path.join(root, 'orc');
  process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ rules: [{ match: 'FAIL', action: 'fail', error: 'intentional failure' }] });
});
afterEach(async () => {
  for (const record of await readRegistry()) await new Session(record).kill().catch(() => {});
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  await fs.rm(root, { recursive: true, force: true });
}, 30_000);

function definition(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return { name: 'cleanup', steps: [{ id: 'one', provider: 'claude', cwd: root, prompt: 'FAIL', allowUnverified: true }], ...overrides };
}

async function seedRun(id: string, parentRunId?: string) {
  await writeRun({ schemaVersion: WORKFLOW_SCHEMA_VERSION, revision: 0, id, name: id,
    status: 'failed', startedAt: new Date().toISOString(), steps: [], rootRunId: 'root', parentRunId });
}
async function seedSession(id: string, fields: Partial<SessionRecord> = {}) {
  const record: SessionRecord = { id, sessionId: `uuid-${id}`, runtime: 'actor', provider: 'claude',
    cwd: root, workspace: root, createdAt: new Date().toISOString(), ...fields };
  await upsertRecord(record);
  return record;
}

describe('failed workflow session cleanup', () => {
  test('stops all run sessions before run-done while retaining journals and worktrees', async () => {
    const retained = path.join(root, 'retained-worktree');
    await fs.mkdir(retained);
    await fs.writeFile(path.join(retained, 'evidence.txt'), 'evidence');
    await seedSession('owned', { rootRunId: 'failed-run', parentRunId: 'failed-run', worktreePath: retained });
    const events: WorkflowEvent[] = [];
    const cleanupStatuses: string[] = [];
    const originalKill = Session.prototype.kill;
    Session.prototype.kill = async function (opts) {
      cleanupStatuses.push((await readRun('failed-run'))!.status);
      return originalKill.call(this, opts);
    };
    let run;
    try {
      run = await runWorkflow(definition(), { runId: 'failed-run', onEvent: (e) => events.push(e) });
    } finally {
      Session.prototype.kill = originalKill;
    }
    expect(run.status).toBe('failed');
    expect(cleanupStatuses).toEqual(['running', 'running']);
    const records = await readRegistry();
    expect(records.every((r) => r.status === 'dead')).toBe(true);
    const actual = records.find((r) => r.id === run.steps[0]!.sessionId)!;
    expect(await fs.stat(path.join(sessionStateDir(actual.sessionId), 'journal.jsonl'))).toBeTruthy();
    expect(await fs.readFile(path.join(retained, 'evidence.txt'), 'utf8')).toBe('evidence');
    expect((await readRun(run.id))!.attempts![0]!.phase).toBe('failed');
    expect(events.at(-1)!.type).toBe('run-done');
  }, 30_000);

  test('keeps sessions when requested and preserves the policy during retry', async () => {
    const def = definition();
    const run = await runWorkflow(def, { runId: 'keep', keepSessionsOnError: true });
    expect((await readRun(run.id))!.plan!.keepSessionsOnError).toBe(true);
    expect((await readRegistry()).every((r) => r.status !== 'dead')).toBe(true);
    const retried = await retryWorkflow(run.id, def);
    expect(retried.status).toBe('failed');
    expect(retried.plan!.keepSessionsOnError).toBe(true);
    expect((await readRegistry()).every((r) => r.status !== 'dead')).toBe(true);
  }, 30_000);

  test('successful workflows retain sessions; options can override a definition opt-out', async () => {
    const def = definition({ keepSessionsOnError: true });
    const success = await runWorkflow({ ...def, steps: [{ ...def.steps[0]!, prompt: 'success' }] }, { runId: 'success' });
    expect(success.status).toBe('done');
    expect((await readRegistry()).find((r) => r.id === success.steps[0]!.sessionId)!.status).not.toBe('dead');
    const failure = await runWorkflow(def, { runId: 'override', keepSessionsOnError: false });
    expect((await readRegistry()).find((r) => r.id === failure.steps[0]!.sessionId)!.status).toBe('dead');
    expect((await readRegistry()).find((r) => r.id === success.steps[0]!.sessionId)!.status).not.toBe('dead');
  }, 30_000);

  test('missing output emits the path and persists a failed artifact observation', async () => {
    const events: WorkflowEvent[] = [];
    const def = definition();
    def.steps[0] = { ...def.steps[0]!, prompt: 'reply without writing the promised file', outputs: [{ name: 'report', path: 'missing-report.txt' }] };
    const run = await runWorkflow(def, { runId: 'missing-artifact', onEvent: (e) => events.push(e) });
    expect(run.status).toBe('failed');
    expect(events.some((e) => e.type === 'step-error' && e.error.includes('missing-report.txt'))).toBe(true);
    const disk = (await readRun(run.id))!;
    expect(disk.steps[0]!.observations![0]!.message).toContain('missing-report.txt');
    expect(disk.attempts![0]!.result!.observations![0]!.passed).toBe(false);
    expect((await readRegistry()).every((r) => r.status === 'dead')).toBe(true);
  }, 30_000);

  test('nested cleanup follows run and session descendants, preserving siblings', async () => {
    await seedRun('root');
    await seedRun('target', 'root');
    await seedRun('child', 'target');
    await seedRun('grandchild', 'child');
    await seedRun('sibling', 'root');
    await seedSession('target-session', { rootRunId: 'root', parentRunId: 'target', depth: 2 });
    await seedSession('child-session', { rootRunId: 'root', parentRunId: 'child', depth: 3 });
    await seedSession('grandchild-session', { rootRunId: 'root', parentRunId: 'grandchild', depth: 4 });
    await seedSession('delegated', { rootRunId: 'root', parentSessionId: 'uuid-child-session', depth: 4 });
    await seedSession('sibling-session', { rootRunId: 'root', parentRunId: 'sibling' });
    await seedSession('legacy-step');
    const target = (await readRun('target'))!;
    await writeRun({ ...target, steps: [{ id: 'legacy', sessionId: 'legacy-step', provider: 'claude', state: 'failed', ok: false, commitsAhead: 0 }] });
    await seedSession('unrelated');
    const killed: string[] = [];
    const result = await cleanupWorkflow('target', { sessions: true, killSession: async (id, removeWorktree) => {
      expect(removeWorktree).toBe(false);
      killed.push(id);
    } });
    expect(new Set(killed)).toEqual(new Set(['target-session', 'child-session', 'grandchild-session', 'delegated', 'legacy-step']));
    expect(result.worktrees).toEqual([]);
  });

  test('a failed parent cancels nested runners but leaves sibling runs alone', async () => {
    await seedRun('child-run', 'failed-parent');
    await seedRun('sibling-run', 'root');
    const child = (await readRun('child-run'))!;
    const sibling = (await readRun('sibling-run'))!;
    await writeRun({ ...child, status: 'running' });
    await writeRun({ ...sibling, status: 'running' });
    await seedSession('child-session', { rootRunId: 'root', parentRunId: 'child-run' });
    await seedSession('sibling-session', { rootRunId: 'root', parentRunId: 'sibling-run' });
    await runWorkflow(definition(), { runId: 'failed-parent', rootRunId: 'root', parentRunId: 'root' });
    expect((await readRun('child-run'))!.status).toBe('cancelled');
    expect((await readRun('sibling-run'))!.status).toBe('running');
    expect((await readRegistry()).find((r) => r.id === 'child-session')!.status).toBe('dead');
    expect((await readRegistry()).find((r) => r.id === 'sibling-session')!.status).not.toBe('dead');
  }, 30_000);

  test('waits for a cancelled nested runner to register its last session before cleanup', async () => {
    const lateRecord: SessionRecord = {
      id: 'late-session', sessionId: 'uuid-late-session', runtime: 'actor', provider: 'claude',
      cwd: root, workspace: root, createdAt: new Date().toISOString(),
      rootRunId: 'root', parentRunId: 'late-child',
    };
    const script = `
      const { upsertRecord } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/registry.ts'))});
      process.on('SIGTERM', async () => {
        await Bun.sleep(150);
        await upsertRecord(${JSON.stringify(lateRecord)});
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      console.log('ready');
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      reader.releaseLock();
      const identity = { pid: child.pid, startTime: processStartTime(child.pid) };
      await seedRun('late-child', 'failed-parent');
      const record = (await readRun('late-child'))!;
      await writeRun({ ...record, status: 'running', runner: {
        ...identity, logPath: path.join(root, 'late-child.log'), startedAt: new Date().toISOString(),
      } });
      await runWorkflow(definition(), { runId: 'failed-parent', rootRunId: 'root', parentRunId: 'root' });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`late runner exit ${exitCode}: ${await new Response(child.stderr).text()}`);
      expect(isSameProcessAlive(identity)).toBe(false);
      expect((await readRegistry()).find((r) => r.id === 'late-session')!.status).toBe('dead');
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  }, 30_000);

  test('rescans for a delegated session registered while its parent is stopping', async () => {
    await seedRun('target');
    await seedSession('producer', { parentRunId: 'target' });
    const originalKill = Session.prototype.kill;
    Session.prototype.kill = async function (opts) {
      await originalKill.call(this, opts);
      if (this.id === 'producer') {
        await seedSession('late-delegate', { parentSessionId: 'producer' });
      }
    };
    try {
      const result = await cleanupWorkflow('target', { sessions: true });
      expect(result.sessions).toEqual(['producer', 'late-delegate']);
      expect((await readRegistry()).every((r) => r.status === 'dead')).toBe(true);
    } finally {
      Session.prototype.kill = originalKill;
    }
  });

  test('timed-out sessions are stopped and remain inspectable', async () => {
    process.env[FAKE_PROVIDER_ENV] = JSON.stringify({ default: { action: 'hang' } });
    const def = definition();
    def.steps[0] = { ...def.steps[0]!, prompt: 'hang', timeoutMs: 300 };
    const run = await runWorkflow(def, { runId: 'timeout' });
    expect(run.status).toBe('failed');
    expect(run.steps[0]!.outcome).toBe('timed_out');
    expect((await readRegistry()).every((r) => r.status === 'dead')).toBe(true);
    expect((await readRun(run.id))!.attempts![0]!.result!.outcome).toBe('timed_out');
  }, 30_000);

  test('one cleanup failure does not prevent remaining sessions from being stopped', async () => {
    await seedRun('target');
    await seedSession('first', { parentRunId: 'target' });
    await seedSession('second', { parentRunId: 'target' });
    const tried: string[] = [];
    await expect(cleanupWorkflow('target', { sessions: true, killSession: async (id) => {
      tried.push(id);
      if (id === 'first') throw new Error('stop rejected');
    } })).rejects.toThrow("session 'first': stop rejected");
    expect(tried).toEqual(['first', 'second']);
  });
});
