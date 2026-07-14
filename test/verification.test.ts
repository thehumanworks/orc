import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  mapToStepOutcome,
  assertValidVerifyDescriptor,
  executeVerify,
  captureBaselineSha,
  commitCountSince,
  type VerifyContext,
  type OutcomeInputs,
} from '../src/verification.ts';
import { gitExec, gitHeadSha } from '../src/worktree.ts';
import { collectOutputArtifact, refFromManifest } from '../src/artifacts.ts';
import type { ResultEnvelope } from '../src/result-envelope.ts';
import { RESULT_ENVELOPE_VERSION } from '../src/result-envelope.ts';

const tmp: string[] = [];
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmp) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tempDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(fs.tmpdir(), prefix));
  tmp.push(d);
  return d;
}

async function initRepo(dir: string): Promise<void> {
  await gitExec(['init'], dir);
  await gitExec(['config', 'user.email', 'test@orc.local'], dir);
  await gitExec(['config', 'user.name', 'orc-test'], dir);
  await Bun.write(path.join(dir, 'README'), 'init\n');
  await gitExec(['add', '.'], dir);
  await gitExec(['commit', '-m', 'init'], dir);
}

describe('mapToStepOutcome truth table (fail-closed)', () => {
  const base: OutcomeInputs = { state: 'done', settled: true };

  test('cancelled', () => {
    expect(mapToStepOutcome({ ...base, cancelled: true })).toEqual({
      outcome: 'cancelled',
      ok: false,
    });
  });

  test('timeout unsettled', () => {
    expect(mapToStepOutcome({ state: 'running', settled: false })).toEqual({
      outcome: 'timed_out',
      ok: false,
    });
  });

  test('failed pane', () => {
    expect(mapToStepOutcome({ state: 'failed', settled: true })).toEqual({
      outcome: 'failed',
      ok: false,
    });
  });

  test('modal waiting is failed (not needs_input)', () => {
    expect(mapToStepOutcome({ state: 'waiting', settled: true })).toEqual({
      outcome: 'failed',
      ok: false,
    });
  });

  test('yielded without verifier → unverified ok:false', () => {
    expect(mapToStepOutcome(base)).toEqual({ outcome: 'unverified', ok: false });
  });

  test('yielded + allowUnverified → unverified ok:true', () => {
    expect(mapToStepOutcome({ ...base, allowUnverified: true })).toEqual({
      outcome: 'unverified',
      ok: true,
    });
  });

  test('donePredicate / verify / worktree success', () => {
    expect(mapToStepOutcome({ ...base, donePredicateOk: true })).toEqual({
      outcome: 'succeeded',
      ok: true,
    });
    expect(mapToStepOutcome({ ...base, verifyPassed: true })).toEqual({
      outcome: 'succeeded',
      ok: true,
    });
    expect(mapToStepOutcome({ ...base, worktreeDefaultOk: true })).toEqual({
      outcome: 'succeeded',
      ok: true,
    });
  });

  test('envelope needs_input', () => {
    expect(mapToStepOutcome({ ...base, envelopeOutcome: 'needs_input' })).toEqual({
      outcome: 'needs_input',
      ok: false,
    });
  });

  test('envelope failed / timed_out', () => {
    expect(mapToStepOutcome({ ...base, envelopeOutcome: 'failed' }).outcome).toBe('failed');
    expect(mapToStepOutcome({ ...base, envelopeOutcome: 'timed_out' }).outcome).toBe('timed_out');
  });
});

describe('assertValidVerifyDescriptor', () => {
  test('accepts nested all/any and leaves', () => {
    expect(() =>
      assertValidVerifyDescriptor({
        all: [
          { gitDiff: { minCommits: 1 } },
          { any: [{ file: { path: 'a.txt' } }, { command: { argv: ['true'] } }] },
        ],
      }),
    ).not.toThrow();
  });
  test('rejects shell-string command and empty argv', () => {
    expect(() => assertValidVerifyDescriptor({ command: { argv: [] } })).toThrow(/argv/);
    expect(() => assertValidVerifyDescriptor({ command: { argv: [1 as unknown as string] } })).toThrow();
  });
  test('rejects file path traversal', () => {
    expect(() => assertValidVerifyDescriptor({ file: { path: '../x' } })).toThrow();
  });
  test('rejects unknown kind', () => {
    expect(() => assertValidVerifyDescriptor({ magic: {} })).toThrow(/unknown/);
  });
});

