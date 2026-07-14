import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidArtifactName,
  assertSafeRelativePath,
  resolveContainedPath,
  collectOutputArtifact,
  collectDeclaredOutputs,
  materializeInput,
  verifyStoredBlob,
  readArtifactManifest,
  refFromManifest,
  validateArtifactDecl,
  sha256Hex,
  hashFile,
  ArtifactError,
  DEFAULT_MAX_ARTIFACT_BYTES,
} from '../src/artifacts.ts';
import { runArtifactBlobPath } from '../src/paths.ts';

const tmp: string[] = [];
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmp) await fs.rm(d, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-art-'));
  tmp.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
  return process.env.ORC_HOME;
}

describe('pure path / name helpers', () => {
  test('assertValidArtifactName accepts safe names', () => {
    expect(assertValidArtifactName('out.md')).toBe('out.md');
    expect(assertValidArtifactName('A1_b.c')).toBe('A1_b.c');
  });
  test('assertValidArtifactName rejects bad names', () => {
    expect(() => assertValidArtifactName('../x')).toThrow(ArtifactError);
    expect(() => assertValidArtifactName('')).toThrow(ArtifactError);
  });
  test('assertSafeRelativePath rejects absolute and traversal', () => {
    expect(() => assertSafeRelativePath('/etc/passwd')).toThrow(/relative/);
    expect(() => assertSafeRelativePath('../escape')).toThrow(/\.\./);
    expect(assertSafeRelativePath('a/b.txt')).toBe(path.normalize('a/b.txt'));
  });
  test('sha256Hex is stable', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});

describe('resolveContainedPath', () => {
  test('rejects symlink escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-out-'));
    tmp.push(root, outside);
    const target = path.join(outside, 'secret.txt');
    await Bun.write(target, 'secret');
    const link = path.join(root, 'link.txt');
    await fs.symlink(target, link);
    // realpath of link escapes root
    await expect(resolveContainedPath(root, 'link.txt')).rejects.toThrow(/outside|escape/i);
  });

  test('accepts file inside root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-ok-'));
    tmp.push(root);
    await Bun.write(path.join(root, 'a.txt'), 'hi');
    const abs = await resolveContainedPath(root, 'a.txt');
    expect(abs).toBe(await fs.realpath(path.join(root, 'a.txt')));
  });
});

describe('collect / store / materialize', () => {
  let cwd: string;
  beforeEach(async () => {
    await freshHome();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-cwd-'));
    tmp.push(cwd);
  });

  test('collects required output into content-addressed store', async () => {
    await Bun.write(path.join(cwd, 'out.txt'), 'hello-artifact');
    const man = await collectOutputArtifact({
      runId: 'run1',
      stepId: 's1',
      attemptId: 'a1',
      cwd,
      decl: { name: 'out', path: 'out.txt' },
    });
    expect(man).not.toBeNull();
    expect(man!.digest).toBe(sha256Hex('hello-artifact'));
    expect(man!.byteSize).toBe(Buffer.byteLength('hello-artifact'));
    expect(await verifyStoredBlob('run1', man!.digest)).toBe(true);
    const loaded = await readArtifactManifest('run1', 'out');
    expect(loaded?.digest).toBe(man!.digest);
  });

  test('optional missing output returns null; required throws', async () => {
    const opt = await collectOutputArtifact({
      runId: 'run2',
      stepId: 's',
      attemptId: 'a',
      cwd,
      decl: { name: 'missing', path: 'nope.txt', required: false },
    });
    expect(opt).toBeNull();
    await expect(
      collectOutputArtifact({
        runId: 'run2',
        stepId: 's',
        attemptId: 'a',
        cwd,
        decl: { name: 'missing', path: 'nope.txt', required: true },
      }),
    ).rejects.toThrow(/not found|MISSING/i);
  });

  test('oversize rejected', async () => {
    await Bun.write(path.join(cwd, 'big.bin'), 'x'.repeat(100));
    await expect(
      collectOutputArtifact({
        runId: 'run3',
        stepId: 's',
        attemptId: 'a',
        cwd,
        decl: { name: 'big', path: 'big.bin', maxBytes: 10 },
      }),
    ).rejects.toThrow(/OVERSIZE|max/i);
  });

  test('tamper detection fails materialize', async () => {
    await Bun.write(path.join(cwd, 't.txt'), 'orig');
    const man = await collectOutputArtifact({
      runId: 'run4',
      stepId: 's',
      attemptId: 'a',
      cwd,
      decl: { name: 't', path: 't.txt' },
    });
    const blob = runArtifactBlobPath('run4', man!.digest);
    await Bun.write(blob, 'TAMPERED');
    await expect(
      materializeInput({
        runId: 'run4',
        stepId: 'consumer',
        ref: refFromManifest(man!),
      }),
    ).rejects.toThrow(/TAMPER|verification/i);
  });

  test('materialize copies verified blob into inputs dir', async () => {
    await Bun.write(path.join(cwd, 'data.json'), '{"ok":true}');
    const man = await collectOutputArtifact({
      runId: 'run5',
      stepId: 'prod',
      attemptId: 'a',
      cwd,
      decl: { name: 'data', path: 'data.json', mediaType: 'application/json' },
    });
    const dest = await materializeInput({
      runId: 'run5',
      stepId: 'cons',
      ref: refFromManifest(man!),
    });
    expect(await Bun.file(dest).text()).toBe('{"ok":true}');
    expect(dest).toContain(`${path.sep}inputs${path.sep}cons${path.sep}`);
  });

  test('collectDeclaredOutputs maps names', async () => {
    await Bun.write(path.join(cwd, 'a.txt'), 'A');
    await Bun.write(path.join(cwd, 'b.txt'), 'B');
    const map = await collectDeclaredOutputs({
      runId: 'run6',
      stepId: 's',
      attemptId: 'a',
      cwd,
      outputs: [
        { name: 'a', path: 'a.txt' },
        { name: 'b', path: 'b.txt' },
      ],
    });
    expect(Object.keys(map).sort()).toEqual(['a', 'b']);
  });

  test('validateArtifactDecl rejects bad maxBytes', () => {
    expect(() => validateArtifactDecl({ name: 'x', maxBytes: -1 })).toThrow(ArtifactError);
  });

  test('DEFAULT_MAX_ARTIFACT_BYTES is positive', () => {
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBeGreaterThan(0);
  });

  test('hashFile matches sha256Hex of contents', async () => {
    const f = path.join(cwd, 'h.txt');
    await Bun.write(f, 'hash-me');
    const { digest } = await hashFile(f);
    expect(digest).toBe(sha256Hex('hash-me'));
  });
});
