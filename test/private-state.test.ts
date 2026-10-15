import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertRecord } from '../src/registry.ts';
import { writeRun } from '../src/runs.ts';
import { writePeers } from '../src/daemon/peers.ts';
import { withLock } from '../src/lock.ts';
import { deliverInstructions } from '../src/workflow.ts';
import { ensurePrivateDir, writePrivateFile } from '../src/private-fs.ts';
import { registryPath, peersPath, runPath, runsDir, locksDir, runInstructionsDir } from '../src/paths.ts';
import type { SessionRecord } from '../src/types.ts';
import type { WorkflowRun, WorkflowStep } from '../src/workflow.ts';

/**
 * Privacy: everything orc writes under ORC_HOME is owner-only (dirs 0700, files 0600)
 * whatever the umask — registry.json (cwd paths, aliases), runs/<id>.json (step prompts),
 * instruction drops (prompt bodies), peers.json (tailnet hosts), locks. State left 0755/0644
 * by an older orc is tightened on the next write.
 */

const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);
const roots: string[] = [];
let oldUmask = 0;
let home = '';

beforeEach(() => {
  oldUmask = process.umask(0o022); // the common default: without explicit modes → 0755/0644
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-private-'));
  roots.push(root);
  home = path.join(root, 'orc');
  process.env.ORC_HOME = home;
});

afterEach(() => {
  process.umask(oldUmask);
});

afterAll(() => {
  delete process.env.ORC_HOME;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function rec(): SessionRecord {
  return {
    id: 'priv0001',
    sessionId: 'priv0001-0000-0000-0000-000000000000',
    provider: 'claude',
    cwd: '/tmp/ws-private',
    workspace: '/tmp/ws-private',
    alias: 'secret-alias',
    createdAt: new Date().toISOString(),
  };
}

describe('owner-only orc state', () => {
  test('registry.json is 0600 and ORC_HOME 0700, tightening an older 0755/0644 layout', async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o755 });
    fs.chmodSync(home, 0o755);
    fs.writeFileSync(registryPath(), '[]', { mode: 0o644 });
    fs.chmodSync(registryPath(), 0o644);

    await upsertRecord(rec());

    expect(mode(home)).toBe('700');
    expect(mode(registryPath())).toBe('600');
    expect(fs.readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('runs/<id>.json (plan with step prompts) is 0600 in a 0700 runs dir', async () => {
    const run = {
      id: 'run-private-1',
      name: 'wf',
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: [],
    } as unknown as WorkflowRun;
    await writeRun(run);
    expect(mode(home)).toBe('700');
    expect(mode(runsDir())).toBe('700');
    expect(mode(runPath(run.id))).toBe('600');
  });

  test('a large step prompt is dropped as a 0600 file in a 0700 run dir', async () => {
    const body = `do the thing\n${'x'.repeat(2048)}`;
    let sent = '';
    const step = { id: 'big', provider: 'claude', prompt: body } as WorkflowStep;
    await deliverInstructions(
      {
        send: async (text: string) => {
          sent = text;
          return { phase: 'acknowledged', messageId: 'm1', replayed: false };
        },
      },
      step,
      'run-private-2',
    );
    const file = path.join(runInstructionsDir('run-private-2'), 'big.md');
    expect(sent).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
    expect(mode(runInstructionsDir('run-private-2'))).toBe('700');
    expect(mode(file)).toBe('600');
  });

  test('peers.json is 0600', async () => {
    await writePeers([{ host: 'mini' }]);
    expect(mode(peersPath())).toBe('600');
    expect(mode(home)).toBe('700');
  });

  test('locks dir is 0700 and a held lock file is 0600', async () => {
    await withLock('private-test', async () => {
      const held = fs.readdirSync(locksDir()).filter((n) => n.endsWith('.lock'));
      expect(held.length).toBe(1);
      expect(mode(path.join(locksDir(), held[0]!))).toBe('600');
    });
    expect(mode(locksDir())).toBe('700');
  });

  test('ensurePrivateDir leaves dirs outside ORC_HOME alone except the target itself', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-private-outside-'));
    roots.push(outside);
    fs.chmodSync(outside, 0o755);
    const leaf = path.join(outside, 'a', 'b');
    ensurePrivateDir(leaf);
    expect(mode(leaf)).toBe('700');
    expect(mode(outside)).toBe('755');
  });

  test('writePrivateFile replaces a 0644 file with a 0600 one atomically', async () => {
    fs.mkdirSync(home, { recursive: true });
    const f = path.join(home, 'x.json');
    fs.writeFileSync(f, 'old', { mode: 0o644 });
    await writePrivateFile(f, 'new');
    expect(fs.readFileSync(f, 'utf8')).toBe('new');
    expect(mode(f)).toBe('600');
    expect(fs.readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
