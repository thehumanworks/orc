/**
 * S5 cutover — the `orc` CLI end to end on the actor runtime, from source, over the
 * scripted fake provider, with a `tmux` shim first on PATH that records any invocation
 * (it must never run). Mirrors the live verification gate with a fake provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { resolveCommand, sendExitCode } from '../src/cli/index.ts';
import { HELP_TEXT } from '../src/cli/output.ts';
import { actorPids, fakeProviderPids, killSessionProcesses, mkTmp, plainCliEnv } from './runtime-helpers.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 60_000;
const root = mkTmp('orc-cli-actor-');
const home = path.join(root, 'orc');
const work = path.join(root, 'work');
const shimDir = path.join(root, 'shim');
const shimLog = path.join(root, 'tmux-invocations.log');
const sids: string[] = [];

beforeAll(() => {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'tmux'), `#!/bin/sh\necho "tmux $*" >> '${shimLog}'\nexit 127\n`, {
    mode: 0o755,
  });
});

afterAll(async () => {
  await killSessionProcesses(sids);
  fs.rmSync(root, { recursive: true, force: true });
});

async function orc(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: work,
    env: plainCliEnv({
      ...process.env,
      ORC_HOME: home,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      [FAKE_PROVIDER_ENV]: JSON.stringify({ rules: [{ match: 'HANG', action: 'hang' }] }),
    }),
    stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

async function orcJson<T = Record<string, unknown>>(args: string[]): Promise<T> {
  const r = await orc([...args, '--json']);
  if (r.code !== 0) throw new Error(`orc ${args.join(' ')} → ${r.code}\n${r.out}\n${r.err}`);
  return JSON.parse(r.out) as T;
}

describe('orc CLI on the actor runtime (tmux shadowed on PATH)', () => {
  test(
    'spawn/wait/read/send(idempotent)/list/crash→suspended/wake/takeover/resume/kill/prune',
    async () => {
      const spawned = await orcJson<{ id: string; sessionId: string; runtime: string }>([
        'spawn',
        '--provider',
        'claude',
        '--prompt',
        'alpha\nbeta',
      ]);
      sids.push(spawned.sessionId);
      expect(spawned.runtime).toBe('actor');
      const id = spawned.id;

      expect(await orcJson(['wait', id, '--timeout', '15'])).toMatchObject({ state: 'done', timedOut: false });

      // No provider transcript for the fake: read falls back to the journal.
      const fb = await orcJson<{ fallback: boolean; journal: { type: string }[] }>(['read', id]);
      expect(fb.fallback).toBe(true);
      expect(fb.journal.some((e) => e.type === 'turn.completed')).toBe(true);
      const human = await orc(['read', id]);
      expect(human.out).toContain('echo: alpha\nbeta');
      const raw = await orcJson<{ id: string; journal: { seq: number }[] }>(['read', id, '--raw']);
      expect(raw.journal.length).toBeGreaterThan(3);
      const rawText = await orc(['read', id, '--raw']);
      expect(rawText.out.trim().split('\n').every((l) => typeof JSON.parse(l).seq === 'number')).toBe(true);

      const s1 = await orcJson(['send', id, 'second turn', '--idempotency-key', 'k-2']);
      expect(s1).toMatchObject({ ok: true, phase: 'acknowledged', messageId: 'k-2', replayed: false });
      const s2 = await orcJson(['send', id, 'second turn', '--idempotency-key', 'k-2']);
      expect(s2).toMatchObject({ ok: true, replayed: true });
      const clash = await orc(['send', id, 'other text', '--idempotency-key', 'k-2']);
      expect(clash.code).toBe(1);
      expect(clash.err).toMatch(/different prompt/);
      // stdin prompt
      const piped = await orc(['send', id, '-'], 'from stdin\n');
      expect(piped.code).toBe(0);
      expect(piped.out).toMatch(/sent to \w+ \(acknowledged\)/);

      const listed = await orcJson<{ id: string; status: string; state: string }[]>(['list']);
      expect(listed.find((r) => r.id === id)).toMatchObject({ status: 'running' });

      // Crash the actor: the session is suspended (still listed) and the next send wakes it.
      const [actor] = actorPids(spawned.sessionId);
      process.kill(actor!, 'SIGKILL');
      await Bun.sleep(300);
      const st = await orcJson<{ state: string; status: string; suspended: boolean; stopped: boolean }>(['state', id]);
      expect(st).toMatchObject({ state: 'failed', status: 'suspended', suspended: true, stopped: false });
      expect((await orcJson<{ id: string; status: string }[]>(['list'])).find((r) => r.id === id)?.status).toBe(
        'suspended',
      );
      const woke = await orcJson(['send', id, 'are you back?']);
      expect(woke).toMatchObject({ phase: 'acknowledged' });
      expect(await orcJson(['wait', id, '--timeout', '15'])).toMatchObject({ state: 'done' });

      // Takeover: stopped, record dead, provider gone, native command printed.
      const t = await orcJson<{ id: string; cwd: string; command: string }>(['takeover', id]);
      expect(t.id).toBe(id);
      expect(t.cwd).toBe(fs.realpathSync(work));
      expect(fakeProviderPids(spawned.sessionId)).toEqual([]);
      expect(await orcJson(['state', id])).toMatchObject({ status: 'dead', stopped: true });
      expect((await orcJson<{ id: string }[]>(['list'])).some((r) => r.id === id)).toBe(false);
      expect((await orcJson<{ id: string; status: string }[]>(['list', '--dead'])).find((r) => r.id === id)?.status).toBe(
        'dead',
      );
      const refused = await orc(['send', id, 'nope']);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/orc resume/);

      // Handback.
      expect(await orcJson(['resume', id])).toMatchObject({ status: 'running', state: 'done' });
      expect(await orcJson(['send', id, 'after resume'])).toMatchObject({ phase: 'acknowledged' });

      // A queued-only send to a live session still returns 0.
      expect(sendExitCode('queued')).toBe(0);
      expect(sendExitCode('unknown')).toBe(3);
      expect(sendExitCode('failed')).toBe(1);

      // attach --json describes, does not follow.
      const att = await orcJson<{ command: string; journalPath: string }>(['attach', id]);
      expect(att.command).toBe(`orc attach ${id}`);
      expect(fs.existsSync(att.journalPath)).toBe(true);

      // kill keeps the record and journal; prune removes both.
      expect(await orcJson(['kill', id])).toMatchObject({ ok: true, purged: false });
      expect(actorPids(spawned.sessionId)).toEqual([]);
      expect(fs.existsSync(att.journalPath)).toBe(true);
      const pruned = await orcJson<{ pruned: string[] }>(['prune']);
      expect(pruned.pruned).toContain(id);
      expect(fs.existsSync(att.journalPath)).toBe(false);

      // tmux was never invoked.
      expect(fs.existsSync(shimLog)).toBe(false);
    },
    T,
  );

  test(
    'attach follows a live session until it is killed',
    async () => {
      const spawned = await orcJson<{ id: string; sessionId: string }>(['spawn', '--provider', 'pi']);
      sids.push(spawned.sessionId);
      const proc = Bun.spawn([process.execPath, CLI, 'attach', spawned.id], {
        cwd: work,
        env: plainCliEnv({ ...process.env, ORC_HOME: home, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` }),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await orc(['send', spawned.id, 'hello attach']);
      await Bun.sleep(500);
      await orc(['kill', spawned.id]);
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain('> hello attach');
      expect(out).toContain('echo: hello attach');
      expect(out).toMatch(/# session \w+ stopped/);
      expect(fs.existsSync(shimLog)).toBe(false);
    },
    T,
  );
});

describe('CLI surface', () => {
  test('resume and takeover are commands; help documents them and no tmux', () => {
    expect(resolveCommand('resume')).toBe('resume');
    expect(resolveCommand('takeover')).toBe('takeover');
    expect(HELP_TEXT).toContain('orc resume');
    expect(HELP_TEXT).toContain('orc takeover');
    expect(HELP_TEXT).toContain('--no-wake');
    expect(HELP_TEXT).toContain('prune  [--worktree] [--suspended]');
    expect(HELP_TEXT.toLowerCase()).not.toContain('tmux');
  });
});
