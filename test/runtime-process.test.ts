import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliEntryPath,
  isPidAlive,
  isSameProcessAlive,
  processStartTime,
  selfArgv,
  spawnDetached,
  terminateProcessGroup,
} from '../src/runtime/process.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orc-proc-'));

async function waitFor(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

describe('runtime/process', () => {
  test('selfArgv re-executes the CLI entry from source', () => {
    const argv = selfArgv();
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(cliEntryPath());
    expect(fs.existsSync(cliEntryPath())).toBe(true);
  });

  test('processStartTime is stable for a live pid and null for a dead one', () => {
    const t1 = processStartTime(process.pid);
    expect(t1).not.toBeNull();
    expect(processStartTime(process.pid)).toBe(t1);
    expect(processStartTime(2 ** 22 + 12345)).toBeNull();
  });

  test('isSameProcessAlive rejects a mismatched start time (pid reuse guard)', () => {
    expect(isSameProcessAlive({ pid: process.pid, startTime: processStartTime(process.pid) })).toBe(true);
    expect(isSameProcessAlive({ pid: process.pid, startTime: 'proc:1' })).toBe(false);
    expect(isSameProcessAlive({ pid: process.pid, startTime: null })).toBe(true);
    expect(isSameProcessAlive(null)).toBe(false);
  });

  test('spawnDetached: own session, no tty, logs to file, terminated by group', async () => {
    const dir = tmp();
    const log = path.join(dir, 'child.log');
    const id = spawnDetached(['bash', '-c', 'echo started; sleep 30 & wait'], {
      cwd: dir,
      logPath: log,
    });
    expect(id.pid).toBeGreaterThan(0);
    expect(await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('started'))).toBe(true);
    expect((fs.statSync(log).mode & 0o777).toString(8)).toBe('600');

    const ps = Bun.spawnSync(['ps', '-o', 'pid=,pgid=,sess=,tty=', '-p', String(id.pid)]);
    const [pid, pgid, sess, tty] = ps.stdout.toString().trim().split(/\s+/);
    expect(pid).toBe(String(id.pid));
    expect(pgid).toBe(String(id.pid));
    if (sess && sess !== '0') expect(sess).toBe(String(id.pid));
    expect(tty === '?' || tty === '??').toBe(true);

    expect(await terminateProcessGroup(id, 1_000)).toBe(true);
    expect(await waitFor(() => !isPidAlive(id.pid) || !isSameProcessAlive(id))).toBe(true);
    expect(await terminateProcessGroup(id, 100)).toBe(false);
  });
});
