/** Compiled CLI contract: Pi and Claude actors, MCP, daemon, settings and cwd isolation. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plainCliEnv } from './runtime-helpers.ts';

const REPO = path.resolve(import.meta.dir, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string; scripts: Record<string, string> };
/**
 * `bun build` flags of every orc binary (package.json `compile:cli`, .github/workflows/build.yml).
 * A compiled Bun executable autoloads `.env` and `bunfig.toml` from its cwd by default, and
 * orc re-execs itself (actors) in agent worktrees: keep both off.
 */
const COMPILE_FLAGS = ['--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'];
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-compiled-bin-')));
const bin = path.join(root, 'orc');
let built = false;

/** process.env without ORC_* (the developer's own ORC_HOST etc. must not leak in). */
function envWithoutOrc(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
  return env;
}

beforeAll(() => {
  const r = Bun.spawnSync([process.execPath, 'build', ...COMPILE_FLAGS, path.join(REPO, 'src', 'cli', 'index.ts'), '--outfile', bin], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(`bun build --compile failed: ${r.stderr.toString()}`);
  built = fs.existsSync(bin);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('compiled orc binary', () => {
  test('the standalone binary drives Pi and Claude actors through the offline protocol smoke', async () => {
    const proc = Bun.spawn([process.execPath, path.join(REPO, 'scripts', 'verify-runtime', 'compiled.ts'), bin], {
      cwd: root,
      env: envWithoutOrc(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' });
    const result = JSON.parse(out);
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check: { ok: boolean }) => !check.ok)).toEqual([]);
    expect(result.checks.map((check: { check: string }) => check.check)).toEqual(expect.arrayContaining([
      'version-help-settings', 'cwd-autoload-disabled', 'pi-openai-execution', 'pi-lifecycle', 'claude-execution', 'claude-lifecycle',
    ]));
  }, 60_000);

  test(
    'the compiled orc reads settings.toml (orc settings --json)',
    () => {
      expect(built).toBe(true);
      const orcHome = path.join(root, 'settings-home');
      fs.mkdirSync(orcHome, { recursive: true });
      fs.writeFileSync(path.join(orcHome, 'settings.toml'), 'provider = "pi"\n[models]\npi = "openai/gpt-5"\nfuture = "x"\n');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
      const r = Bun.spawnSync([bin, 'settings', '--json'], { cwd: root, env: plainCliEnv({ ...env, ORC_HOME: orcHome }), stdout: 'pipe', stderr: 'pipe' });
      expect(r.exitCode).toBe(0);
      const view = JSON.parse(r.stdout.toString()) as Record<string, any>;
      expect(view.provider).toEqual({ value: 'pi', source: 'global', from: path.join(orcHome, 'settings.toml') });
      expect(view.models.pi.value).toBe('openai/gpt-5');
      expect(view.warnings).toEqual([`${path.join(orcHome, 'settings.toml')}: unknown setting(s) ignored: models.future`]);
    },
    60_000,
  );

  test(
    '--version / -V / --version --json report the package.json version (embedded)',
    () => {
      expect(built).toBe(true);
      for (const flag of ['--version', '-V']) {
        const r = Bun.spawnSync([bin, flag], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        expect(r.stdout.toString()).toBe(`orc ${PKG.version}\n`);
        expect(r.exitCode).toBe(0);
      }
      const j = Bun.spawnSync([bin, '--version', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      expect(JSON.parse(j.stdout.toString())).toEqual({ version: PKG.version });
      expect(j.exitCode).toBe(0);
    },
    60_000,
  );

  test(
    'the compiled orc daemon reports the package.json version on /health',
    async () => {
      expect(built).toBe(true);
      const orcHome = path.join(root, 'daemon-home');
      fs.mkdirSync(orcHome, { recursive: true });
      const proc = Bun.spawn([bin, 'daemon', '--bind', '127.0.0.1', '--port', '0', '--json'], {
        cwd: root,
        env: { ...envWithoutOrc(), ORC_HOME: orcHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const killer = setTimeout(() => proc.kill(), 30_000); // a hung daemon: EOF ends the read loop
      try {
        // The startup report ({ok, bind, port, ...}) is one pretty-printed JSON write.
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let startup: { port?: number } | undefined;
        while (startup === undefined) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`daemon exited before reporting its port: ${text}${await new Response(proc.stderr).text()}`);
          text += decoder.decode(value, { stream: true });
          try {
            startup = JSON.parse(text) as { port?: number };
          } catch {
            // incomplete: keep reading
          }
        }
        expect(startup.port).toBeGreaterThan(0);
        const res = await fetch(`http://127.0.0.1:${startup.port}/health`);
        expect(((await res.json()) as { version?: string }).version).toBe(PKG.version);
      } finally {
        clearTimeout(killer);
        proc.kill();
        await proc.exited;
      }
    },
    60_000,
  );

  test(
    'ignores a .env and a bunfig.toml in its cwd (built with --no-compile-autoload-*)',
    () => {
      expect(built).toBe(true);
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-autoload-'));
      fs.writeFileSync(path.join(cwd, '.env'), 'ORC_HOST=from-dotenv\n');
      // An autoloaded bunfig.toml this broken aborts the binary before orc's code runs.
      fs.writeFileSync(path.join(cwd, 'bunfig.toml'), '[[[ not toml\n');
      const orcHome = path.join(root, 'autoload-home');
      fs.mkdirSync(orcHome, { recursive: true });
      const r = Bun.spawnSync([bin, 'settings', '--json'], { cwd, env: { ...envWithoutOrc(), ORC_HOME: orcHome }, stdout: 'pipe', stderr: 'pipe' });
      expect(r.stderr.toString()).toBe('');
      expect(r.exitCode).toBe(0);
      const view = JSON.parse(r.stdout.toString()) as { host: { value: string | null; source: string } };
      expect(view.host).toMatchObject({ value: null, source: 'default' });
    },
    60_000,
  );

  test(
    'the compiled orc serves MCP over stdio (the SDK bundles; tools re-run the binary itself)',
    async () => {
      expect(built).toBe(true);
      const { Client } = await import('@modelcontextprotocol/client');
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
      const orcHome = path.join(root, 'mcp-home');
      fs.mkdirSync(orcHome, { recursive: true });
      fs.writeFileSync(path.join(orcHome, 'settings.toml'), 'provider = "pi"\n');
      for (const mode of ['legacy', 'auto'] as const) {
        const client = new Client({ name: 'compiled-mcp-test', version: '1.0.0' }, { versionNegotiation: { mode } });
        await client.connect(
          new StdioClientTransport({ command: bin, args: ['mcp'], cwd: root, env: { ...envWithoutOrc(), ORC_HOME: orcHome }, stderr: 'pipe' }),
        );
        try {
          expect(client.getProtocolEra()).toBe(mode === 'legacy' ? 'legacy' : 'modern');
          expect(client.getServerVersion()).toMatchObject({ name: 'orc', version: PKG.version });
          expect(client.getInstructions()).toContain('You are the LEAD');
          const tools = (await client.listTools()).tools.map((t) => t.name);
          expect(tools).toHaveLength(19);
          expect(tools).toContain('spawn');
          expect(tools).toContain('workflow_run');
          // Input validation (zod → JSON Schema → validation) works in the bundle.
          const invalid = (await client.callTool({ name: 'wait', arguments: { ids: [] } })) as { isError?: boolean };
          expect(invalid.isError).toBe(true);
          // A tool call runs `<binary> --no-color settings --json` and returns its JSON.
          const settings = (await client.callTool({ name: 'settings', arguments: {} })) as {
            isError?: boolean;
            structuredContent?: { provider?: { value?: string } };
          };
          expect(settings.isError).toBeFalsy();
          expect(settings.structuredContent?.provider?.value).toBe('pi');
          const list = (await client.callTool({ name: 'list', arguments: {} })) as { structuredContent?: unknown };
          expect(list.structuredContent).toEqual({ sessions: [] });
        } finally {
          await client.close();
        }
      }
    },
    60_000,
  );

  test('package.json compile:cli builds with the same flags', () => {
    for (const flag of COMPILE_FLAGS) expect(PKG.scripts['compile:cli']).toContain(flag);
  });

});
