/**
 * scripts/verify-runtime/all.ts end to end, FULLY OFFLINE: pi through the conversational
 * stand-in (test/fixtures/pi-chat-fake.ts), claude through the scripted fake
 * (test/fixtures/claude-stream/fake-claude.ts) with unavailable providers reported as SKIP. No real provider
 * is ever launched: ORC_CLAUDE_BIN points at a guaranteed-missing path unless a test passes
 * an explicit --<p>-bin stand-in. Pi has an isolated configuration and no API key.
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

/** Offline env: real claude can never be resolved; Pi uses no inherited credential. */
function offlineEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ORC_CLAUDE_BIN: path.join(tmp, 'absent', 'claude'),
    PI_CODING_AGENT_DIR: path.join(tmp, 'absent', 'pi-agent'),
    OPENAI_API_KEY: '',
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

/** A process's environment entries (Linux /proc; macOS `ps eww`), or null when unreadable. */
function envOf(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    if (process.platform === 'linux') return null;
  }
  const r = Bun.spawnSync(['ps', 'eww', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out.length > 0 ? out.split(/\s+/) : null;
}

/** The process runs with an ORC_HOME inside `root` (unreadable env → assume it does). */
function underRoot(pid: number, root: string): boolean {
  const env = envOf(pid);
  if (env === null) return true;
  return env.some((e) => e === `ORC_HOME=${root}` || e.startsWith(`ORC_HOME=${root}/`));
}

/**
 * Processes this test's all.ts run started: anything naming its temp root on the command
 * line, plus actors / fake providers from this checkout whose ORC_HOME is under that root
 * (a concurrent dev session or test from the same checkout is NOT ours).
 */
function ourProcs(root: string) {
  return live().filter(
    (p) =>
      p.cmd.includes(root) ||
      ((p.cmd.includes(FAKE_CLAUDE) ||
        p.cmd.includes(FAKE) ||
        p.cmd.includes(`${path.join(REPO, 'src', 'cli', 'index.ts')} __actor`)) &&
        underRoot(p.pid, root)),
  );
}

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe('verify-runtime/all.ts', () => {
  test(
    'pi via the stand-in passes every check; claude without a binary is SKIP; results file is clean',
    async () => {
      const results = path.join(tmp, 'results.json');
      // No claude binary, no OpenAI credential; a lineage var that must not leak in.
      const env = offlineEnv({
        ORC_ROOT_RUN_ID: 'must-not-leak',
        ORC_HOME: path.join(tmp, 'must-not-be-used'),
      });
      const r = await run(
        ['--providers', 'claude,pi', '--pi-bin', FAKE, '--no-workflow', '--results', results],
        env,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain('NO FAILURES (checks skipped)');
      const j = JSON.parse(fs.readFileSync(results, 'utf8'));
      expect(j.ok).toBe(true);
      expect(j.tmuxShimInvoked).toBe(false);
      const by = (p: string, c: string) => j.checks.find((x: { provider: string; check: string }) => x.provider === p && x.check === c);
      for (const p of ['claude']) {
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

  test(
    'a reply is only read from the provider transcript: the journal fallback is a FAIL',
    async () => {
      // The fake claude echoes the prompt (so the word IS in the journal) but writes no
      // transcript: the read check must fail rather than match the prompt text.
      const results = path.join(tmp, 'fallback.json');
      const r = await run(
        ['--providers', 'claude', '--claude-bin', FAKE_CLAUDE, '--no-runtime-gates', '--no-workflow', '--results', results],
        offlineEnv(),
      );
      expect(r.code).toBe(1);
      const j = JSON.parse(fs.readFileSync(results, 'utf8'));
      const row = j.checks.find((x: { check: string }) => x.check === 'e2e read → assistant reply word');
      expect(row.status).toBe('FAIL');
      expect(row.detail).toMatch(/no provider transcript/);
      const leak = j.checks.find((x: { check: string }) => x.check === 'e2e no orc/provider processes left');
      expect(leak.status).toBe('PASS');
    },
    90_000,
  );

  test('rejects unknown arguments and providers', async () => {
    const env = offlineEnv();
    expect((await run(['--bogus'], env)).code).toBe(2);
    expect((await run(['--providers', 'claude,gemini'], env)).code).toBe(2);
    // The removed integration is rejected, with no hidden Codex execution path.
    const cb = await run(['--codex-bin', '/usr/bin/true'], env);
    expect(cb.code).toBe(2);
    expect(cb.err).toContain('unknown argument');
    expect((await run(['--providers', 'codex'], env)).code).toBe(2);
    expect((await run(['--codex-model', 'gpt-5.4-mini'], env)).code).toBe(2);
  });

  test('native credential readiness reports blocked checks without attempting a model request', async () => {
    const marker = path.join(tmp, 'must-not-start-provider');
    const fixture = path.join(tmp, 'unauthenticated.ts');
    fs.writeFileSync(fixture, [
      "import fs from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (args.includes('--credentials') || args.some((arg) => arg.startsWith('print-'))) throw new Error('unsafe auth mode');",
      "if (args.includes('--version')) console.log('1.2.0');",
      "else if (args[0] === 'auth' && args[1] === 'status') console.log(JSON.stringify({ loggedIn: false }));",
      "else if (args[0] === 'auth' && args[1] === 'check' && args.includes('--no-refresh')) console.log(JSON.stringify({ status: 'not_ready', provider: 'openai', reason: 'credentials_not_configured' }));",
      `else { fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected model invocation'); process.exit(1); }`,
    ].join('\n'));
    const results = path.join(tmp, 'auth-blocked.json');
    const result = await run([
      '--providers', 'claude,pi', '--claude-bin', fixture, '--pi-bin', fixture,
      '--pi-model', 'openai/gpt-5.4-mini', '--results', results,
    ], offlineEnv());
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('ALL PASSED');
    const report = JSON.parse(fs.readFileSync(results, 'utf8'));
    for (const provider of ['claude', 'pi']) {
      const preflight = report.checks.find((row: { provider: string; check: string }) => row.provider === provider && row.check === 'preflight');
      expect(preflight.status).toBe('SKIP');
      expect(preflight.detail).toContain('blocked:');
    }
    expect(report.checks.filter((row: { status: string }) => row.status === 'FAIL')).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  test('ourProcs is hermetic: lookalike processes from another ORC_HOME are not ours', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'hermetic-'));
    const decoy = (home: string) =>
      Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 30_000)', FAKE], {
        env: { ...(process.env as Record<string, string>), ORC_HOME: home },
        stdout: 'ignore',
        stderr: 'ignore',
      });
    const other = decoy(path.join(tmp, 'someone-else', 'orc-home'));
    const mine = decoy(path.join(root, 'workflow', 'orc-home'));
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !live().some((p) => p.pid === mine.pid && p.cmd.includes(FAKE))) await Bun.sleep(25);
      const pids = ourProcs(root).map((p) => p.pid);
      expect(pids).toContain(mine.pid);
      expect(pids).not.toContain(other.pid);
    } finally {
      other.kill('SIGKILL');
      mine.kill('SIGKILL');
      await Promise.all([other.exited, mine.exited]);
    }
  }, 15_000);
});
