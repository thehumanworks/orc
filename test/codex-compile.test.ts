/**
 * `bun build --compile` keeps the codex harness working: the compiled orc passes its
 * offline self-test (`orc __codex-harness --self-test`: embedded pi-ai OAuth loader,
 * Responses streaming, agent loop + bash tool, session file, transcript parser), and the
 * runtime drives the compiled harness through a turn against the fake OpenAI server.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexRuntime } from '../src/runtime/providers/codex.ts';
import type { ProviderEvent } from '../src/runtime/types.ts';
import { startFakeOpenAI, type FakeOpenAI } from './fixtures/openai-fake.ts';

const REPO = path.resolve(import.meta.dir, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-bin-')));
const bin = path.join(root, 'orc');
let fake: FakeOpenAI;
let built = false;

beforeAll(() => {
  fake = startFakeOpenAI();
  const r = Bun.spawnSync([process.execPath, 'build', '--compile', path.join(REPO, 'src', 'cli', 'index.ts'), '--outfile', bin], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(`bun build --compile failed: ${r.stderr.toString()}`);
  built = fs.existsSync(bin);
});

afterAll(() => {
  fake.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('compiled orc binary', () => {
  test(
    '__codex-harness --self-test passes offline (run outside the repo)',
    () => {
      expect(built).toBe(true);
      const r = Bun.spawnSync([bin, '__codex-harness', '--self-test'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const out = JSON.parse(r.stdout.toString().trim()) as { ok: boolean; checks: Array<{ check: string; ok: boolean }> };
      expect(out.checks.filter((c) => !c.ok)).toEqual([]);
      expect(out.ok).toBe(true);
      expect(out.checks.map((c) => c.check)).toContain('oauth-loader');
      expect(out.checks.map((c) => c.check)).toContain('settings-toml');
      expect(r.exitCode).toBe(0);
    },
    60_000,
  );

  test(
    'the compiled orc reads settings.toml (orc settings --json)',
    () => {
      expect(built).toBe(true);
      const orcHome = path.join(root, 'settings-home');
      fs.mkdirSync(orcHome, { recursive: true });
      fs.writeFileSync(path.join(orcHome, 'settings.toml'), 'provider = "pi"\n[models]\npi = "openai/gpt-5"\nfuture = "x"\n');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
      const r = Bun.spawnSync([bin, 'settings', '--json'], { cwd: root, env: { ...env, ORC_HOME: orcHome }, stdout: 'pipe', stderr: 'pipe' });
      expect(r.exitCode).toBe(0);
      const view = JSON.parse(r.stdout.toString()) as Record<string, any>;
      expect(view.provider).toEqual({ value: 'pi', source: 'global', from: path.join(orcHome, 'settings.toml') });
      expect(view.models.pi.value).toBe('openai/gpt-5');
      expect(view.warnings).toEqual([`${path.join(orcHome, 'settings.toml')}: unknown setting(s) ignored: models.future`]);
    },
    60_000,
  );

  test(
    'the runtime drives the compiled harness through a turn',
    async () => {
      const home = path.join(root, 'home');
      const orcHome = path.join(root, 'orc-home');
      fs.mkdirSync(path.join(orcHome, 'auth'), { recursive: true });
      fs.writeFileSync(
        path.join(orcHome, 'auth', 'chatgpt.json'),
        JSON.stringify({ openai: { type: 'oauth', access: 'tok-bin', refresh: 'rt', expires: Date.now() + 3_600_000, clientId: 'c', scopes: [] } }),
        { mode: 0o600 },
      );
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
      const state = fs.mkdtempSync(path.join(root, 'state-'));
      const rt = await createCodexRuntime({ argv: [bin] }).start({
        spec: { version: 1, sessionId: randomUUID(), provider: 'codex', cwd, env: {}, createdAt: new Date().toISOString() },
        resume: false,
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          ORC_HOME: orcHome,
          PI_CODING_AGENT_DIR: path.join(home, 'pi'),
          ORC_CODEX_TEST_ENDPOINT: fake.origin,
          OPENAI_API_KEY: '',
        },
        rawLogPath: path.join(state, 'provider.jsonl'),
      });
      const events: ProviderEvent[] = [];
      const done = (async () => {
        for await (const e of rt.events()) events.push(e);
      })();
      await rt.send('b1', 'hello compiled harness');
      const deadline = Date.now() + 20_000;
      while (!events.some((e) => e.type === 'turn.completed') && Date.now() < deadline) await Bun.sleep(20);
      await rt.close({ graceMs: 2_000 });
      await done;
      expect(events.map((e) => e.type)).toEqual(['ready', 'turn.started', 'assistant.text', 'turn.completed', 'exited']);
      expect((events[0] as Extract<ProviderEvent, { type: 'ready' }>).info).toMatchObject({ model: 'gpt-fake-1', authSource: 'orc' });
    },
    60_000,
  );
});
