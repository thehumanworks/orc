/**
 * scripts/verify-runtime/all.ts end to end, FULLY OFFLINE: pi through the conversational
 * stand-in (test/fixtures/pi-chat-fake.ts), claude through the scripted fake
 * (test/fixtures/claude-stream/fake-claude.ts) and codex forced to SKIP. No real provider
 * is ever launched: ORC_CLAUDE_BIN / ORC_CODEX_BIN point at guaranteed-missing paths
 * unless a test passes an explicit --<p>-bin stand-in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(REPO, 'scripts', 'verify-runtime', 'all.ts');
const FAKE = path.join(REPO, 'test', 'fixtures', 'pi-chat-fake.ts');
const FAKE_CLAUDE = path.join(REPO, 'test', 'fixtures', 'claude-stream', 'fake-claude.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-all-test-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Offline env: real claude/codex can never be resolved (bin overrides point nowhere). */
function offlineEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ORC_CLAUDE_BIN: path.join(tmp, 'absent', 'claude'),
    ORC_CODEX_BIN: path.join(tmp, 'absent', 'codex'),
    ...extra,
  };
}

function live(): { pid: number; stat: string; cmd: string }[] {
  const r = Bun.spawnSync(['ps', '-axww', '-o', 'pid=,stat=,command='], { stdout: 'pipe' });
  return r.stdout
    .toString()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), stat: m[2]!, cmd: m[3]! }))
    .filter((p) => !p.stat.startsWith('Z'));
}

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe('verify-runtime/all.ts', () => {
  test(
    'pi via the stand-in passes every check; claude/codex without a binary are SKIP; results file is clean',
    async () => {
      const results = path.join(tmp, 'results.json');
      // A PATH that has bun, git and ps but no codex; a lineage var that must not leak in.
      const env = offlineEnv({
        ORC_ROOT_RUN_ID: 'must-not-leak',
        ORC_HOME: path.join(tmp, 'must-not-be-used'),
      });
      const r = await run(
        ['--providers', 'claude,codex,pi', '--pi-bin', FAKE, '--no-workflow', '--results', results],
        env,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain('ALL PASSED');
      const j = JSON.parse(fs.readFileSync(results, 'utf8'));
      expect(j.ok).toBe(true);
      expect(j.tmuxShimInvoked).toBe(false);
      const by = (p: string, c: string) => j.checks.find((x: { provider: string; check: string }) => x.provider === p && x.check === c);
      for (const p of ['claude', 'codex']) {
        expect(by(p, 'preflight').status).toBe('SKIP');
        expect(by(p, 'runtime gate').status).toBe('SKIP');
        expect(by(p, 'e2e').status).toBe('SKIP');
      }
      expect(by('claude', 'workflow').status).toBe('SKIP');
      expect(by('pi', 'runtime gate').status).toBe('PASS');
      expect(j.runtimeGates.pi.rows.length).toBeGreaterThanOrEqual(8);
      const piE2E = j.checks.filter((x: { provider: string; check: string }) => x.provider === 'pi' && x.check.startsWith('e2e'));
      expect(piE2E.length).toBe(10);
      expect(piE2E.every((x: { status: string }) => x.status === 'PASS')).toBe(true);
      const text = fs.readFileSync(results, 'utf8');
      expect(text).not.toContain('must-not-leak');
      expect(text).not.toContain(os.homedir() + path.sep);
      expect(fs.existsSync(path.join(tmp, 'must-not-be-used'))).toBe(false);
      // Temp dirs were removed (no --keep).
      expect(r.out).not.toContain('kept:');
    },
    120_000,
  );

  /** Start all.ts, wait for `ready(out)`, SIGINT it; returns the output and exit code. */
  async function interruptWhen(args: string[], env: Record<string, string>, ready: (out: string) => boolean) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    let out = '';
    const reader = (async () => {
      for await (const c of proc.stdout) out += new TextDecoder().decode(c);
    })();
    const deadline = Date.now() + 60_000;
    while (!ready(out) && Date.now() < deadline) await Bun.sleep(25);
    expect(ready(out)).toBe(true);
    const root = /tmux shim first on PATH: (\S+)\/bin\/tmux/.exec(out)?.[1];
    expect(root).toBeTruthy();
    const before = out;
    await Bun.sleep(1_500);
    proc.kill('SIGINT');
    const code = await proc.exited;
    await reader;
    return { out, before, code, root: root! };
  }

  const ourProcs = (root: string) =>
    live().filter(
      (p) =>
        p.cmd.includes(root) ||
        p.cmd.includes(FAKE_CLAUDE) ||
        p.cmd.includes(FAKE) ||
        p.cmd.includes(`${path.join(REPO, 'src', 'cli', 'index.ts')} __actor`),
    );

  test(
    'Ctrl-C during the workflow kills the detached runner FIRST, then every session',
    async () => {
      // --keep so the run record survives: a runner killed first leaves it `running`; a
      // runner that outlived its sessions would have recorded the failed step.
      const r = await interruptWhen(
        ['--providers', 'claude', '--claude-bin', FAKE_CLAUDE, '--no-runtime-gates', '--no-e2e', '--keep', '--results', path.join(tmp, 'sigint1.json')],
        offlineEnv({ FAKE_CLAUDE_REPLY_DELAY_MS: '8000' }),
        (out) => /workflow run --detach .*runner pid (\d+)/.test(out),
      );
      try {
        expect(r.code).toBe(130);
        const runnerPid = Number(/runner pid (\d+)/.exec(r.before)?.[1]);
        expect(runnerPid).toBeGreaterThan(0);
        await Bun.sleep(1_000);
        expect(live().some((p) => p.pid === runnerPid)).toBe(false);
        expect(ourProcs(r.root)).toEqual([]);
        const runs = path.join(r.root, 'workflow', 'orc-home', 'runs');
        const [file] = fs.readdirSync(runs).filter((f) => f.endsWith('.json'));
        const run = JSON.parse(fs.readFileSync(path.join(runs, file!), 'utf8')) as { status: string };
        expect(run.status).toBe('running');
      } finally {
        fs.rmSync(r.root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  test(
    'Ctrl-C mid e2e stops the sessions and removes the temp root',
    async () => {
      const r = await interruptWhen(
        ['--providers', 'pi', '--pi-bin', FAKE, '--no-runtime-gates', '--no-workflow', '--results', path.join(tmp, 'sigint2.json')],
        offlineEnv({ PI_FAKE_REPLY_DELAY_MS: '4000' }),
        (out) => out.includes('e2e spawn (3-line prompt)'),
      );
      expect(r.code).toBe(130);
      await Bun.sleep(1_000);
      expect(ourProcs(r.root)).toEqual([]);
      expect(fs.existsSync(r.root)).toBe(false);
      await Bun.sleep(1_500);
      expect(fs.existsSync(r.root)).toBe(false);
    },
    90_000,
  );

  test('rejects unknown arguments and providers', async () => {
    const env = offlineEnv();
    expect((await run(['--bogus'], env)).code).toBe(2);
    expect((await run(['--providers', 'claude,gemini'], env)).code).toBe(2);
  });
});
