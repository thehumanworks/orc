import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidStepId,
  isPathInsideRoot,
  resolveContainedWorkflowFile,
  validateWorkflowDef,
  workflowImportRoots,
  WORKFLOW_ROOTS_ENV,
} from '../src/workflow.ts';

const tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('assertValidStepId', () => {
  test('accepts letter/digit then letters/digits/_/-', () => {
    for (const ok of ['a', 'A1', 'step_1', 'step-2', '0x']) {
      expect(() => assertValidStepId(ok)).not.toThrow();
    }
  });

  test('rejects empty, dots, traversal, and unsafe chars', () => {
    for (const bad of [
      '',
      '.',
      '..',
      '../evil',
      'a/b',
      'a\\b',
      'a.b',
      '-lead',
      '_lead',
      'has space',
      'a\0b',
    ]) {
      expect(() => assertValidStepId(bad)).toThrow(/invalid step id/);
    }
  });

  test('validateWorkflowDef rejects unsafe step ids before run', () => {
    expect(() =>
      validateWorkflowDef({
        name: 'x',
        steps: [{ id: '../x', provider: 'claude', prompt: 'p' }],
      }),
    ).toThrow(/invalid step id/);
    expect(() =>
      validateWorkflowDef({
        name: 'x',
        steps: [{ id: 'bad.id', provider: 'claude', prompt: 'p' }],
      }),
    ).toThrow(/invalid step id/);
  });
});

describe('workflowImportRoots', () => {
  test('default is process cwd only', () => {
    const cwd = '/tmp/daemon-cwd';
    expect(workflowImportRoots({}, cwd)).toEqual([path.resolve(cwd)]);
  });

  test('ORC_WORKFLOW_ROOTS is path.delimiter-separated allowlist', () => {
    const cwd = '/tmp/daemon-cwd';
    const env = {
      [WORKFLOW_ROOTS_ENV]: ['/allowed/a', 'relative-root'].join(path.delimiter),
    };
    expect(workflowImportRoots(env, cwd)).toEqual([
      path.resolve('/allowed/a'),
      path.resolve(cwd, 'relative-root'),
    ]);
  });
});

describe('isPathInsideRoot', () => {
  test('self and nested children are inside; siblings are not', () => {
    expect(isPathInsideRoot('/r/a', '/r')).toBe(true);
    expect(isPathInsideRoot('/r', '/r')).toBe(true);
    expect(isPathInsideRoot('/r-other', '/r')).toBe(false);
    expect(isPathInsideRoot('/outside', '/r')).toBe(false);
  });
});

describe('resolveContainedWorkflowFile', () => {
  test('accepts a file under the default cwd root', async () => {
    const root = await mkTmp('orc-wfroot-');
    const file = path.join(root, 'wf.ts');
    await Bun.write(file, 'export default { name: "x", steps: [] };\n');
    const resolved = await resolveContainedWorkflowFile(file, { roots: [root], cwd: root });
    expect(resolved).toBe(await fs.realpath(file));
  });

  test('rejects path traversal via .. segments', async () => {
    const root = await mkTmp('orc-wfroot-');
    await expect(
      resolveContainedWorkflowFile('../outside.ts', { roots: [root], cwd: root }),
    ).rejects.toThrow(/outside allowed roots/);
  });

  test('rejects absolute paths outside roots', async () => {
    const root = await mkTmp('orc-wfroot-');
    const outside = path.join(await mkTmp('orc-wfout-'), 'evil.ts');
    await Bun.write(outside, 'export default {};\n');
    await expect(
      resolveContainedWorkflowFile(outside, { roots: [root], cwd: root }),
    ).rejects.toThrow(/outside allowed roots/);
  });

  test('rejects symlink escape before import', async () => {
    const root = await mkTmp('orc-wfroot-');
    const outsideDir = await mkTmp('orc-wfout-');
    const outsideFile = path.join(outsideDir, 'escaped.ts');
    await Bun.write(outsideFile, 'export default { name: "escaped" };\n');
    const link = path.join(root, 'sneaky.ts');
    await fs.symlink(outsideFile, link);

    // realpath of the link points outside root → rejected (no import attempted).
    await expect(resolveContainedWorkflowFile(link, { roots: [root], cwd: root })).rejects.toThrow(
      /outside allowed roots/,
    );
  });

  test('rejects symlink-to-directory escape', async () => {
    const root = await mkTmp('orc-wfroot-');
    const outsideDir = await mkTmp('orc-wfout-');
    await Bun.write(path.join(outsideDir, 'wf.ts'), 'export default {};\n');
    const linkDir = path.join(root, 'linked');
    await fs.symlink(outsideDir, linkDir);

    await expect(
      resolveContainedWorkflowFile(path.join(linkDir, 'wf.ts'), { roots: [root], cwd: root }),
    ).rejects.toThrow(/outside allowed roots/);
  });

  test('empty roots list fails closed', async () => {
    await expect(resolveContainedWorkflowFile('x.ts', { roots: [], cwd: '/tmp' })).rejects.toThrow(
      /no allowed roots/,
    );
  });
});
