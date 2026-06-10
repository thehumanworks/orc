import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The codex resolver reads ~/.codex via os.homedir(), which Node/Bun caches on
 * first call per process. To exercise it against a fake home we must run it in a
 * child process whose HOME is set before that process starts.
 */

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

const resolverScript = path.join(import.meta.dir, 'fixtures', 'run-codex-resolve.ts');

async function runResolver(home: string, recJson: string): Promise<string | null> {
  const proc = Bun.spawn(['bun', resolverScript, recJson], {
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (err.trim()) throw new Error(err);
  const trimmed = out.trim();
  return trimmed === 'null' ? null : trimmed;
}

describe('codex resolveTranscript', () => {
  test('matches newest rollout by cwd with mtime guard', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codexhome-'));
    tmpDirs.push(home);
    const sessDir = path.join(home, '.codex', 'sessions', '2026', '06', '09');
    await fs.mkdir(sessDir, { recursive: true });

    const targetCwd = '/private/tmp/orc-codex-work';
    const matchFile = path.join(sessDir, 'rollout-2026-06-09T12-00-00-019e93df.jsonl');
    await fs.writeFile(
      matchFile,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-uuid', cwd: targetCwd } })}\n{"type":"user"}\n`,
    );
    const decoy = path.join(sessDir, 'rollout-2026-06-09T11-00-00-aaaaaaaa.jsonl');
    await fs.writeFile(
      decoy,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: '/somewhere/else' } })}\n`,
    );

    const rec = {
      id: 'abcd1234',
      sessionId: 'abcd1234-0000-0000-0000-000000000000',
      provider: 'codex',
      tmuxName: 'orc-codex-abcd1234',
      cwd: targetCwd,
      workspace: targetCwd,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };

    const resolved = await runResolver(home, JSON.stringify(rec));
    expect(resolved).toBe(matchFile);
  });

  test('returns null when no cwd matches', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codexhome-'));
    tmpDirs.push(home);
    const sessDir = path.join(home, '.codex', 'sessions', '2026', '06', '09');
    await fs.mkdir(sessDir, { recursive: true });
    await fs.writeFile(
      path.join(sessDir, 'rollout-2026-06-09T12-00-00-019e93df.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/other' } })}\n`,
    );

    const rec = {
      id: 'abcd1234',
      sessionId: 'abcd1234-0000-0000-0000-000000000000',
      provider: 'codex',
      tmuxName: 'orc-codex-abcd1234',
      cwd: '/private/tmp/no-match',
      workspace: '/private/tmp/no-match',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };

    const resolved = await runResolver(home, JSON.stringify(rec));
    expect(resolved).toBeNull();
  });

  test('prefers session_meta timestamp over newest mtime for same-cwd sessions', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-codexhome-'));
    tmpDirs.push(home);
    const sessDir = path.join(home, '.codex', 'sessions', '2026', '06', '10');
    await fs.mkdir(sessDir, { recursive: true });

    const targetCwd = '/private/tmp/orc-codex-work';
    const parentFile = path.join(sessDir, 'rollout-2026-06-10T09-47-47-parent.jsonl');
    await fs.writeFile(
      parentFile,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'parent',
          cwd: targetCwd,
          timestamp: '2026-06-10T09:47:47.384Z',
        },
      })}\n`,
    );

    const childFile = path.join(sessDir, 'rollout-2026-06-10T09-52-31-child.jsonl');
    await fs.writeFile(
      childFile,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'child',
          cwd: targetCwd,
          timestamp: '2026-06-10T09:52:31.500Z',
        },
      })}\n`,
    );

    // Regression guard: the parent keeps writing later, so mtime alone would pick it.
    const olderMtime = new Date('2026-06-10T09:52:32.000Z');
    const newerMtime = new Date('2026-06-10T09:55:00.000Z');
    await fs.utimes(childFile, olderMtime, olderMtime);
    await fs.utimes(parentFile, newerMtime, newerMtime);

    const rec = {
      id: 'abcd1234',
      sessionId: 'abcd1234-0000-0000-0000-000000000000',
      provider: 'codex',
      tmuxName: 'orc-codex-abcd1234',
      cwd: targetCwd,
      workspace: targetCwd,
      createdAt: '2026-06-10T09:52:31.277Z',
    };

    const resolved = await runResolver(home, JSON.stringify(rec));
    expect(resolved).toBe(childFile);
  });
});
