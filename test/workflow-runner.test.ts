/**
 * S6a — workflow runners as plain detached processes (no tmux): v5 schema/normalization,
 * owner liveness (runner identity ∧ lease), the lease heartbeat, abort/SIGTERM, the
 * spawn-then-stamp launch helpers (CLI + daemon), `workflow attach` follow, and real
 * detached processes end-to-end through the CLI. Every test uses a throwaway ORC_HOME;
 * no agent is ever launched.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runWorkflow,
  cancelWorkflow,
  reconcileRun,
  runOwnerLiveness,
  assertRecoveryAllowed,
} from '../src/workflow.ts';
import type { WorkflowDef, StepExecutor, StepResult, WorkflowRun } from '../src/workflow.ts';
import {
  readRun,
  writeRun,
  writeRunOwned,
  makeLease,
  isLeaseLive,
  classifyOwnerLiveness,
  normalizeRun,
  stampRunner,
  FinalizedRunError,
  LiveOwnerError,
  WORKFLOW_SCHEMA_VERSION,
} from '../src/runs.ts';
import type { RunnerInfo } from '../src/runs.ts';
import { runPath, runnerLogPath } from '../src/paths.ts';
import {
  isPidAlive,
  isSameProcessAlive,
  processStartTime,
  selfArgv,
  spawnDetached,
  terminateProcessGroup,
} from '../src/runtime/process.ts';
import type { SpawnDetachedOptions } from '../src/runtime/process.ts';
import type { ProcessIdentity } from '../src/runtime/types.ts';
import {
  awaitRunnerHandoff,
  followRunnerLog,
  launchDetachedRecovery,
  launchDetachedRun,
  RunnerSpawnError,
} from '../src/workflow-runner.ts';
import { serveDaemon } from '../src/daemon/server.ts';
import { renderRunDetail } from '../src/cli/output.ts';

const CLI = path.resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const POLICY_FAIL_WF = path.join(import.meta.dir, 'fixtures', 'policy-fail-workflow.ts');
const BLOCKING_RUNNER = path.join(import.meta.dir, 'fixtures', 'blocking-runner.ts');
/** Above Linux pid_max (2^22): never a live process. */
const DEAD_PID = 2 ** 22 + 12_345;

const tmpHomes: string[] = [];
let home = '';
async function freshHome(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'orc-runner-'));
  tmpHomes.push(d);
  home = d;
  process.env.ORC_HOME = path.join(d, 'orc');
  await fsp.mkdir(process.env.ORC_HOME, { recursive: true });
  return process.env.ORC_HOME;
}

/** Every real process a test starts; afterAll guarantees none outlives the suite. */
const spawned: ProcessIdentity[] = [];
afterAll(async () => {
  for (const id of spawned) await terminateProcessGroup(id, 500).catch(() => false);
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fsp.rm(d, { recursive: true, force: true });
});

async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms: number,
  label: string,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await probe();
    if (v) return v as T;
    await Bun.sleep(25);
  }
  const v = await probe();
  if (v) return v as T;
  throw new Error(`timed out after ${ms}ms waiting for: ${label}`);
}

const self = (): ProcessIdentity => ({ pid: process.pid, startTime: processStartTime(process.pid) });
const runnerOf = (id: ProcessIdentity, runId = 'deadbeef'): RunnerInfo => ({
  ...id,
  logPath: path.join(os.tmpdir(), runId, 'runner.log'),
  startedAt: new Date().toISOString(),
});

function baseRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    revision: 1,
    id: 'r1',
    name: 'n',
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
    ...over,
  };
}

const okResult = (id: string): StepResult => ({
  id,
  sessionId: `s-${id}`,
  provider: 'claude',
  state: 'done',
  ok: true,
  commitsAhead: 0,
});

/** A step executor that blocks until `release()` is called. */
function blockingExec(): { exec: StepExecutor; started: Promise<void>; release: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (markStarted = r));
  const exec: StepExecutor = async ({ step }) => {
    markStarted();
    await gate;
    return okResult(step.id);
  };
  return { exec, started, release };
}

const oneStep: WorkflowDef = { name: 'one', steps: [{ id: 'a', provider: 'claude', prompt: 'x' }] };

