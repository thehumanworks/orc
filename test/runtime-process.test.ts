import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliEntryPath,
  isLiveProcess,
  isPidAlive,
  isSameProcessAlive,
  isZombie,
  probeProcess,
  processStartTime,
  selfArgv,
  spawnDetached,
  terminateGroup,
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
    // A token from the other source (proc vs ps) is not comparable → pid liveness wins.
    const own = processStartTime(process.pid)!;
    const foreign = own.startsWith('proc:') ? 'ps:Thu Jan  1 00:00:00 1970' : 'proc:1';
    expect(isSameProcessAlive({ pid: process.pid, startTime: foreign })).toBe(true);
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

  test('liveness is zombie-aware: an unreaped child is dead for isPidAlive/isSameProcessAlive', async () => {
    // `sleep 10` (exec'd shell) never reaps its finished `sleep 0.05` child → zombie.
    const proc = Bun.spawn(['sh', '-c', 'sleep 0.05 & echo $!; exec sleep 10'], { stdout: 'pipe' });
    const { value } = await proc.stdout.getReader().read();
    const zpid = Number(new TextDecoder().decode(value).trim());
    try {
      const id = { pid: zpid, startTime: processStartTime(zpid) };
      expect(await waitFor(() => isZombie(zpid), 3_000)).toBe(true);
      expect(probeProcess(zpid)?.state?.startsWith('Z')).toBe(true);
      expect(isPidAlive(zpid)).toBe(false);
      expect(isSameProcessAlive(id)).toBe(false);
      expect(isLiveProcess(id)).toBe(false);
      expect(await terminateGroup(id, 100)).toBe(false);
      const parent = { pid: proc.pid, startTime: processStartTime(proc.pid) };
      expect(isPidAlive(proc.pid)).toBe(true);
      expect(isSameProcessAlive(parent)).toBe(true);
      expect(probeProcess(proc.pid)?.startTime).toBe(parent.startTime);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }, 5_000);

  test('terminateGroup falls back to the pid when it is not a group leader (ESRCH)', async () => {
    // Not detached: the child shares OUR process group, so -pid names no group.
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    const id = { pid: proc.pid, startTime: processStartTime(proc.pid) };
    expect(isLiveProcess(id)).toBe(true);
    expect(await terminateGroup(id, 1_000)).toBe(true);
    await proc.exited;
    expect(proc.signalCode).toBe('SIGTERM');
    expect(isLiveProcess(id)).toBe(false);
  }, 5_000);
});
