import { describe, test, expect, afterAll } from 'bun:test';
import { resolveTranscriptPath } from '../src/provider-cli.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '../src/types.ts';

const tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-tx-'));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'abcd1234',
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    provider: 'pi',
    cwd: '/tmp/work',
    workspace: '/tmp/work',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('pi transcript resolution', () => {
  test('globs <dir>/*_<sid>.jsonl', async () => {
    const dir = await mkTmp();
    const sid = 'abcd1234-0000-0000-0000-000000000000';
    const file = path.join(dir, `2026-06-09T11-25-06-601Z_${sid}.jsonl`);
    await fs.writeFile(file, '{"type":"session"}\n');
    // a decoy with a different sid
    await fs.writeFile(path.join(dir, '2026-06-09T11-00-00-000Z_other.jsonl'), 'x');

    const resolved = resolveTranscriptPath(rec({ sessionDir: dir, sessionId: sid }));
    expect(resolved).toBe(file);
  });

  test('returns null when no sessionDir', async () => {
    const resolved = resolveTranscriptPath(rec({ sessionDir: undefined }));
    expect(resolved).toBeNull();
  });

  test('returns null when no match', async () => {
    const dir = await mkTmp();
    const resolved = resolveTranscriptPath(rec({ sessionDir: dir }));
    expect(resolved).toBeNull();
  });
});

describe('codex transcript resolution (thread.path only)', () => {
  test('uses the path the runtime recorded (spawn.json transcriptPath)', async () => {
    const dir = await mkTmp();
    const file = path.join(dir, 'rollout-2026-10-15T00-00-00-11111111-2222-3333-4444-555555555555.jsonl');
    await fs.writeFile(file, '{"type":"session_meta"}\n');
    const r = rec({ provider: 'codex', cwd: dir, workspace: dir });
    expect(
      resolveTranscriptPath(r, {
        version: 1,
        sessionId: r.sessionId,
        provider: 'codex',
        cwd: dir,
        env: {},
        transcriptPath: file,
        createdAt: new Date().toISOString(),
      }),
    ).toBe(file);
    // A path persisted on the record (kill/takeover) wins too.
    expect(resolveTranscriptPath({ ...r, transcriptPath: file })).toBe(file);
  });

  test('no recorded path → null (no cwd+mtime search)', () => {
    expect(resolveTranscriptPath(rec({ provider: 'codex' }))).toBeNull();
  });

  test('a recorded path that no longer exists is ignored', () => {
    expect(resolveTranscriptPath(rec({ provider: 'codex', transcriptPath: '/nonexistent/rollout.jsonl' }))).toBeNull();
  });
});