// ───────────────────────────────────────────────────────────────────────────────────
describe('schema v5: runner + legacy tmux-runner normalization', () => {
  beforeEach(() => freshHome());

  test('v4 legacy runner name (top level or lease) → read-only legacyRunnerTmux; reconcile orphans it', async () => {
    const lease = makeLease({ leaseMs: 60_000 }); // fresh, owned by a LIVE pid (us)
    const v4 = {
      schemaVersion: 4,
      revision: 3,
      id: 'leg4',
      name: 'old',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      runnerTmux: 'orc-wf-leg4',
      steps: [],
      lease: { ...lease, runnerTmux: 'orc-wf-leg4' },
    };
    const n = normalizeRun(v4)!;
    expect(n.schemaVersion).toBe(4); // on-disk version is reported as read
    expect(n.legacyRunnerTmux).toBe('orc-wf-leg4');
    expect(n.runner).toBeUndefined();
    expect('runnerTmux' in n).toBe(false);
    expect('runnerTmux' in (n.lease as object)).toBe(false);

    // Only on the lease is enough.
    const leaseOnly = normalizeRun({ ...v4, runnerTmux: undefined })!;
    expect(leaseOnly.legacyRunnerTmux).toBe('orc-wf-leg4');

    // Runner dead (legacy) ⇒ orphaned even though the lease is fresh and its pid alive.
    expect(runOwnerLiveness(n)).toEqual({ runnerAlive: false, leaseLive: false });
    await Bun.write(runPath('leg4'), JSON.stringify(v4));
    const reconciled = await reconcileRun((await readRun('leg4'))!);
    expect(reconciled.status).toBe('orphaned');
    const raw = JSON.parse(fs.readFileSync(runPath('leg4'), 'utf8'));
    expect(raw.status).toBe('orphaned');
    expect(raw.schemaVersion).toBe(5);
    expect(raw.legacyRunnerTmux).toBeUndefined(); // never written back
    expect(raw.runnerTmux).toBeUndefined();
    expect(raw.lease.runnerTmux).toBeUndefined();
  });

  test('legacy marker is stripped on every write', async () => {
    const run = baseRun({ id: 'leg5', status: 'failed', legacyRunnerTmux: 'orc-wf-leg5' });
    await writeRun(run);
    const raw = JSON.parse(fs.readFileSync(runPath('leg5'), 'utf8'));
    expect(raw.legacyRunnerTmux).toBeUndefined();
    expect((await readRun('leg5'))!.legacyRunnerTmux).toBeUndefined();
  });

  test('v5 runner round-trips; malformed runner dropped; v5 runner wins over a legacy name', () => {
    const runner = { pid: 4242, startTime: 'proc:99', logPath: '/x/runner.log', startedAt: 't' };
    const ok = normalizeRun({ ...baseRun(), runner })!;
    expect(ok.runner).toEqual(runner);
    expect(normalizeRun({ ...baseRun(), runner: { ...runner, startTime: null } })!.runner?.startTime).toBeNull();
    for (const bad of [
      { ...runner, pid: 0 },
      { ...runner, pid: 1.5 },
      { ...runner, logPath: '' },
      { ...runner, startTime: 7 },
      { pid: 4242 },
      'nope',
    ]) {
      expect(normalizeRun({ ...baseRun(), runner: bad })!.runner).toBeUndefined();
    }
    const both = normalizeRun({ ...baseRun(), runner, runnerTmux: 'orc-wf-x' })!;
    expect(both.runner).toEqual(runner);
    expect(both.legacyRunnerTmux).toBeUndefined();
  });

  test('status rendering: a legacy runner is "resumable" only when the run is', () => {
    expect(renderRunDetail(baseRun({ status: 'done', legacyRunnerTmux: 'orc-wf-x' }))).toContain(
      'runner:     legacy pre-actor runner (gone)',
    );
    expect(renderRunDetail(baseRun({ status: 'cancelled', legacyRunnerTmux: 'orc-wf-x' }))).not.toContain(
      'resumable',
    );
    expect(renderRunDetail(baseRun({ status: 'orphaned', legacyRunnerTmux: 'orc-wf-x' }))).toContain(
      'legacy pre-actor runner (gone; resumable)',
    );
  });

  test('readRun never sees a torn record while a writer atomically rewrites it', async () => {
    await writeRun(baseRun({ id: 'tr1' }));
    let done = false;
    const writer = (async () => {
      for (let i = 0; i < 200; i++) await writeRun(baseRun({ id: 'tr1', name: i % 2 ? 'n' : 'n'.repeat(4_000) }));
      done = true;
    })();
    let reads = 0;
    let nulls = 0;
    while (!done) {
      reads++;
      if ((await readRun('tr1')) === null) nulls++;
    }
    await writer;
    expect(reads).toBeGreaterThan(50);
    expect(nulls).toBe(0);
  }, 20_000);

  test('lease startTime round-trips (pid-reuse guard)', () => {
    const lease = makeLease();
    expect(lease.pid).toBe(process.pid);
    expect(lease.startTime).toBe(processStartTime(process.pid));
    const n = normalizeRun({ ...baseRun(), lease })!;
    expect(n.lease?.startTime).toBe(lease.startTime);
    const other = makeLease({ pid: DEAD_PID });
    expect(other.startTime).toBeNull(); // never borrow our start time for another pid
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('owner liveness = lease not expired ∧ owner alive', () => {
  const now = Date.now();
  const fresh = makeLease({ nowMs: now, leaseMs: 60_000 });
  const expired = makeLease({ nowMs: now - 120_000, leaseMs: 1_000 });

  test.each([
    ['fresh lease + live runner', fresh, self(), true],
    ['fresh lease + dead runner', fresh, { pid: DEAD_PID, startTime: null }, false],
    ['expired lease + live runner', expired, self(), false],
    ['fresh lease + runner pid reused (start time mismatch)', fresh, { pid: process.pid, startTime: 'proc:1' }, false],
  ] as const)('isLeaseLive: %s', (_label, lease, runner, want) => {
    expect(isLeaseLive(lease, { nowMs: now, runner })).toBe(want);
  });

  test('no runner → the lease identity decides (pid + start time)', () => {
    expect(isLeaseLive(fresh, { nowMs: now })).toBe(true); // us
    expect(isLeaseLive({ ...fresh, pid: DEAD_PID, startTime: null }, { nowMs: now })).toBe(false);
    expect(isLeaseLive({ ...fresh, startTime: 'proc:1' }, { nowMs: now })).toBe(false); // reused pid
    expect(isLeaseLive({ ...fresh, startTime: undefined }, { nowMs: now })).toBe(true); // pid-only
    expect(isLeaseLive({ ...fresh, pid: 0 }, { nowMs: now })).toBe(true); // unknown pid ⇒ expiry only
    expect(isLeaseLive(expired, { nowMs: now })).toBe(false);
  });

  test('with a runner, lease.pid is informational (a dead parent pid does not matter)', () => {
    const parentLease = { ...fresh, pid: DEAD_PID, startTime: null };
    expect(isLeaseLive(parentLease, { nowMs: now, runner: self() })).toBe(true);
  });

  test('classifyOwnerLiveness uses runner / legacy marker', () => {
    expect(classifyOwnerLiveness({ status: 'running', lease: fresh, runner: runnerOf(self()) })).toBe('live');
    expect(
      classifyOwnerLiveness({ status: 'running', lease: fresh, runner: runnerOf({ pid: DEAD_PID, startTime: null }) }),
    ).toBe('expired');
    expect(classifyOwnerLiveness({ status: 'running', lease: fresh, legacyRunnerTmux: 'orc-wf-x' })).toBe('expired');
    expect(classifyOwnerLiveness({ status: 'running', lease: undefined })).toBe('unknown');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('reconcileRun (no driver: process identity)', () => {
  beforeEach(() => freshHome());

  async function persisted(over: Partial<WorkflowRun>): Promise<WorkflowRun> {
    await writeRun(baseRun(over));
    return (await readRun(over.id ?? 'r1'))!;
  }

  test('running + dead runner → orphaned (persisted)', async () => {
    const run = await persisted({ runner: runnerOf({ pid: DEAD_PID, startTime: null }), lease: makeLease() });
    expect((await reconcileRun(run)).status).toBe('orphaned');
    expect((await readRun('r1'))!.status).toBe('orphaned');
  });

  test('running + live runner + fresh lease → running (no write)', async () => {
    const run = await persisted({ runner: runnerOf(self()), lease: makeLease() });
    const out = await reconcileRun(run);
    expect(out.status).toBe('running');
    expect((await readRun('r1'))!.revision).toBe(run.revision);
  });

  test('running + live runner + EXPIRED lease → orphaned (expiry dominates)', async () => {
    const run = await persisted({
      runner: runnerOf(self()),
      lease: makeLease({ nowMs: Date.now() - 120_000, leaseMs: 1_000 }),
    });
    expect((await reconcileRun(run)).status).toBe('orphaned');
  });

  test('running + runner pid reused (start-time mismatch) → orphaned', async () => {
    const run = await persisted({ runner: runnerOf({ pid: process.pid, startTime: 'proc:1' }), lease: makeLease() });
    expect((await reconcileRun(run)).status).toBe('orphaned');
  });

  test('no runner and no lease → trusted running', async () => {
    const run = await persisted({});
    expect((await reconcileRun(run)).status).toBe('running');
  });

  test('a record that changed since it was judged is not clobbered', async () => {
    const stale = await persisted({ runner: runnerOf({ pid: DEAD_PID, startTime: null }), lease: makeLease() });
    // A live owner re-stamps the record (new revision) before the reconcile write lands.
    await writeRunOwned({ ...stale, runner: runnerOf(self()), lease: makeLease() });
    const out = await reconcileRun(stale);
    expect(out.status).toBe('running');
    expect((await readRun('r1'))!.status).toBe('running');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('runner heartbeat (D1)', () => {
  beforeEach(() => freshHome());

  for (const mode of ['foreground (lease identity)', 'detached (runner identity)'] as const) {
    test(
      `${mode}: a blocked step stays live across > 2× leaseMs`,
      async () => {
        const leaseMs = 300;
        const { exec, started, release } = blockingExec();
        const runId = mode.startsWith('detached') ? 'hbrunner' : 'hbfg';
        const runner = mode.startsWith('detached') ? runnerOf(self(), runId) : undefined;
        const t0 = Date.now();
        const p = runWorkflow(oneStep, { runId, execStep: exec, leaseMs, runner });
        await started;
        const expiries = new Set<string>();
        while (Date.now() - t0 < 2.5 * leaseMs) {
          const disk = (await readRun(runId))!;
          expiries.add(disk.lease!.expiresAt);
          const rec = await reconcileRun(disk);
          expect(rec.status).toBe('running');
          await Bun.sleep(40);
        }
        expect(expiries.size).toBeGreaterThanOrEqual(3); // renewed on the timer, not by transitions
        release();
        const run = await p;
        expect(run.status).toBe('done');
        // The heartbeat never outlives the run.
        const rev = (await readRun(runId))!.revision;
        await Bun.sleep(250);
        expect((await readRun(runId))!.revision).toBe(rev);
      },
      10_000,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('abort (SIGTERM path) and cancel', () => {
  beforeEach(() => freshHome());

  test('abort returns promptly without writing; a running record is left to reconcile', async () => {
    const { exec, started, release } = blockingExec();
    const ac = new AbortController();
    const p = runWorkflow(oneStep, { runId: 'ab1', execStep: exec, signal: ac.signal, leaseMs: 300 });
    await started;
    const before = (await readRun('ab1'))!;
    ac.abort();
    const t0 = Date.now();
    const out = await p;
    expect(Date.now() - t0).toBeLessThan(1_000); // does not wait for the blocked step
    expect(out.status).toBe('running');
    await Bun.sleep(400); // > heartbeat period: the heartbeat is gone too
    const after = (await readRun('ab1'))!;
    expect(after.revision).toBeLessThanOrEqual((before.revision ?? 0) + 1);
    expect(after.status).toBe('running');
    release();
  }, 10_000);

  test('cancel then abort: cancelled stays cancelled; no further writes', async () => {
    const { exec, started, release } = blockingExec();
    const ac = new AbortController();
    const p = runWorkflow(oneStep, { runId: 'ab2', execStep: exec, signal: ac.signal, leaseMs: 300 });
    await started;
    const cancelled = await cancelWorkflow('ab2');
    expect(cancelled.status).toBe('cancelled');
    ac.abort();
    const out = await p;
    expect(out.status).toBe('cancelled');
    release();
    await Bun.sleep(300);
    const disk = (await readRun('ab2'))!;
    expect(disk.status).toBe('cancelled');
    expect(disk.revision).toBe(cancelled.revision);
  }, 10_000);

  test('abort while draining in-flight steps after a noticed cancel still returns promptly', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    const started = new Set<string>();
    const exec: StepExecutor = async ({ step }) => {
      started.add(step.id);
      await (step.id === 'a' ? gateA : gateB);
      return okResult(step.id);
    };
    const def: WorkflowDef = {
      name: 'two',
      maxConcurrency: 2,
      steps: [
        { id: 'a', provider: 'claude', prompt: 'x' },
        { id: 'b', provider: 'claude', prompt: 'x' },
      ],
    };
    const ac = new AbortController();
    const p = runWorkflow(def, { runId: 'ab3', execStep: exec, signal: ac.signal });
    await waitFor(() => started.size === 2, 5_000, 'both steps in flight');
    await cancelWorkflow('ab3');
    releaseA(); // the runner notices the cancel and starts draining `b` (blocked)
    await Bun.sleep(150);
    ac.abort();
    const t0 = Date.now();
    const out = await p;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.status).toBe('cancelled');
    releaseB();
  }, 10_000);

  test('an owning write never overwrites cancelled (runner finishing during cancel)', async () => {
    await writeRun(baseRun({ id: 'cx', status: 'cancelled' }));
    await expect(writeRunOwned(baseRun({ id: 'cx', status: 'done' }))).rejects.toBeInstanceOf(FinalizedRunError);
    await expect(writeRunOwned(baseRun({ id: 'cx', status: 'failed' }))).rejects.toBeInstanceOf(FinalizedRunError);
    expect((await readRun('cx'))!.status).toBe('cancelled');
  });

  test('a step completing after cancel returns the cancelled record', async () => {
    const { exec, started, release } = blockingExec();
    const p = runWorkflow(oneStep, { runId: 'cx2', execStep: exec });
    await started;
    await cancelWorkflow('cx2');
    release();
    expect((await p).status).toBe('cancelled');
    expect((await readRun('cx2'))!.status).toBe('cancelled');
  }, 10_000);
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('assertRecoveryAllowed / stampRunner', () => {
  beforeEach(() => freshHome());

  test('preconditions mirror the foreground paths', () => {
    expect(() => assertRecoveryAllowed(baseRun({ status: 'done' }), 'resume')).toThrow(FinalizedRunError);
    expect(() => assertRecoveryAllowed(baseRun({ status: 'done' }), 'retry')).toThrow(FinalizedRunError);
    expect(() => assertRecoveryAllowed(baseRun({ status: 'cancelled' }), 'resume')).toThrow(/cancelled/);
    expect(() => assertRecoveryAllowed(baseRun({ status: 'cancelled' }), 'retry')).not.toThrow();
    expect(() => assertRecoveryAllowed(baseRun({ status: 'running' }), 'retry')).toThrow(LiveOwnerError);
    for (const s of ['failed', 'orphaned'] as const) {
      expect(() => assertRecoveryAllowed(baseRun({ status: s }), 'resume')).not.toThrow();
    }
  });

  test('stampRunner: reopens failed with runner-identity lease; idempotent for the same runner', async () => {
    await writeRun(baseRun({ id: 'st1', status: 'failed', finishedAt: 'x', lease: makeLease() }));
    const runner = runnerOf({ pid: DEAD_PID, startTime: 'proc:7' }, 'st1');
    const stamped = await stampRunner('st1', runner);
    expect(stamped.status).toBe('running');
    expect(stamped.finishedAt).toBeUndefined();
    expect(stamped.runner).toEqual(runner);
    expect(stamped.lease).toMatchObject({ pid: DEAD_PID, startTime: 'proc:7' });
    const again = await stampRunner('st1', runner);
    expect(again.revision).toBe(stamped.revision); // the runner already stamped itself → no write
  });

  test('stampRunner refuses done / cancelled-resume / a different live runner', async () => {
    await writeRun(baseRun({ id: 'st2', status: 'done' }));
    await expect(stampRunner('st2', runnerOf(self(), 'st2'))).rejects.toBeInstanceOf(FinalizedRunError);
    await writeRun(baseRun({ id: 'st3', status: 'cancelled' }));
    await expect(stampRunner('st3', runnerOf(self(), 'st3'))).rejects.toBeInstanceOf(FinalizedRunError);
    const reopened = await stampRunner('st3', runnerOf({ pid: DEAD_PID, startTime: null }, 'st3'), {
      allowCancelled: true,
    });
    expect(reopened.status).toBe('running');
    await writeRun(baseRun({ id: 'st4', runner: runnerOf(self(), 'st4'), lease: makeLease() }));
    await expect(stampRunner('st4', runnerOf({ pid: DEAD_PID, startTime: null }, 'st4'))).rejects.toBeInstanceOf(
      LiveOwnerError,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('owner fence: a different live owner is never overwritten', () => {
  beforeEach(() => freshHome());
  /** Another LIVE process (our parent: the shell running bun test). */
  const other = (): ProcessIdentity => ({ pid: process.ppid, startTime: processStartTime(process.ppid) });

  test('stored runner is another live process → LiveOwnerError (with or without our runner)', async () => {
    expect(isSameProcessAlive(other())).toBe(true);
    await writeRun(baseRun({ id: 'f1', runner: runnerOf(other(), 'f1'), lease: makeLease() }));
    const before = fs.readFileSync(runPath('f1'), 'utf8');
    await expect(
      writeRunOwned(baseRun({ id: 'f1', runner: runnerOf(self(), 'f1'), lease: makeLease() })),
    ).rejects.toBeInstanceOf(LiveOwnerError);
    await expect(writeRunOwned(baseRun({ id: 'f1', lease: makeLease() }))).rejects.toBeInstanceOf(LiveOwnerError);
    expect(fs.readFileSync(runPath('f1'), 'utf8')).toBe(before);
  });

  test('stored runner dead → the new owner may write', async () => {
    await writeRun(baseRun({ id: 'f2', runner: runnerOf({ pid: DEAD_PID, startTime: null }, 'f2') }));
    const w = await writeRunOwned(baseRun({ id: 'f2', runner: runnerOf(self(), 'f2'), lease: makeLease() }));
    expect(w.runner?.pid).toBe(process.pid);
  });

  test('null start time on either side is a wildcard (pid match = same runner)', async () => {
    const o = other();
    await writeRun(baseRun({ id: 'f3', runner: runnerOf({ pid: o.pid, startTime: null }, 'f3') }));
    await writeRunOwned(baseRun({ id: 'f3', runner: runnerOf(o, 'f3'), lease: makeLease() }));
    await writeRun(baseRun({ id: 'f4', runner: runnerOf(o, 'f4') }));
    await writeRunOwned(baseRun({ id: 'f4', runner: runnerOf({ pid: o.pid, startTime: null }, 'f4') }));
    // stampRunner treats it as the runner already stamped → no write.
    await writeRun(baseRun({ id: 'f5', status: 'failed', runner: runnerOf({ pid: DEAD_PID, startTime: null }, 'f5') }));
    const rev = (await readRun('f5'))!.revision;
    const same = await stampRunner('f5', runnerOf({ pid: DEAD_PID, startTime: 'proc:9' }, 'f5'));
    expect(same.revision).toBe(rev);
    expect(same.status).toBe('failed');
  });

  test('no stored runner: a LIVE lease with a different ownerId → LiveOwnerError', async () => {
    const o = other();
    const live = makeLease({ ownerId: 'A', pid: o.pid, startTime: o.startTime });
    await writeRun(baseRun({ id: 'f6', lease: live }));
    await expect(
      writeRunOwned(baseRun({ id: 'f6', lease: makeLease({ ownerId: 'B' }) })),
    ).rejects.toBeInstanceOf(LiveOwnerError);
    await writeRunOwned(baseRun({ id: 'f6', lease: makeLease({ ownerId: 'A' }) })); // same owner
    // Expired or dead-owner leases are no fence.
    await writeRun(baseRun({ id: 'f7', lease: { ...live, expiresAt: new Date(Date.now() - 1).toISOString() } }));
    await writeRunOwned(baseRun({ id: 'f7', lease: makeLease({ ownerId: 'B' }) }));
    await writeRun(baseRun({ id: 'f8', lease: makeLease({ ownerId: 'A', pid: DEAD_PID }) }));
    await writeRunOwned(baseRun({ id: 'f8', lease: makeLease({ ownerId: 'B' }) }));
  });

  test('in-process resume uses one owner id for the recovery stamp and the run', async () => {
    let fail = true;
    const exec: StepExecutor = async ({ step }) => ({ ...okResult(step.id), ok: !fail });
    const first = await runWorkflow(oneStep, { runId: 'f9', execStep: exec });
    expect(first.status).toBe('failed');
    fail = false;
    const { resumeWorkflow } = await import('../src/workflow.ts');
    const resumed = await resumeWorkflow('f9', oneStep, { execStep: exec });
    expect(resumed.status).toBe('done');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('awaitRunnerHandoff', () => {
  beforeEach(() => freshHome());

  test('true once stamped as this process; false without a record; false at timeout', async () => {
    expect(await awaitRunnerHandoff('h0', { timeoutMs: 50 })).toBe(false); // no record
    await writeRun(baseRun({ id: 'h1', lease: makeLease() }));
    const t0 = Date.now();
    expect(await awaitRunnerHandoff('h1', { timeoutMs: 120, pollMs: 10 })).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    const waiting = awaitRunnerHandoff('h1', { timeoutMs: 3_000, pollMs: 10 });
    await Bun.sleep(60);
    await stampRunner('h1', runnerOf(self(), 'h1'));
    expect(await waiting).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('launch helpers (injected spawner): spawn first, then stamp (D7)', () => {
  beforeEach(() => freshHome());

  type Call = { argv: string[]; opts: SpawnDetachedOptions };
  function fakeSpawner(calls: Call[], id: ProcessIdentity = { pid: DEAD_PID, startTime: 'proc:42' }) {
    return (argv: string[], opts: SpawnDetachedOptions): ProcessIdentity => {
      calls.push({ argv, opts });
      return id;
    };
  }
  const failingSpawner = (calls: Call[]) => (argv: string[], opts: SpawnDetachedOptions): ProcessIdentity => {
    calls.push({ argv, opts });
    throw new Error('EAGAIN: fork failed');
  };

  test('detached run: argv/env/log path, record stamped with the runner', async () => {
    const calls: Call[] = [];
    const launch = await launchDetachedRun(oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls), maxConcurrency: 2 });
    expect(calls).toHaveLength(1);
    const { argv, opts } = calls[0]!;
    expect(argv).toEqual([...selfArgv(), 'workflow', 'run', '/abs/wf.ts', '--run-id', launch.runId, '--max-concurrency', '2']);
    expect(opts.logPath).toBe(runnerLogPath(launch.runId));
    expect(opts.env?.ORC_HOME).toBe(process.env.ORC_HOME);
    expect(opts.env?.PATH).toBe(process.env.PATH); // full env (spawnDetached does not merge)
    expect(opts.env?.ORC_ROOT_RUN_ID).toBe(launch.runId); // lineage env for the runner
    const rec = (await readRun(launch.runId))!;
    expect(rec.status).toBe('running');
    expect(rec.runner).toMatchObject({ pid: DEAD_PID, startTime: 'proc:42', logPath: launch.logPath });
    expect(rec.lease?.pid).toBe(DEAD_PID);
  });

  test('detached run: spawn failure finalizes the pre-written record as failed', async () => {
    const calls: Call[] = [];
    await expect(launchDetachedRun(oneStep, '/abs/wf.ts', { spawn: failingSpawner(calls) })).rejects.toBeInstanceOf(
      RunnerSpawnError,
    );
    const runId = calls[0]!.argv[calls[0]!.argv.indexOf('--run-id') + 1]!;
    const rec = (await readRun(runId))!;
    expect(rec.status).toBe('failed');
    expect(rec.runner).toBeUndefined();
  });

  test('detached resume: spawn failure leaves the record byte-identical', async () => {
    await writeRun(baseRun({ id: 'rs1', status: 'orphaned', lease: makeLease() }));
    const before = fs.readFileSync(runPath('rs1'), 'utf8');
    const calls: Call[] = [];
    await expect(
      launchDetachedRecovery('resume', 'rs1', oneStep, '/abs/wf.ts', { spawn: failingSpawner(calls) }),
    ).rejects.toBeInstanceOf(RunnerSpawnError);
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(runPath('rs1'), 'utf8')).toBe(before);
  });

  test('detached retry: argv carries --step and --runner; cancelled run reopened after spawn', async () => {
    await writeRun(baseRun({ id: 'rt1', status: 'cancelled', cancelledAt: 'x', finishedAt: 'x' }));
    const calls: Call[] = [];
    const launch = await launchDetachedRecovery('retry', 'rt1', oneStep, '/abs/wf.ts', {
      spawn: fakeSpawner(calls),
      stepId: 'a',
    });
    expect(calls[0]!.argv).toEqual([...selfArgv(), 'workflow', 'retry', 'rt1', '/abs/wf.ts', '--step', 'a', '--runner']);
    expect(launch).toMatchObject({ runId: 'rt1', action: 'retry', logPath: runnerLogPath('rt1') });
    const rec = (await readRun('rt1'))!;
    expect(rec.status).toBe('running');
    expect(rec.cancelledAt).toBeUndefined();
    expect(rec.runner?.pid).toBe(DEAD_PID);
  });

  test('detached resume/retry with a mismatched definition is rejected before any spawn', async () => {
    await writeRun(baseRun({ id: 'dg1', status: 'failed', definitionDigest: 'not-this-plan' }));
    await writeRun(baseRun({ id: 'dg2', status: 'failed' }));
    const before = fs.readFileSync(runPath('dg1'), 'utf8');
    const calls: Call[] = [];
    await expect(
      launchDetachedRecovery('resume', 'dg1', oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls) }),
    ).rejects.toThrow(/digest mismatch/);
    await expect(
      launchDetachedRecovery('retry', 'dg2', oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls), stepId: 'zz' }),
    ).rejects.toThrow(/no step 'zz'/);
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(runPath('dg1'), 'utf8')).toBe(before);
  });

  test('detached resume/retry on a done run is rejected before any spawn', async () => {
    await writeRun(baseRun({ id: 'dn1', status: 'done' }));
    const before = fs.readFileSync(runPath('dn1'), 'utf8');
    for (const action of ['resume', 'retry'] as const) {
      const calls: Call[] = [];
      await expect(
        launchDetachedRecovery(action, 'dn1', oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls) }),
      ).rejects.toBeInstanceOf(FinalizedRunError);
      expect(calls).toHaveLength(0);
    }
    expect(fs.readFileSync(runPath('dn1'), 'utf8')).toBe(before);
  });

  test('detached resume over a live owner / of a cancelled run is rejected before any spawn', async () => {
    await writeRun(baseRun({ id: 'lv1', runner: runnerOf(self(), 'lv1'), lease: makeLease() }));
    await writeRun(baseRun({ id: 'cn1', status: 'cancelled' }));
    const calls: Call[] = [];
    await expect(
      launchDetachedRecovery('resume', 'lv1', oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls) }),
    ).rejects.toBeInstanceOf(LiveOwnerError);
    await expect(
      launchDetachedRecovery('resume', 'cn1', oneStep, '/abs/wf.ts', { spawn: fakeSpawner(calls) }),
    ).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('daemon detached routes (injected spawner)', () => {
  beforeEach(() => freshHome());
  const servers: Bun.Server<undefined>[] = [];
  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  function start(spawnRunner: (argv: string[], opts: SpawnDetachedOptions) => ProcessIdentity) {
    const s = serveDaemon({
      hostname: '127.0.0.1',
      port: 0,
      secret: 'sekrit',
      allowlist: [],
      whois: async () => null,
      version: 'test',
      hostName: 'testhost',
      spawnRunner,
    });
    servers.push(s);
    return (p: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${s.port}${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-orc-secret': 'sekrit', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  }

  test('POST resume {detach}: spawn failure → 500 and the record is unchanged', async () => {
    await writeRun(baseRun({ id: 'dr1', status: 'failed', lease: makeLease(), sourcePath: POLICY_FAIL_WF }));
    const before = fs.readFileSync(runPath('dr1'), 'utf8');
    let calls = 0;
    const call = start(() => {
      calls++;
      throw new Error('spawn exploded');
    });
    const res = await call('/workflows/runs/dr1/resume', { detach: true, file: POLICY_FAIL_WF });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/failed to launch detached resume: spawn exploded/);
    expect(calls).toBe(1);
    expect(fs.readFileSync(runPath('dr1'), 'utf8')).toBe(before);
  });

  test('POST resume/retry {detach} on a done run → 409 and nothing spawned', async () => {
    await writeRun(baseRun({ id: 'dd1', status: 'done', sourcePath: POLICY_FAIL_WF }));
    const before = fs.readFileSync(runPath('dd1'), 'utf8');
    let calls = 0;
    const call = start(() => {
      calls++;
      return { pid: DEAD_PID, startTime: null };
    });
    for (const action of ['resume', 'retry']) {
      const res = await call(`/workflows/runs/dd1/${action}`, { detach: true, file: POLICY_FAIL_WF });
      expect(res.status).toBe(409);
    }
    expect(calls).toBe(0);
    expect(fs.readFileSync(runPath('dd1'), 'utf8')).toBe(before);
  });

  test('POST resume {detach} success → {runId, logPath, action}; view exposes runner, no host path', async () => {
    await writeRun(baseRun({ id: 'ds1', status: 'orphaned', sourcePath: POLICY_FAIL_WF }));
    const argvs: string[][] = [];
    const call = start((argv) => {
      argvs.push(argv);
      return { pid: DEAD_PID, startTime: 'proc:5' };
    });
    const res = await call('/workflows/runs/ds1/resume', { detach: true, file: POLICY_FAIL_WF });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'ds1', logPath: runnerLogPath('ds1'), action: 'resume' });
    expect(argvs[0]).toEqual([...selfArgv(), 'workflow', 'resume', 'ds1', POLICY_FAIL_WF, '--runner']);
    const view = (await (await call('/workflows/runs/ds1')).json()) as Record<string, unknown>;
    expect(view.runner).toMatchObject({ pid: DEAD_PID });
    expect(JSON.stringify(view)).not.toContain('runner.log');
    expect(JSON.stringify(view)).not.toContain('runnerTmux');
  });

  test('POST /workflows/run {detach}: a post-validation failure (stamp race) → 500, not 400', async () => {
    const call = start((argv) => {
      // The run is finalized underneath the launcher before it can stamp the runner.
      const runId = argv[argv.indexOf('--run-id') + 1]!;
      const rec = JSON.parse(fs.readFileSync(runPath(runId), 'utf8'));
      fs.writeFileSync(runPath(runId), JSON.stringify({ ...rec, status: 'done' }));
      return { pid: DEAD_PID, startTime: null };
    });
    const res = await call('/workflows/run', { detach: true, file: POLICY_FAIL_WF });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/finalized \(done\)/);
  });

  test('POST /workflows/run {detach}: spawn failure → 500 and the run is finalized failed', async () => {
    const call = start(() => {
      throw new Error('nope');
    });
    const res = await call('/workflows/run', { detach: true, file: POLICY_FAIL_WF });
    expect(res.status).toBe(500);
    const runs = fs.readdirSync(path.join(process.env.ORC_HOME!, 'runs')).filter((f) => f.endsWith('.json'));
    expect(runs).toHaveLength(1);
    expect((await readRun(runs[0]!.slice(0, -5)))!.status).toBe('failed');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('real detached runner processes', () => {
  beforeEach(() => freshHome());

  /** Spawn the blocking SDK runner fixture exactly as the launch helpers spawn the CLI. */
  async function startBlockingRunner(runId: string, leaseMs: number): Promise<ProcessIdentity> {
    const id = spawnDetached([process.execPath, BLOCKING_RUNNER, runId, String(leaseMs)], {
      cwd: home,
      env: { ...process.env, ORC_HOME: process.env.ORC_HOME },
      logPath: runnerLogPath(runId),
    });
    spawned.push(id);
    await waitFor(
      async () => {
        const r = await readRun(runId);
        return r?.runner?.pid === id.pid && r.attempts?.some((a) => a.phase === 'spawning');
      },
      10_000,
      'runner stamped and blocked in its step',
    );
    return id;
  }

  test(
    'cancel → the live runner gets SIGTERM, exits via its handler; status stays cancelled',
    async () => {
      const leaseMs = 600;
      const id = await startBlockingRunner('rc1', leaseMs);
      // Cross-process heartbeat: still live after > 2× leaseMs while blocked.
      await Bun.sleep(2.2 * leaseMs);
      expect((await reconcileRun((await readRun('rc1'))!)).status).toBe('running');

      const cancelled = await cancelWorkflow('rc1');
      expect(cancelled.status).toBe('cancelled');
      await waitFor(() => !isPidAlive(id.pid), 4_000, 'runner exit after SIGTERM');
      const log = fs.readFileSync(runnerLogPath('rc1'), 'utf8');
      expect(log).toContain('exit aborted cancelled'); // graceful path, not the force-exit backstop
      await Bun.sleep(300);
      const disk = (await readRun('rc1'))!;
      expect(disk.status).toBe('cancelled');
      expect(disk.revision).toBe(cancelled.revision);
    },
    20_000,
  );

  test(
    'SIGSTOP past the lease, superseded by a new runner, SIGCONT: the stale runner cannot overwrite it',
    async () => {
      const leaseMs = 400;
      const r1 = await startBlockingRunner('ss1', leaseMs);
      process.kill(r1.pid, 'SIGSTOP');
      try {
        await waitFor(
          async () => (await reconcileRun((await readRun('ss1'))!)).status === 'orphaned',
          5_000,
          'stopped R1 orphaned after lease expiry',
        );
        expect(isSameProcessAlive(r1)).toBe(true); // stopped, not dead
        const stamped = await stampRunner('ss1', runnerOf(self(), 'ss1')); // R2 takes over
        expect(stamped.status).toBe('running');
      } finally {
        process.kill(r1.pid, 'SIGCONT');
      }
      // R1's next heartbeat hits the owner fence → it stops writing and exits.
      await waitFor(() => !isPidAlive(r1.pid), 5_000, 'superseded R1 exits');
      const disk = (await readRun('ss1'))!;
      expect(disk.status).toBe('running');
      expect(disk.runner?.pid).toBe(process.pid);
      expect(disk.lease?.pid).toBe(process.pid);
      expect(fs.readFileSync(runnerLogPath('ss1'), 'utf8')).toContain('exit finished running');
    },
    20_000,
  );

  test(
    'trapRunnerTermination.dispose() clears the force-exit backstop',
    async () => {
      const mod = path.resolve(import.meta.dir, '..', 'src', 'workflow-runner.ts');
      const script = [
        `import { trapRunnerTermination } from ${JSON.stringify(mod)};`,
        `const t = trapRunnerTermination({ forceExitMs: 100 });`,
        `process.kill(process.pid, 'SIGTERM');`,
        `while (!t.signal.aborted) await Bun.sleep(5);`,
        `t.dispose();`,
        `await Bun.sleep(400);`,
        `console.log('alive');`,
      ].join('\n');
      const p = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(code).toBe(0);
      expect(out).toContain('alive');
    },
    10_000,
  );

  test(
    'SIGTERM without cancel: the runner exits without writing; the run reconciles to orphaned',
    async () => {
      const id = await startBlockingRunner('rk1', 60_000);
      const before = (await readRun('rk1'))!;
      process.kill(id.pid, 'SIGTERM');
      await waitFor(() => !isPidAlive(id.pid), 4_000, 'runner exit after SIGTERM');
      expect(fs.readFileSync(runnerLogPath('rk1'), 'utf8')).toContain('exit aborted running');
      const after = (await readRun('rk1'))!;
      expect(after.revision).toBe(before.revision);
      expect((await reconcileRun(after)).status).toBe('orphaned');
    },
    20_000,
  );

  test(
    'followRunnerLog prints the log and stops once the run is final and the runner gone',
    async () => {
      const id = await startBlockingRunner('fl1', 60_000);
      let out = '';
      const following = followRunnerLog('fl1', { write: (t) => (out += t), pollMs: 25 });
      await waitFor(() => out.includes('event run-start'), 5_000, 'existing log content');
      await cancelWorkflow('fl1');
      const last = await following;
      expect(last?.status).toBe('cancelled');
      expect(isSameProcessAlive(id)).toBe(false); // follow stops only once the runner is gone
      await waitFor(() => !isPidAlive(id.pid), 4_000, 'runner reaped');
      expect(out).toContain('exit aborted cancelled'); // drained after the runner exited
    },
    20_000,
  );

  test('followRunnerLog refuses a run without a runner log', async () => {
    await writeRun(baseRun({ id: 'nf1' }));
    await expect(followRunnerLog('nf1')).rejects.toThrow(/no runner log/);
    await writeRun(baseRun({ id: 'nf2', status: 'failed', legacyRunnerTmux: 'orc-wf-nf2' }));
    // The marker is never persisted, so a re-read legacy record is a plain no-runner run.
    await expect(followRunnerLog('nf2')).rejects.toThrow(/no runner log/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
describe('CLI end-to-end (real detached runner, no agent)', () => {
  beforeEach(() => freshHome());

  async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const p = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: home,
      env: { ...process.env, ORC_HOME: process.env.ORC_HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  }

  async function settled(runId: string, notPid?: number): Promise<WorkflowRun> {
    return waitFor(
      async () => {
        const r = await readRun(runId);
        if (!r?.runner || r.runner.pid === notPid) return null;
        spawned.push(r.runner);
        return r.status !== 'running' && !isSameProcessAlive(r.runner) ? r : null;
      },
      15_000,
      `run ${runId} finalized by its runner`,
    );
  }

  test(
    'workflow run --detach → runner process → attach; then detached resume and retry',
    async () => {
      const launched = await cli(['workflow', 'run', POLICY_FAIL_WF, '--detach', '--json']);
      expect(launched.code).toBe(0);
      const { runId, logPath } = JSON.parse(launched.stdout) as { runId: string; logPath: string };
      expect(logPath).toBe(runnerLogPath(runId));
      expect(launched.stdout).not.toContain('runnerTmux');

      const first = await settled(runId);
      expect(first.status).toBe('failed'); // policy refused the agent spawn — no agent ran
      expect(first.lease?.pid).toBe(first.runner!.pid); // the runner re-stamped its own identity
      expect((fs.statSync(logPath).mode & 0o777).toString(8)).toBe('600');
      const log1 = fs.readFileSync(logPath, 'utf8');
      expect(log1).toContain(`# orc runner pid=${first.runner!.pid} action=run run=${runId}`);
      expect(log1).toContain(`= run ${runId} failed`);
      expect((await reconcileRun(first)).status).toBe('failed');

      const attach = await cli(['workflow', 'attach', runId]);
      expect(attach.code).toBe(0);
      expect(attach.stdout).toContain(`= run ${runId} failed`);
      expect(attach.stderr).toContain(`# run ${runId} failed`);
      const attachJson = await cli(['workflow', 'attach', runId, '--json']);
      expect(JSON.parse(attachJson.stdout)).toMatchObject({ runId, logPath, runner: { pid: first.runner!.pid } });

      const status = await cli(['workflow', 'status', runId]);
      expect(status.stdout).toContain(`runner:     pid=${first.runner!.pid}`);

      const resumed = await cli(['workflow', 'resume', runId, POLICY_FAIL_WF, '--detach', '--json']);
      expect(resumed.code).toBe(0);
      expect(JSON.parse(resumed.stdout)).toEqual({ runId, logPath, action: 'resume' });
      const second = await settled(runId, first.runner!.pid);
      expect(second.status).toBe('failed');

      const retried = await cli(['workflow', 'retry', runId, POLICY_FAIL_WF, '--step', 'a', '--detach', '--json']);
      expect(retried.code).toBe(0);
      const third = await settled(runId, second.runner!.pid);
      expect(third.status).toBe('failed');
      expect(third.attempts?.filter((a) => a.stepId === 'a')).toHaveLength(3);

      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain(`action=resume run=${runId}`);
      expect(log).toContain(`action=retry run=${runId}`);
    },
    45_000,
  );

  test(
    'detached resume/retry of a done run is rejected and nothing is spawned',
    async () => {
      await writeRun(baseRun({ id: 'cdone', status: 'done', sourcePath: POLICY_FAIL_WF }));
      const before = fs.readFileSync(runPath('cdone'), 'utf8');
      for (const action of ['resume', 'retry']) {
        const r = await cli(['workflow', action, 'cdone', POLICY_FAIL_WF, '--detach', '--json']);
        expect(r.code).toBe(1);
        expect(r.stdout + r.stderr).toMatch(/finalized \(done\)/);
      }
      expect(fs.readFileSync(runPath('cdone'), 'utf8')).toBe(before);
      expect(fs.existsSync(runnerLogPath('cdone'))).toBe(false);
    },
    20_000,
  );

  test('workflow attach on a run without a runner errors', async () => {
    await writeRun(baseRun({ id: 'cfg1', status: 'done' }));
    const r = await cli(['workflow', 'attach', 'cfg1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no runner log/);
  }, 15_000);
});
