import { describe, test, expect, afterAll } from 'bun:test';
import { PiAdapter } from '../src/providers/pi.ts';
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
    tmuxName: 'orc-pi-abcd1234',
    cwd: '/tmp/work',
    workspace: '/tmp/work',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('pi resolveTranscript', () => {
  test('globs <dir>/*_<sid>.jsonl', async () => {
    const dir = await mkTmp();
    const sid = 'abcd1234-0000-0000-0000-000000000000';
    const file = path.join(dir, `2026-06-09T11-25-06-601Z_${sid}.jsonl`);
    await fs.writeFile(file, '{"type":"session"}\n');
    // a decoy with a different sid
    await fs.writeFile(path.join(dir, '2026-06-09T11-00-00-000Z_other.jsonl'), 'x');

    const a = new PiAdapter();
    const resolved = await a.resolveTranscript(rec({ sessionDir: dir, sessionId: sid }));
    expect(resolved).toBe(file);
  });

  test('returns null when no sessionDir', async () => {
    const a = new PiAdapter();
    const resolved = await a.resolveTranscript(rec({ sessionDir: undefined }));
    expect(resolved).toBeNull();
  });

  test('returns null when no match', async () => {
    const dir = await mkTmp();
    const a = new PiAdapter();
    const resolved = await a.resolveTranscript(rec({ sessionDir: dir }));
    expect(resolved).toBeNull();
  });
});
