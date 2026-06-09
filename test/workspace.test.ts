import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace } from '../src/agent.ts';

/**
 * BUG 4 — an explicit --workspace that points at an existing filesystem path must be
 * stored as its REALPATH (so a symlinked/relative path stays comparable to the default
 * workspace, which realpaths cwd). A logical (non-filesystem) string is kept verbatim.
 */

const tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-ws-'));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('resolveWorkspace (BUG 4)', () => {
  test('explicit workspace pointing at a symlink → stored as realpath', async () => {
    const base = await mkTmp();
    const real = path.join(base, 'realdir');
    await fs.mkdir(real);
    const link = path.join(base, 'linkdir');
    await fs.symlink(real, link);

    const ws = await resolveWorkspace(link, '/unused/cwd');
    // realpath of the symlink == realpath of the target == what defaultWorkspace() yields.
    expect(ws).toBe(await fs.realpath(real));
    expect(ws).not.toBe(link);
  });

  test('explicit workspace that is a real path → unchanged (already canonical)', async () => {
    const real = await fs.realpath(await mkTmp());
    expect(await resolveWorkspace(real, '/unused/cwd')).toBe(real);
  });

  test('logical (non-filesystem) workspace string → kept verbatim', async () => {
    expect(await resolveWorkspace('my-logical-workspace', '/unused/cwd')).toBe(
      'my-logical-workspace',
    );
  });

  test('no explicit workspace → falls back to cwd when not in a repo', async () => {
    const cwd = await fs.realpath(await mkTmp());
    expect(await resolveWorkspace(undefined, cwd)).toBe(cwd);
  });
});