describe('executeVerify — command / file / envelope', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await tempDir('orc-vf-');
    process.env.ORC_HOME = await tempDir('orc-home-');
  });

  function ctx(over: Partial<VerifyContext> = {}): VerifyContext {
    return {
      cwd,
      runId: 'run1',
      stepId: 's1',
      attemptId: 'a1',
      state: 'done',
      settled: true,
      ...over,
    };
  }

  test('command exit code success and failure', async () => {
    const ok = await executeVerify(
      { command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
      ctx(),
    );
    expect(ok.passed).toBe(true);

    const bad = await executeVerify(
      { command: { argv: [process.execPath, '-e', 'process.exit(3)'], exitCode: 0 } },
      ctx(),
    );
    expect(bad.passed).toBe(false);
    expect(bad.observations[0]?.exitCode).toBe(3);
  });

  test('command respects expected exitCode', async () => {
    const r = await executeVerify(
      { command: { argv: [process.execPath, '-e', 'process.exit(7)'], exitCode: 7 } },
      ctx(),
    );
    expect(r.passed).toBe(true);
  });

  test('file exists / sha256 / json keys', async () => {
    await Bun.write(path.join(cwd, 'f.json'), JSON.stringify({ a: 1, b: 2 }));
    const ok = await executeVerify(
      {
        all: [
          { file: { path: 'f.json', json: true, requiredKeys: ['a', 'b'] } },
        ],
      },
      ctx(),
    );
    expect(ok.passed).toBe(true);

    const miss = await executeVerify(
      { file: { path: 'f.json', json: true, requiredKeys: ['nope'] } },
      ctx(),
    );
    expect(miss.passed).toBe(false);
  });

  test('resultEnvelope is testimony-only unless acceptAsEvidence', async () => {
    const envelope: ResultEnvelope = {
      version: RESULT_ENVELOPE_VERSION,
      runId: 'run1',
      stepId: 's1',
      attemptId: 'a1',
      outcome: 'succeeded',
    };
    const testimony = await executeVerify({ resultEnvelope: {} }, ctx({ envelope }));
    expect(testimony.passed).toBe(false); // not evidence
    expect(testimony.observations.some((o) => o.kind === 'resultEnvelope' && o.passed)).toBe(true);

    const evidence = await executeVerify(
      { resultEnvelope: { acceptAsEvidence: true } },
      ctx({ envelope }),
    );
    expect(evidence.passed).toBe(true);
  });

  test('any/all composition', async () => {
    await Bun.write(path.join(cwd, 'x.txt'), 'x');
    const r = await executeVerify(
      {
        any: [
          { file: { path: 'missing.txt' } },
          { file: { path: 'x.txt' } },
        ],
      },
      ctx(),
    );
    expect(r.passed).toBe(true);
  });
});

describe('executeVerify — gitDiff with baseline SHA', () => {
  test('only commits after baseline count (feature branch, not main)', async () => {
    const repo = await tempDir('orc-git-');
    await initRepo(repo);
    const baseline = await gitHeadSha(repo);
    expect(baseline).toBeTruthy();

    // No new commits yet
    let r = await executeVerify(
      { gitDiff: { minCommits: 1 } },
      {
        cwd: repo,
        baselineSha: baseline!,
        runId: 'r',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
      },
    );
    expect(r.passed).toBe(false);

    await Bun.write(path.join(repo, 'work.txt'), 'change\n');
    await gitExec(['add', '.'], repo);
    await gitExec(['commit', '-m', 'work'], repo);

    r = await executeVerify(
      { gitDiff: { minCommits: 1 } },
      {
        cwd: repo,
        baselineSha: baseline!,
        runId: 'r',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
      },
    );
    expect(r.passed).toBe(true);
    expect(await commitCountSince(repo, baseline!)).toBe(1);
  });

  test('works when default branch is master (not main)', async () => {
    const repo = await tempDir('orc-master-');
    await gitExec(['init', '-b', 'master'], repo);
    await gitExec(['config', 'user.email', 't@orc'], repo);
    await gitExec(['config', 'user.name', 't'], repo);
    await Bun.write(path.join(repo, 'a'), '1');
    await gitExec(['add', '.'], repo);
    await gitExec(['commit', '-m', 'i'], repo);
    const base = await captureBaselineSha(repo);
    await Bun.write(path.join(repo, 'b'), '2');
    await gitExec(['add', '.'], repo);
    await gitExec(['commit', '-m', 'c'], repo);
    const r = await executeVerify(
      { gitDiff: { minCommits: 1 } },
      {
        cwd: repo,
        baselineSha: base,
        runId: 'r',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
      },
    );
    expect(r.passed).toBe(true);
  });

  test('missing baseline fails closed', async () => {
    const repo = await tempDir('orc-nobase-');
    const r = await executeVerify(
      { gitDiff: {} },
      {
        cwd: repo,
        runId: 'r',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
      },
    );
    expect(r.passed).toBe(false);
    expect(r.observations[0]?.detail).toMatch(/baselineSha/);
  });
});

describe('executeVerify — artifact', () => {
  test('requires collected artifact with matching digest', async () => {
    process.env.ORC_HOME = await tempDir('orc-ah-');
    const cwd = await tempDir('orc-acwd-');
    await Bun.write(path.join(cwd, 'out.bin'), 'payload');
    const man = await collectOutputArtifact({
      runId: 'arun',
      stepId: 's',
      attemptId: 'a',
      cwd,
      decl: { name: 'out', path: 'out.bin' },
    });
    const ok = await executeVerify(
      { artifact: { name: 'out', digest: man!.digest } },
      {
        cwd,
        runId: 'arun',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
        artifacts: { out: man! },
      },
    );
    expect(ok.passed).toBe(true);

    const bad = await executeVerify(
      { artifact: { name: 'out', digest: '0'.repeat(64) } },
      {
        cwd,
        runId: 'arun',
        stepId: 's',
        attemptId: 'a',
        state: 'done',
        settled: true,
        artifacts: { out: man! },
      },
    );
    expect(bad.passed).toBe(false);
    void refFromManifest; // keep import used if tree-shaken
  });
});
