/**
 * scripts/verify-runtime/all.ts end to end, offline: pi through the conversational stand-in
 * (test/fixtures/pi-chat-fake.ts), the codex SKIP path via a PATH without codex, the
 * results file, and that no secrets or ORC_* state leak into it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(REPO, 'scripts', 'verify-runtime', 'all.ts');
const FAKE = path.join(REPO, 'test', 'fixtures', 'pi-chat-fake.ts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-all-test-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

describe('verify-runtime/all.ts', () => {
  test(
    'pi via the stand-in passes every check; codex without a binary is SKIP; results file is clean',
    async () => {
      const results = path.join(tmp, 'results.json');
      // A PATH that has bun, git and ps but no codex; a lineage var that must not leak in.
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ORC_ROOT_RUN_ID: 'must-not-leak',
        ORC_HOME: path.join(tmp, 'must-not-be-used'),
      };
      delete env.ORC_CODEX_BIN;
      const r = await run(
        ['--providers', 'codex,pi', '--pi-bin', FAKE, '--no-workflow', '--results', results],
        env,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain('ALL PASSED');
      const j = JSON.parse(fs.readFileSync(results, 'utf8'));
      expect(j.ok).toBe(true);
      expect(j.tmuxShimInvoked).toBe(false);
      const by = (p: string, c: string) => j.checks.find((x: { provider: string; check: string }) => x.provider === p && x.check === c);
      if (!Bun.which('codex')) {
        expect(by('codex', 'preflight').status).toBe('SKIP');
        expect(by('codex', 'e2e').status).toBe('SKIP');
      }
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

  test('rejects unknown arguments and providers', async () => {
    const env = process.env as Record<string, string>;
    expect((await run(['--bogus'], env)).code).toBe(2);
    expect((await run(['--providers', 'claude,gemini'], env)).code).toBe(2);
  });
});
