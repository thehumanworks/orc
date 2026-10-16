/**
 * S10 — `ORC_HOST` + settings.toml through the `orc` CLI (from source, fake provider): a
 * default host routes remote-capable commands to a daemon (a loopback test daemon with a
 * secret, its own ORC_HOME) with one stderr notice; `--local` wins; a project-local host must
 * be a trusted peer; host-local commands ignore default hosts; nested orc ignores them;
 * spawn and workflow steps pick provider/model defaults; a detached runner stays local.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { serveDaemon } from '../src/daemon/server.ts';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { readRegistry } from '../src/registry.ts';
import { killSessionProcesses, mkTmp } from './runtime-helpers.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 60_000;
const root = fs.realpathSync(mkTmp('orc-settings-cli-'));
const daemonHome = path.join(root, 'daemon-home');
const work = path.join(root, 'work');
const sids: string[] = [];
const prevHome = process.env.ORC_HOME;
const prevFake = process.env[FAKE_PROVIDER_ENV];
let server: Bun.Server<undefined>;
let daemonHost = '';

beforeAll(() => {
  // The daemon is in-process: it serves daemonHome; every CLI below uses its OWN ORC_HOME.
  process.env.ORC_HOME = daemonHome;
  process.env[FAKE_PROVIDER_ENV] = '1';
  fs.mkdirSync(work, { recursive: true });
  server = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: 's3cret',
    allowlist: [],
    whois: async () => null,
    version: 'test',
    hostName: 'testhost',
  });
  daemonHost = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  for (const r of await readRegistry()) sids.push(r.sessionId);
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  if (prevFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
  else process.env[FAKE_PROVIDER_ENV] = prevFake;
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A client: its own ORC_HOME and cwd (outside any git repo). */
function client(): { home: string; cwd: string } {
  const base = path.join(root, `c${n++}`);
  const home = path.join(base, 'orc-home');
  const cwd = path.join(base, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

/** process.env without any ORC_* (no inherited lineage/ORC_HOST even if the suite runs inside orc). */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
  return env;
}

async function orc(
  c: { home: string; cwd: string },
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: c.cwd,
    env: { ...cleanEnv(), ORC_HOME: c.home, ORC_DAEMON_SECRET: 's3cret', [FAKE_PROVIDER_ENV]: '1', ...extraEnv },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function daemonSessionIds(): Promise<string[]> {
  return (await readRegistry()).map((r) => r.id);
}

/** An unreachable "default host": a command that went there would fail. */
const DEAD_HOST = '127.0.0.1:1';

describe('default host routing', () => {
  test(
    'ORC_HOST routes list/spawn to the daemon with a stderr notice (stdout stays JSON); --local wins',
    async () => {
      const c = client();
      const spawned = await orc(c, ['spawn', '-p', 'claude', '--json'], { ORC_HOST: daemonHost });
      expect(spawned.code).toBe(0);
      expect(spawned.err).toBe(`orc: → ${daemonHost} (from ORC_HOST)\n`);
      const rec = JSON.parse(spawned.out) as { id: string; sessionId: string };
      sids.push(rec.sessionId);
      expect(await daemonSessionIds()).toContain(rec.id);

      const remote = await orc(c, ['list', '--all', '--json'], { ORC_HOST: daemonHost });
      expect(remote.code).toBe(0);
      expect(remote.err).toContain(`orc: → ${daemonHost}`);
      expect((JSON.parse(remote.out) as { id: string }[]).map((r) => r.id)).toContain(rec.id);

      // --local (anywhere in argv) beats ORC_HOST: this client's own (empty) registry.
      for (const args of [['--local', 'list', '--all', '--json'], ['list', '--all', '--json', '--local']]) {
        const local = await orc(c, args, { ORC_HOST: daemonHost });
        expect(local.code).toBe(0);
        expect(local.err).toBe('');
        expect(JSON.parse(local.out)).toEqual([]);
      }
      // --local beats an explicit --host too.
      const both = await orc(c, ['--local', '--host', DEAD_HOST, 'list', '--json']);
      expect(both.code).toBe(0);
      expect(JSON.parse(both.out)).toEqual([]);

      // An explicit --host is the user's own choice: no notice.
      const explicit = await orc(c, ['--host', daemonHost, 'state', rec.id, '--json'], { ORC_HOST: DEAD_HOST });
      expect(explicit.code).toBe(0);
      expect(explicit.err).toBe('');
      expect(JSON.parse(explicit.out)).toMatchObject({ id: rec.id });
    },
    T,
  );

  test(
    'a global settings host routes commands; spawn sends the provider/model defaults explicitly',
    async () => {
      const c = client();
      const g = write(
        path.join(c.home, 'settings.toml'),
        `host = "${daemonHost}"\nprovider = "claude"\n[models]\nclaude = "haiku-from-settings"\n`,
      );
      const r = await orc(c, ['spawn', '--json']);
      expect(r.code).toBe(0);
      expect(r.err).toBe(`orc: → ${daemonHost} (from ${g})\n`);
      const rec = JSON.parse(r.out) as { id: string; sessionId: string; provider: string; model: string };
      sids.push(rec.sessionId);
      expect(rec).toMatchObject({ provider: 'claude', model: 'haiku-from-settings' });
      expect((await readRegistry()).find((x) => x.id === rec.id)?.model).toBe('haiku-from-settings');

      // ORC_HOST="" = explicitly no default host: the settings host is ignored too.
      const none = await orc(c, ['list', '--json'], { ORC_HOST: '' });
      expect(none.code).toBe(0);
      expect(none.err).toBe('');
      expect(JSON.parse(none.out)).toEqual([]);
    },
    T,
  );

  test(
    'a project-local host must be a trusted peer: refused until `orc remote add`; --local/--host bypass',
    async () => {
      const c = client();
      const l = write(path.join(c.cwd, '.orc', 'settings.toml'), `host = "${daemonHost}"\n`);
      const refused = await orc(c, ['list', '--json']);
      expect(refused.code).toBe(1);
      const err = (JSON.parse(refused.out) as { error: string }).error;
      expect(err).toContain(l);
      expect(err).toContain('orc remote add 127.0.0.1');
      const human = await orc(c, ['list']);
      expect(human.code).toBe(1);
      expect(human.err).toStartWith(`error: host '${daemonHost}' from ${l} is not a trusted peer`);

      expect((await orc(c, ['--local', 'list', '--json'])).code).toBe(0);
      expect((await orc(c, ['--host', daemonHost, 'list', '--json'])).code).toBe(0);
      // ORC_HOST is the user's own intent and outranks the local file.
      expect((await orc(c, ['list', '--json'], { ORC_HOST: daemonHost })).code).toBe(0);

      // A peer on another port is not the same peer.
      expect((await orc(c, ['remote', 'add', '127.0.0.1'])).code).toBe(0);
      expect((await orc(c, ['list', '--json'])).code).toBe(1);
      expect((await orc(c, ['remote', 'add', '127.0.0.1', '--port', String(server.port)])).code).toBe(0);
      const trusted = await orc(c, ['list', '--json']);
      expect(trusted.code).toBe(0);
      expect(trusted.err).toBe(`orc: → ${daemonHost} (from ${l})\n`);
    },
    T,
  );

  test(
    'host-local commands ignore default hosts (never error); explicit --host keeps its error',
    async () => {
      const c = client();
      write(path.join(c.cwd, '.orc', 'settings.toml'), `host = "${DEAD_HOST}"\n`); // untrusted AND dead
      const env = { ORC_HOST: DEAD_HOST };
      for (const args of [['prune', '--json'], ['remote', 'list', '--json'], ['help'], ['login', 'status', '--json']]) {
        const r = await orc(c, args, env);
        expect(r.err).not.toContain('orc: →');
        expect(r.err).not.toContain('trusted peer');
        if (args[0] !== 'login') expect(r.code).toBe(0);
      }
      const st = await orc(c, ['settings', '--json'], env);
      expect(st.code).toBe(0);
      expect(JSON.parse(st.out).host).toMatchObject({ value: DEAD_HOST, source: 'env', from: 'ORC_HOST' });
      const noEnv = await orc(c, ['settings', '--json']);
      expect(JSON.parse(noEnv.out).host.note).toMatch(/refused: not a trusted peer/);

      const explicit = await orc(c, ['--host', DEAD_HOST, 'prune']);
      expect(explicit.code).toBe(1);
      expect(explicit.err).toContain("'prune' is not supported over --host");
      const settingsOverHost = await orc(c, ['--host', DEAD_HOST, 'settings']);
      expect(settingsOverHost.err).toContain("'settings' is not supported over --host");

      // list --all-hosts is the fleet view from here, not redirected (and no peer check).
      const fleet = await orc(c, ['list', '--all-hosts', '--json'], env);
      expect(fleet.code).toBe(0);
      expect(fleet.err).toBe('');
    },
    T,
  );

  test(
    'inside an orc session (lineage env) default hosts are ignored; --host still works',
    async () => {
      const c = client();
      write(path.join(c.home, 'settings.toml'), `host = "${DEAD_HOST}"\n`);
      const lineages: Record<string, string>[] = [{ ORC_PARENT_SESSION_ID: 'abcd1234' }, { ORC_DEPTH: '2' }];
      for (const lineage of lineages) {
        const r = await orc(c, ['list', '--json'], { ORC_HOST: DEAD_HOST, ...lineage });
        expect(r.code).toBe(0);
        expect(r.err).toBe('');
        expect(JSON.parse(r.out)).toEqual([]);
        const explicit = await orc(c, ['--host', daemonHost, 'list', '--all', '--json'], lineage);
        expect(explicit.code).toBe(0);
        expect((JSON.parse(explicit.out) as unknown[]).length).toBeGreaterThan(0);
      }
    },
    T,
  );

  test(
    'settings errors name the file; unknown keys warn once on stderr',
    async () => {
      const c = client();
      const g = write(path.join(c.home, 'settings.toml'), 'provider = "gpt"\n');
      const bad = await orc(c, ['list', '--json']);
      expect(bad.code).toBe(1);
      expect(JSON.parse(bad.out).error).toBe(`${g}: \`provider\` must be claude|codex|pi, got 'gpt'`);
      expect((await orc(c, ['settings'])).err).toContain(`error: ${g}: \`provider\``);
      write(g, 'host = \n');
      expect((await orc(c, ['state', 'x'])).err).toContain(`error: ${g}: invalid TOML`);
      write(g, 'colour = "blue"\n[models]\ngemini = "x"\n');
      const warned = await orc(c, ['list', '--json']);
      expect(warned.code).toBe(0);
      expect(warned.err).toBe(`orc: warning: ${g}: unknown setting(s) ignored: colour, models.gemini\n`);
      const badEnv = await orc(c, ['list'], { ORC_HOST: 'a b' });
      expect(badEnv.err).toContain("error: ORC_HOST: must be host or host:port, got 'a b'");
    },
    T,
  );
});

describe('provider/model defaults on this host', () => {
  test(
    'spawn: --provider > settings provider; --model > [models].<provider>; --agent owns its model',
    async () => {
      const c = client();
      write(path.join(c.home, 'settings.toml'), 'provider = "pi"\n[models]\nclaude = "global-claude"\npi = "openai/global-pi"\n');
      write(path.join(c.cwd, '.orc', 'settings.toml'), 'provider = "claude"\n[models]\nclaude = "local-claude"\n');
      const spawn = async (args: string[]) => {
        const r = await orc(c, ['spawn', ...args, '--json']);
        if (r.code !== 0) throw new Error(`${r.out}\n${r.err}`);
        expect(r.err).toBe('');
        const rec = JSON.parse(r.out) as { sessionId: string; provider: string; model?: string };
        sids.push(rec.sessionId);
        return rec;
      };
      expect(await spawn([])).toMatchObject({ provider: 'claude', model: 'local-claude' });
      expect(await spawn(['-p', 'pi'])).toMatchObject({ provider: 'pi', model: 'openai/global-pi' });
      expect(await spawn(['-m', 'explicit'])).toMatchObject({ provider: 'claude', model: 'explicit' });
      const agentRec = await spawn(['--agent', 'reviewer']);
      expect(agentRec.provider).toBe('claude');
      expect(agentRec.model).toBeUndefined();

      // The human spawn output shows the resolved model.
      const human = await orc(c, ['spawn']);
      expect(human.code).toBe(0);
      expect(human.out).toMatch(/model:\s+local-claude/);

      // No provider anywhere → the existing error.
      const bare = client();
      const none = await orc(bare, ['spawn', '--json']);
      expect(none.code).toBe(1);
      expect(JSON.parse(none.out).error).toMatch(/provider is required/);

      const view = await orc(c, ['settings', '--json']);
      expect(JSON.parse(view.out)).toMatchObject({
        provider: { value: 'claude', source: 'local' },
        models: { claude: { value: 'local-claude', source: 'local' }, pi: { value: 'openai/global-pi', source: 'global' } },
      });
    },
    T,
  );

  test(
    'workflow steps get [models].<provider>; the run records it and retry reuses it',
    async () => {
      const c = client();
      const g = write(path.join(c.home, 'settings.toml'), '[models]\nclaude = "wf-model"\n');
      // No predicate: the step ends `unverified`, the run `failed` — so it can be retried.
      const file = write(
        path.join(c.cwd, 'one.workflow.ts'),
        `export default { name: 'one', steps: [{ id: 'a', provider: 'claude', prompt: 'hi' }] };\n`,
      );
      type RunJson = { id: string; status: string; defaultModels: Record<string, string>; steps: { sessionId: string }[] };
      const r = await orc(c, ['workflow', 'run', file, '--json']);
      const run = JSON.parse(r.out) as RunJson;
      expect(run.status).toBe('failed');
      expect(run.defaultModels).toEqual({ claude: 'wf-model' });
      const modelOf = async (sessionId: string) => {
        const list = JSON.parse((await orc(c, ['list', '--all', '--json'])).out) as { id: string; sessionId: string; model?: string }[];
        const rec = list.find((x) => x.id === sessionId || x.sessionId === sessionId)!;
        sids.push(rec.sessionId);
        return rec.model;
      };
      expect(await modelOf(run.steps[0]!.sessionId)).toBe('wf-model');

      // A settings change after the run started does not switch the run's models.
      write(g, '[models]\nclaude = "changed"\n');
      const retried = await orc(c, ['workflow', 'retry', run.id, '--step', 'a', file, '--json']);
      const after = JSON.parse(retried.out) as RunJson;
      expect(after.id).toBe(run.id);
      expect(after.defaultModels).toEqual({ claude: 'wf-model' });
      expect(after.steps[0]!.sessionId).not.toBe(run.steps[0]!.sessionId);
      expect(await modelOf(after.steps[0]!.sessionId)).toBe('wf-model');

      // A new run picks up the new settings.
      const fresh = JSON.parse((await orc(c, ['workflow', 'run', file, '--json'])).out) as RunJson;
      expect(fresh.defaultModels).toEqual({ claude: 'changed' });
      expect(await modelOf(fresh.steps[0]!.sessionId)).toBe('changed');
    },
    T,
  );

  test(
    'a detached runner always runs here (--local), even when a default host is set',
    async () => {
      const c = client();
      write(path.join(c.home, 'settings.toml'), `host = "${DEAD_HOST}"\n[models]\nclaude = "detached-model"\n`);
      const file = write(
        path.join(c.cwd, 'det.workflow.ts'),
        `export default { name: 'det', steps: [{ id: 'a', provider: 'claude', prompt: 'hi', allowUnverified: true }] };\n`,
      );
      const launched = await orc(c, ['--local', 'workflow', 'run', file, '--detach', '--json']);
      expect(launched.code).toBe(0);
      const { runId } = JSON.parse(launched.out) as { runId: string };
      const attach = await orc(c, ['--local', 'workflow', 'attach', runId]);
      expect(attach.code).toBe(0);
      expect(attach.err).toContain(`# run ${runId} done`);
      const status = JSON.parse((await orc(c, ['--local', 'workflow', 'status', runId, '--json'])).out) as {
        status: string;
        defaultModels: Record<string, string>;
        steps: { sessionId: string }[];
      };
      expect(status.status).toBe('done');
      expect(status.defaultModels).toEqual({ claude: 'detached-model' });
      const list = JSON.parse((await orc(c, ['--local', 'list', '--all', '--json'])).out) as { id: string; sessionId: string; model?: string }[];
      const rec = list.find((x) => x.id === status.steps[0]!.sessionId)!;
      sids.push(rec.sessionId);
      expect(rec.model).toBe('detached-model');
    },
    T,
  );
});
