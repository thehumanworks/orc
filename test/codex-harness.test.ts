/**
 * codex harness (src/codex/*, src/runtime/providers/codex.ts) — offline tests against a
 * local fake OpenAI server (test/fixtures/openai-fake.ts). The REAL harness child
 * (`bun src/cli/index.ts __codex-harness <sid>`) is driven both directly through the
 * runtime factory and through the actor kernel. Every home is a temp dir: the real ~/.orc,
 * ~/.pi and ~/.codex are never touched, and no request leaves the machine.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels, type Credential } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  ChainedCredentialStore,
  CodexAuthError,
  NO_CREDENTIAL_MESSAGE,
  OrcChatGPTStore,
  PiAuthFileStore,
  PI_LOCK_STALE_MS,
  acquirePiAuthLock,
  orcChatGPTAuthPath,
  piAuthPath,
  resolveCodexAuth,
} from '../src/codex/auth.ts';
import { parseModelList, resolveModelId, CODEX_MODEL_CACHE_TTL_MS } from '../src/codex/models.ts';
import { applyEdits, createCodingTools, truncateHead, truncateTail } from '../src/codex/tools.ts';
import { loadSession, SessionFileWriter } from '../src/codex/session-file.ts';
import { composeSystemPrompt, defaultSystemPrompt, PI_AI_VERSION, PI_AGENT_CORE_VERSION } from '../src/codex/harness.ts';
import { rewriteUrl, testEndpoint } from '../src/codex/endpoint.ts';
import { codexRuntime, codexSessionFilePath, createCodexRuntime, isLegacyCodexSpec } from '../src/runtime/providers/codex.ts';
import type { ProviderEvent, ProviderLaunch, ProviderRuntime, SpawnSpec } from '../src/runtime/types.ts';
import { parsePi } from '../src/transcript.ts';
import { startFakeOpenAI, type FakeOpenAI } from './fixtures/openai-fake.ts';

const T = 30_000;
const prevOrcHome = process.env.ORC_HOME;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-h-')));
const orcHome = path.join(root, 'orc');
const userHome = path.join(root, 'home');
const piDir = path.join(userHome, '.pi', 'agent');
let fake: FakeOpenAI;
const live: ProviderRuntime[] = [];

/** Env for the harness child: temp homes, the fake endpoint, no inherited API key. */
function harnessEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ORC_HOME: orcHome,
    HOME: userHome,
    PI_CODING_AGENT_DIR: piDir,
    ORC_CODEX_TEST_ENDPOINT: fake.origin,
    OPENAI_API_KEY: '',
    ...extra,
  };
}

function oauthCred(over: Partial<Record<string, unknown>> = {}): Credential {
  return {
    type: 'oauth',
    access: 'tok-orc-1',
    refresh: 'rt-orc-1',
    expires: Date.now() + 3_600_000,
    clientId: 'app_issued_orc',
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    ...over,
  } as Credential;
}

function seedOrc(cred: Credential = oauthCred()): void {
  fs.mkdirSync(path.dirname(orcChatGPTAuthPath()), { recursive: true });
  fs.writeFileSync(orcChatGPTAuthPath(), JSON.stringify({ openai: cred }), { mode: 0o600 });
}

function seedPi(data: Record<string, unknown>): void {
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, 'auth.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearAuth(): void {
  fs.rmSync(path.join(orcHome, 'auth'), { recursive: true, force: true });
  fs.rmSync(path.join(orcHome, 'cache'), { recursive: true, force: true });
  fs.rmSync(path.join(userHome, '.pi'), { recursive: true, force: true });
}

function mkCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

function mkSpec(over: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    version: 1,
    sessionId: randomUUID(),
    provider: 'codex',
    cwd: mkCwd(),
    env: {},
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function mkLaunch(spec: SpawnSpec, resume = false, env: Record<string, string> = harnessEnv()): ProviderLaunch {
  const dir = path.join(root, 'state', spec.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return { spec, resume, env, rawLogPath: path.join(dir, 'provider.jsonl') };
}

class Collector {
  readonly events: ProviderEvent[] = [];
  readonly done: Promise<void>;
  constructor(rt: ProviderRuntime) {
    this.done = (async () => {
      for await (const e of rt.events()) this.events.push(e);
    })();
  }
  async waitFor(pred: (e: ProviderEvent) => boolean, label: string, ms = 15_000): Promise<ProviderEvent> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(this.types())}`);
      await Bun.sleep(10);
    }
  }
  outcome(messageId: string): Promise<ProviderEvent> {
    return this.waitFor(
      (e) => (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') && e.messageId === messageId,
      `outcome ${messageId}`,
    );
  }
  types(): string[] {
    return this.events.map((e) => ('messageId' in e && e.messageId ? `${e.type}:${e.messageId}` : e.type));
  }
  forMessage(id: string): ProviderEvent[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === id);
  }
}

async function start(spec: SpawnSpec, resume = false, env?: Record<string, string>) {
  const launch = mkLaunch(spec, resume, env);
  const rt = await codexRuntime.start(launch);
  live.push(rt);
  const c = new Collector(rt);
  const ready = (await c.waitFor((e) => e.type === 'ready', 'ready')) as Extract<ProviderEvent, { type: 'ready' }>;
  return { rt, c, ready, launch };
}

function groupMembers(pgid: number): number[] {
  const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,stat=']).stdout.toString();
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && f[1] === String(pgid) && !f[2]!.startsWith('Z'))
    .map((f) => Number(f[0]));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const st = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim();
  return st.length > 0 && !st.startsWith('Z');
}

async function closeAndCheck(rt: ProviderRuntime, c: Collector): Promise<void> {
  await rt.close({ graceMs: 2_000 });
  await c.done;
  expect(c.events.at(-1)!.type).toBe('exited');
  expect(c.types().filter((t) => t === 'exited')).toHaveLength(1);
  expect(groupMembers(rt.pid)).toEqual([]);
  const i = live.indexOf(rt);
  if (i >= 0) live.splice(i, 1);
}

beforeAll(() => {
  fake = startFakeOpenAI();
});

beforeEach(() => {
  process.env.ORC_HOME = orcHome;
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((rt) => rt.close({ graceMs: 500 }).catch(() => {})));
});

afterAll(() => {
  fake.stop();
  if (prevOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevOrcHome;
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------

describe('credential resolution (orc store → pi store → OPENAI_API_KEY → error)', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: userHome, PI_CODING_AGENT_DIR: piDir, ...extra });

  beforeEach(() => clearAuth());

  test('nothing configured → CodexAuthError naming `orc login chatgpt` and OPENAI_API_KEY', async () => {
    const err = await resolveCodexAuth(env()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as Error).message).toBe(NO_CREDENTIAL_MESSAGE);
    expect(NO_CREDENTIAL_MESSAGE).toContain('orc login chatgpt');
    expect(NO_CREDENTIAL_MESSAGE).toContain('OPENAI_API_KEY');
    // An empty OPENAI_API_KEY is "unset".
    expect(await resolveCodexAuth(env({ OPENAI_API_KEY: '' })).catch((e: unknown) => e)).toBeInstanceOf(CodexAuthError);
  });

  test('OPENAI_API_KEY only → env', async () => {
    const a = await resolveCodexAuth(env({ OPENAI_API_KEY: 'sk-test-key' }));
    expect(a.source).toBe('env');
    expect(a.label).toBe('api-key (OPENAI_API_KEY)');
    expect(a.accountKey).not.toContain('sk-test-key');
  });

  test("pi's ChatGPT login is used when orc has none (beats OPENAI_API_KEY); pi api_key entries are ignored", async () => {
    seedPi({ anthropic: { type: 'api_key', key: 'x' }, openai: oauthCred({ access: 'tok-pi' }) });
    const a = await resolveCodexAuth(env({ OPENAI_API_KEY: 'sk-test-key' }));
    expect(a.source).toBe('pi');
    expect(a.label).toContain(piAuthPath(env()));
    expect((await a.store.read('openai'))?.type).toBe('oauth');

    seedPi({ openai: { type: 'api_key', key: '!security find-generic-password' } });
    expect((await resolveCodexAuth(env({ OPENAI_API_KEY: 'sk-test-key' }))).source).toBe('env');
  });

  test('orc store wins over pi', async () => {
    seedPi({ openai: oauthCred({ access: 'tok-pi' }) });
    seedOrc(oauthCred({ access: 'tok-orc' }));
    const a = await resolveCodexAuth(env());
    expect(a.source).toBe('orc');
    expect(((await a.store.read('openai')) as { access: string }).access).toBe('tok-orc');
  });

  test('ORC_AUTH_DIR points every ORC_HOME at one shared store (lock kept beside it)', async () => {
    const shared = path.join(root, 'shared-auth');
    process.env.ORC_AUTH_DIR = shared;
    try {
      expect(orcChatGPTAuthPath()).toBe(path.join(shared, 'chatgpt.json'));
      await new OrcChatGPTStore().modify('openai', async () => oauthCred({ access: 'tok-shared' }));
      expect(JSON.parse(fs.readFileSync(path.join(shared, 'chatgpt.json'), 'utf8')).openai.access).toBe('tok-shared');
      expect(fs.existsSync(path.join(shared, '.locks'))).toBe(true);
      expect((await resolveCodexAuth(env())).source).toBe('orc');
    } finally {
      delete process.env.ORC_AUTH_DIR;
    }
    expect(orcChatGPTAuthPath()).toBe(path.join(orcHome, 'auth', 'chatgpt.json'));
  });

  test('PI_CODING_AGENT_DIR and ~ expansion follow pi', () => {
    expect(piAuthPath({ HOME: '/h' })).toBe('/h/.pi/agent/auth.json');
    expect(piAuthPath({ HOME: '/h', PI_CODING_AGENT_DIR: '~/custom' })).toBe('/h/custom/auth.json');
    expect(piAuthPath({ HOME: '/h', PI_CODING_AGENT_DIR: '/abs/dir' })).toBe('/abs/dir/auth.json');
  });
});

describe('OAuth refresh writes back to the store the credential came from', () => {
  beforeEach(() => clearAuth());

  /** Models whose OpenAI OAuth refresh is a stub (counts calls, rotates the refresh token). */
  function modelsWithStubRefresh(store: ChainedCredentialStore) {
    const base = openaiProvider();
    let calls = 0;
    const provider = {
      ...base,
      auth: {
        ...base.auth,
        oauth: {
          ...base.auth.oauth!,
          refresh: async (c: { refresh: string; clientId?: unknown }) => {
            calls++;
            return { ...oauthCred(), access: `access-new-${calls}`, refresh: `${c.refresh}-rotated`, clientId: c.clientId };
          },
        },
      },
    };
    const models = createModels({ credentials: store });
    models.setProvider(provider as typeof base);
    return { models, calls: () => calls };
  }

  test("an expiring pi credential is refreshed into pi's auth.json (other providers kept; orc store untouched)", async () => {
    seedPi({ anthropic: { type: 'api_key', key: 'keep-me' }, openai: oauthCred({ access: 'tok-pi-old', refresh: 'rt-pi', expires: Date.now() + 1_000 }) });
    const store = new ChainedCredentialStore(new OrcChatGPTStore(), new PiAuthFileStore(path.join(piDir, 'auth.json')));
    const { models, calls } = modelsWithStubRefresh(store);
    const auth = await models.getAuth('openai');
    expect(auth?.auth.apiKey).toBe('access-new-1');
    expect(calls()).toBe(1);
    const pi = JSON.parse(fs.readFileSync(path.join(piDir, 'auth.json'), 'utf8'));
    expect(pi.openai.refresh).toBe('rt-pi-rotated');
    expect(pi.openai.access).toBe('access-new-1');
    expect(pi.anthropic).toEqual({ type: 'api_key', key: 'keep-me' });
    expect(fs.existsSync(orcChatGPTAuthPath())).toBe(false);
    expect(fs.existsSync(`${path.join(piDir, 'auth.json')}.lock`)).toBe(false);
    // Fresh now: no second refresh.
    await models.getAuth('openai');
    expect(calls()).toBe(1);
  });

  test("an expiring orc credential is refreshed into orc's file (0600); pi's file untouched", async () => {
    const piBefore = { openai: oauthCred({ access: 'tok-pi', refresh: 'rt-pi' }) };
    seedPi(piBefore);
    seedOrc(oauthCred({ access: 'tok-orc-old', refresh: 'rt-orc', expires: Date.now() - 1 }));
    const store = new ChainedCredentialStore(new OrcChatGPTStore(), new PiAuthFileStore(path.join(piDir, 'auth.json')));
    const { models } = modelsWithStubRefresh(store);
    expect((await models.getAuth('openai'))?.auth.apiKey).toBe('access-new-1');
    const orc = JSON.parse(fs.readFileSync(orcChatGPTAuthPath(), 'utf8'));
    expect(orc.openai.refresh).toBe('rt-orc-rotated');
    expect(fs.statSync(orcChatGPTAuthPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(piDir, 'auth.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(piBefore)));
  });

  test("pi's lock convention: a fresh <auth.json>.lock dir is waited for; a stale one is reclaimed", async () => {
    seedPi({ openai: oauthCred() });
    const authFile = path.join(piDir, 'auth.json');
    const lockDir = `${authFile}.lock`;
    // Held by "pi": the write waits until pi releases it.
    fs.mkdirSync(lockDir);
    const store = new PiAuthFileStore(authFile);
    let finished = 0;
    const p = store.modify('openai', async (cur) => ({ ...(cur as object), access: 'after-wait' }) as Credential).then(() => {
      finished = Date.now();
    });
    await Bun.sleep(300);
    expect(finished).toBe(0);
    const released = Date.now();
    fs.rmdirSync(lockDir);
    await p;
    expect(finished).toBeGreaterThanOrEqual(released);
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).openai.access).toBe('after-wait');
    expect(fs.existsSync(lockDir)).toBe(false);

    // A lock older than pi's stale window is reclaimed at once.
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - PI_LOCK_STALE_MS - 5_000);
    fs.utimesSync(lockDir, old, old);
    const t0 = Date.now();
    await store.modify('openai', async (cur) => ({ ...(cur as object), access: 'after-stale' }) as Credential);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).openai.access).toBe('after-stale');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('the holder keeps the lock fresh (mtime refreshed while held)', async () => {
    seedPi({ openai: oauthCred() });
    const authFile = path.join(piDir, 'auth.json');
    const release = await acquirePiAuthLock(authFile);
    const lockDir = `${authFile}.lock`;
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lockDir, old, old);
    await Bun.sleep(2_300);
    expect(Date.now() - fs.statSync(lockDir).mtimeMs).toBeLessThan(3_000);
    release();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  test('orc never creates or logs out of pi\'s file', async () => {
    const store = new PiAuthFileStore(path.join(piDir, 'auth.json'));
    await expect(store.modify('openai', async () => oauthCred())).rejects.toThrow('does not exist');
    await expect(store.delete()).rejects.toThrow('pi');
    expect(fs.existsSync(path.join(piDir, 'auth.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------

describe('model listing + default selection', () => {
  test('Sign in with ChatGPT shape: visible slugs in server order', () => {
    expect(
      parseModelList(
        { models: [{ slug: 'b-model', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'a-model' }, { slug: 'b-model' }] },
        new Set(),
      ),
    ).toEqual(['b-model', 'a-model']);
  });

  test('API-key shape: only catalog chat models, newest first', () => {
    const known = new Set(['gpt-5.5', 'gpt-4o']);
    expect(
      parseModelList(
        { object: 'list', data: [{ id: 'gpt-4o', created: 1 }, { id: 'whisper-1', created: 9 }, { id: 'gpt-5.5', created: 5 }] },
        known,
      ),
    ).toEqual(['gpt-5.5', 'gpt-4o']);
    expect(() => parseModelList({ nope: 1 }, known)).toThrow('neither');
  });

  test('order: --model, then the session model, then the live default; failures ask for --model', async () => {
    const list = async () => ({ ids: ['live-1', 'live-2'], cached: false });
    expect(await resolveModelId({ specModel: 'flag-model', sessionModel: 's', list, authLabel: 'x' })).toEqual({ id: 'flag-model', source: 'flag' });
    expect(await resolveModelId({ sessionModel: 's', list, authLabel: 'x' })).toEqual({ id: 's', source: 'session' });
    expect(await resolveModelId({ list, authLabel: 'x' })).toEqual({ id: 'live-1', source: 'live-default', cached: false });
    const failing = async (): Promise<{ ids: string[]; cached: boolean }> => {
      throw new Error('HTTP 503');
    };
    await expect(resolveModelId({ list: failing, authLabel: 'chatgpt (orc)' })).rejects.toThrow(/HTTP 503.*pass --model <id>/);
    expect(CODEX_MODEL_CACHE_TTL_MS).toBeGreaterThan(0);
  });
});

describe('tools', () => {
  test('edit: exact unique replacements; not-found / ambiguous / overlapping are errors', () => {
    expect(applyEdits('a b c', [{ oldText: 'b', newText: 'B' }, { oldText: 'c', newText: 'C' }], 'f')).toBe('a B C');
    expect(() => applyEdits('a b', [{ oldText: 'x', newText: 'y' }], 'f')).toThrow('Could not find');
    expect(() => applyEdits('a a', [{ oldText: 'a', newText: 'y' }], 'f')).toThrow('Found 2 occurrences');
    expect(() => applyEdits('abcdef', [{ oldText: 'abc', newText: '' }, { oldText: 'cde', newText: '' }], 'f')).toThrow('overlap');
  });

  test('truncation keeps head (read) / tail (bash) within the line limit', () => {
    const many = Array.from({ length: 2_500 }, (_, i) => `line${i + 1}`).join('\n');
    const h = truncateHead(many);
    expect(h.truncated).toBe(true);
    expect(h.outputLines).toBe(2_000);
    expect(h.content.startsWith('line1\n')).toBe(true);
    const t = truncateTail(many);
    expect(t.content.endsWith('line2500')).toBe(true);
    expect(t.outputLines).toBe(2_000);
  });

  test('read/write/edit/ls/bash against a temp cwd (CRLF preserved, nonzero exit is an error result)', async () => {
    const cwd = mkCwd();
    const tools = Object.fromEntries(createCodingTools({ cwd, env: { ...process.env, HOME: userHome } }).map((t) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual(['bash', 'edit', 'ls', 'read', 'write']);
    const txt = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
    await tools.write!.execute('1', { path: 'sub/a.txt', content: 'one\r\ntwo\r\nthree\r\n' });
    expect(txt(await tools.read!.execute('2', { path: 'sub/a.txt', offset: 2, limit: 1 }))).toContain('two');
    await tools.edit!.execute('3', { path: 'sub/a.txt', edits: [{ oldText: 'two\nthree', newText: 'TWO\nTHREE' }] });
    expect(fs.readFileSync(path.join(cwd, 'sub/a.txt'), 'utf8')).toBe('one\r\nTWO\r\nTHREE\r\n');
    expect(txt(await tools.ls!.execute('4', {}))).toBe('sub/');
    const ok = await tools.bash!.execute('5', { command: 'echo out; echo err >&2' });
    expect(txt(ok)).toContain('out');
    expect(txt(ok)).toContain('err');
    const bad = await tools.bash!.execute('6', { command: 'exit 7' });
    expect(bad.isError).toBe(true);
    expect(txt(bad)).toContain('Command exited with code 7');
  });

  test('bash timeout kills the whole command tree', async () => {
    const cwd = mkCwd();
    const [, bash] = createCodingTools({ cwd, env: process.env });
    const t0 = Date.now();
    await expect(bash!.execute('1', { command: 'sleep 30 & echo $! > bg.pid; sleep 30', timeout: 0.5 })).rejects.toThrow('timed out');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const bg = Number(fs.readFileSync(path.join(cwd, 'bg.pid'), 'utf8'));
    await Bun.sleep(200);
    expect(pidAlive(bg)).toBe(false);
  });
});

describe('session file (pi v3) + system prompt', () => {
  test('active branch is replayed; torn tail tolerated', () => {
    const dir = mkCwd();
    const file = path.join(dir, 'codex-session.jsonl');
    const w = SessionFileWriter.create(file, { id: 's1', cwd: dir });
    w.appendModelChange('gpt-x');
    w.appendMessage({ role: 'user', content: 'first', timestamp: 1 } as never);
    w.close();
    // A pi branch: an entry whose parent is the model_change (sibling of "first"), appended last.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const modelChange = JSON.parse(lines[1]!);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'beef0001', parentId: modelChange.id, timestamp: 't', message: { role: 'user', content: 'branch', timestamp: 2 } })}\n{"type":"mess`);
    const s = loadSession(file);
    expect(s.header).toMatchObject({ type: 'session', version: 3, id: 's1', cwd: dir });
    expect(s.messages.map((m) => (m as { content: string }).content)).toEqual(['branch']);
    expect(s.modelId).toBe('gpt-x');
    expect(s.lastEntryId).toBe('beef0001');
    expect(s.skippedLines).toBe(1);
  });

  test('append = default prompt + file; replace = the file exactly', () => {
    const dir = mkCwd();
    const f = path.join(dir, 'p.md');
    fs.writeFileSync(f, 'PERSONA ✓');
    const spec = mkSpec({ cwd: dir, systemPrompt: { mode: 'append', path: f } });
    const now = new Date('2026-10-15T00:00:00Z');
    expect(composeSystemPrompt(spec, now)).toBe(`${defaultSystemPrompt(dir, now)}\n\nPERSONA ✓`);
    expect(composeSystemPrompt({ ...spec, systemPrompt: { mode: 'replace', path: f } }, now)).toBe('PERSONA ✓');
  });

  test('test endpoint override only accepts loopback http and rewrites both OpenAI origins', () => {
    expect(testEndpoint({ ORC_CODEX_TEST_ENDPOINT: 'http://127.0.0.1:9' })).toBe('http://127.0.0.1:9');
    expect(() => testEndpoint({ ORC_CODEX_TEST_ENDPOINT: 'https://evil.example' })).toThrow('loopback');
    expect(rewriteUrl('https://api.openai.com/v1/responses', 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9/v1/responses');
    expect(rewriteUrl('https://auth.openai.com/api/accounts/oauth/token', 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9/api/accounts/oauth/token');
    expect(rewriteUrl('https://example.com/x', 'http://127.0.0.1:9')).toBe('https://example.com/x');
  });

  test('pinned pi versions match the installed packages', () => {
    const v = (p: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'node_modules', '@earendil-works', p, 'package.json'), 'utf8')).version;
    expect(v('pi-ai')).toBe(PI_AI_VERSION);
    expect(v('pi-agent-core')).toBe(PI_AGENT_CORE_VERSION);
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@earendil-works/pi-ai']).toBe(PI_AI_VERSION);
    expect(pkg.dependencies['@earendil-works/pi-agent-core']).toBe(PI_AGENT_CORE_VERSION);
  });
});

// ---------------------------------------------------------------------------------
// The harness child through the runtime factory
// ---------------------------------------------------------------------------------

describe('codex runtime + harness child (fake Responses API)', () => {
  beforeEach(() => {
    clearAuth();
    seedOrc();
  });

  test(
    'fresh turn → ready (live default model) → assistant.text → turn.completed with usage; SIWC request shape',
    async () => {
      const spec = mkSpec();
      const before = fake.responses().length;
      const { rt, c, ready, launch } = await start(spec);
      expect(rt.provider).toBe('codex');
      expect(ready.providerSessionId).toBe(spec.sessionId);
      expect(ready.transcriptPath).toBe(codexSessionFilePath(launch.rawLogPath));
      expect(ready.info).toMatchObject({
        harness: 'orc-codex',
        mode: 'fresh',
        model: 'gpt-fake-1',
        modelSource: 'live-default',
        authSource: 'orc',
        piAi: PI_AI_VERSION,
        tools: ['read', 'bash', 'edit', 'write', 'ls'],
        endpoint: 'https://api.openai.com/v1/responses',
      });
      expect(fake.modelRequests().at(-1)!.headers.authorization).toBe('Bearer tok-orc-1');

      await rt.send('m1', 'hello there');
      const o = await c.outcome('m1');
      expect(c.forMessage('m1')).toEqual([
        { type: 'turn.started', messageId: 'm1' },
        { type: 'assistant.text', messageId: 'm1', text: 'ok' },
        { type: 'turn.completed', messageId: 'm1', result: 'ok', usage: { inputTokens: 17, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 } },
      ]);
      expect(o.type).toBe('turn.completed');
      const req = fake.responses()[before]!;
      expect(req.body.model).toBe('gpt-fake-1');
      expect(req.body.stream).toBe(true);
      expect(req.body.store).toBe(false);
      expect('max_output_tokens' in req.body).toBe(false);
      expect('temperature' in req.body).toBe(false);
      expect(req.headers.authorization).toBe('Bearer tok-orc-1');
      expect(req.headers['user-agent']).toStartWith('orc/');
      expect(req.kinds).toEqual(['developer', 'user']);
      expect(req.userTexts).toEqual(['hello there']);

      await closeAndCheck(rt, c);
      const turns = parsePi(fs.readFileSync(ready.transcriptPath!, 'utf8'));
      expect(turns).toEqual([
        { role: 'user', text: 'hello there' },
        { role: 'assistant', text: 'ok' },
      ]);
      const raw = fs.readFileSync(launch.rawLogPath, 'utf8');
      expect(raw).not.toContain('tok-orc-1');
      expect(fs.statSync(ready.transcriptPath!).mode & 0o777).toBe(0o600);
    },
    T,
  );

  test(
    'a catalog model (--model gpt-5.5) reports costUsd; the model list cache is reused',
    async () => {
      const a = await start(mkSpec());
      expect(a.ready.info?.modelListCached).toBe(false);
      await closeAndCheck(a.rt, a.c);
      const listed = fake.modelRequests().length;
      const b = await start(mkSpec());
      expect(b.ready.info).toMatchObject({ model: 'gpt-fake-1', modelListCached: true });
      expect(fake.modelRequests().length).toBe(listed);
      await closeAndCheck(b.rt, b.c);

      const { rt, c, ready } = await start(mkSpec({ model: 'gpt-5.5' }));
      expect(ready.info).toMatchObject({ model: 'gpt-5.5', modelSource: 'flag' });
      await rt.send('m1', 'hi');
      const o = (await c.outcome('m1')) as Extract<ProviderEvent, { type: 'turn.completed' }>;
      expect(o.type).toBe('turn.completed');
      expect(o.costUsd).toBeGreaterThan(0);
      await closeAndCheck(rt, c);
    },
    T,
  );

  test(
    'tool-call turn: bash + edit run in the cwd and round-trip their results',
    async () => {
      const spec = mkSpec();
      const { rt, c } = await start(spec);
      const script = [
        { tools: [{ name: 'bash', args: { command: "printf 'alpha\\nbeta\\n' > notes.txt && echo created-notes" } }] },
        { tools: [{ name: 'edit', args: { path: 'notes.txt', edits: [{ oldText: 'beta', newText: 'gamma ✓' }] } }] },
      ];
      const before = fake.responses().length;
      await rt.send('m1', `please FAKE:SCRIPT ${JSON.stringify(script)}`);
      const o = (await c.outcome('m1')) as Extract<ProviderEvent, { type: 'turn.completed' }>;
      expect(o.type).toBe('turn.completed');
      expect(fs.readFileSync(path.join(spec.cwd, 'notes.txt'), 'utf8')).toBe('alpha\ngamma ✓\n');
      const reqs = fake.responses().slice(before);
      expect(reqs).toHaveLength(3);
      expect(reqs[1]!.toolOutputs.join('')).toContain('created-notes');
      expect(reqs[2]!.toolOutputs.at(-1)).toContain('Successfully replaced 1 block(s) in notes.txt');
      expect(o.result).toContain('Successfully replaced');
      expect(o.usage?.inputTokens).toBe(30); // summed over the three model calls
      await closeAndCheck(rt, c);
    },
    T,
  );

  test(
    'multi-line prompt with quotes and unicode round-trips exactly; system prompt append reaches the request',
    async () => {
      const f = path.join(mkCwd(), 'persona.md');
      fs.writeFileSync(f, 'ORC-PERSONA ✓ "q"');
      const { rt, c } = await start(mkSpec({ systemPrompt: { mode: 'append', path: f } }));
      const prompt = 'line one\n  "double" and \'single\' quotes\n\ttab, backslash \\ and $HOME `cmd`\nunicode: ✓ 日本語 🚀 — é   sep\n\nlast line';
      const before = fake.responses().length;
      await rt.send('m1', prompt);
      await c.outcome('m1');
      const req = fake.responses()[before]!;
      expect(req.userTexts).toEqual([prompt]);
      const dev = (req.body.input as Array<{ role?: string; content?: unknown }>)[0]!;
      expect(dev.role).toBe('developer');
      expect(JSON.stringify(dev.content)).toContain('ORC-PERSONA ✓');
      expect(JSON.stringify(dev.content)).toContain('You are a coding agent running inside orc');
      await closeAndCheck(rt, c);
    },
    T,
  );

  test(
    'interrupt mid-stream → interrupt.acked + turn.interrupted; send refused while open; idle interrupt is a no-op; next turn works',
    async () => {
      const { rt, c } = await start(mkSpec());
      await rt.interrupt(); // idle → no-op
      await rt.send('m1', 'FAKE:SLOW please');
      await c.waitFor((e) => e.type === 'turn.started', 'turn.started');
      await waitUntil(() => fake.openSlowStreams() > 0, 'slow stream open');
      await expect(rt.send('m2', 'nope')).rejects.toThrow('still open');
      await rt.interrupt();
      expect((await c.outcome('m1')).type).toBe('turn.interrupted');
      await waitUntil(() => fake.openSlowStreams() === 0, 'slow stream closed by the abort');
      expect(c.types()).toEqual(['ready', 'turn.started:m1', 'interrupt.acked', 'turn.interrupted:m1']);
      await rt.send('m3', 'after');
      expect(await c.outcome('m3')).toMatchObject({ type: 'turn.completed', result: 'ok' });
      await closeAndCheck(rt, c);
    },
    T,
  );

  test(
    'provider 4xx → turn.failed (no retry); 5xx → retried, then turn.failed; the session stays usable',
    async () => {
      const { rt, c } = await start(mkSpec());
      let before = fake.responses().length;
      await rt.send('m1', 'FAKE:HTTP400');
      const f1 = (await c.outcome('m1')) as Extract<ProviderEvent, { type: 'turn.failed' }>;
      expect(f1.type).toBe('turn.failed');
      expect(f1.error).toContain('400');
      expect(f1.error).toContain('fake bad request');
      expect(fake.responses().length - before).toBe(1);

      before = fake.responses().length;
      await rt.send('m2', 'FAKE:HTTP500');
      const f2 = (await c.outcome('m2')) as Extract<ProviderEvent, { type: 'turn.failed' }>;
      expect(f2.type).toBe('turn.failed');
      expect(f2.error).toContain('500');
      expect(fake.responses().length - before).toBe(3); // 1 + DEFAULT_MAX_RETRIES

      await rt.send('m3', 'FAKE:USAGE_LIMIT');
      const f3 = (await c.outcome('m3')) as Extract<ProviderEvent, { type: 'turn.failed' }>;
      expect(f3.error).toContain('subscription_sharing_usage_limit_exceeded');

      await rt.send('m4', 'hello');
      expect(await c.outcome('m4')).toMatchObject({ type: 'turn.completed' });
      await closeAndCheck(rt, c);
    },
    T,
  );

  test(
    'close() mid-turn aborts it (turn.interrupted) and the partial reply is persisted; resume continues the history',
    async () => {
      const spec = mkSpec();
      const a = await start(spec);
      await a.rt.send('m1', 'remember PELICAN');
      await a.c.outcome('m1');
      await a.rt.send('m2', 'FAKE:SLOW long task');
      await waitUntil(() => fake.openSlowStreams() > 0, 'slow stream');
      await closeAndCheck(a.rt, a.c);
      expect(a.c.forMessage('m2').map((e) => e.type)).toEqual(['turn.started', 'turn.interrupted']);
      const saved = loadSession(a.ready.transcriptPath!);
      const roles = saved.messages.map((m) => m.role);
      expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
      expect((saved.messages.at(-1) as { stopReason?: string }).stopReason).toBe('aborted');

      const b = await start({ ...spec, providerSessionId: spec.sessionId, transcriptPath: a.ready.transcriptPath }, true);
      expect(b.ready.info).toMatchObject({ mode: 'resume', model: 'gpt-fake-1', modelSource: 'session', messageCount: 5 });
      const before = fake.responses().length;
      await b.rt.send('m3', 'FAKE:RECALL');
      const o = (await b.c.outcome('m3')) as Extract<ProviderEvent, { type: 'turn.completed' }>;
      expect(o.result).toBe('recall: remember PELICAN | FAKE:SLOW long task | FAKE:RECALL');
      expect(fake.responses()[before]!.kinds[0]).toBe('developer');
      await closeAndCheck(b.rt, b.c);
    },
    T,
  );

  test(
    'start failures: no credential, unlisted models without --model, a missing session file on resume, legacy app-server sessions',
    async () => {
      clearAuth();
      await expect(codexRuntime.start(mkLaunch(mkSpec()))).rejects.toThrow(NO_CREDENTIAL_MESSAGE);

      seedOrc();
      fake.setModels(503, { error: { message: 'listing unavailable' } });
      try {
        await expect(codexRuntime.start(mkLaunch(mkSpec()))).rejects.toThrow(/live model list.*HTTP 503.*pass --model/);
        // An explicit model needs no listing.
        const { rt, c, ready } = await start(mkSpec({ model: 'gpt-5.5' }));
        expect(ready.info?.model).toBe('gpt-5.5');
        await closeAndCheck(rt, c);
      } finally {
        fake.setModels(200, { models: [{ slug: 'gpt-fake-1', visibility: 'list' }] });
      }

      const spec = mkSpec();
      await expect(codexRuntime.start(mkLaunch({ ...spec, providerSessionId: spec.sessionId }, true))).rejects.toThrow(
        'no codex harness session file',
      );
      const legacy = { ...mkSpec(), providerSessionId: '019a0000-thread-id' };
      expect(isLegacyCodexSpec(legacy)).toBe(true);
      await expect(codexRuntime.start(mkLaunch(legacy, true))).rejects.toThrow('removed codex app-server runtime');
    },
    T,
  );

  test(
    'stdin EOF (the actor died): the harness aborts the turn, kills its bash commands and exits',
    async () => {
      const spec = mkSpec();
      const { rt, c } = await start(spec);
      const script = [{ tools: [{ name: 'bash', args: { command: 'echo $$ > shell.pid; sleep 300' } }] }];
      await rt.send('m1', `FAKE:SCRIPT ${JSON.stringify(script)}`);
      const pidFile = path.join(spec.cwd, 'shell.pid');
      await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0, 'bash started');
      const shellPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(groupMembers(rt.pid)).toContain(shellPid); // bash lives in the harness's group
      // Simulate the actor's death: only stdin closes (no abort, no signal).
      (rt as unknown as { endStdin(): void }).endStdin();
      await c.done;
      expect(c.events.at(-1)!.type).toBe('exited');
      expect(c.forMessage('m1').map((e) => e.type)).toEqual(['turn.started', 'turn.interrupted']);
      expect(pidAlive(shellPid)).toBe(false);
      expect(groupMembers(rt.pid)).toEqual([]);
      live.splice(live.indexOf(rt), 1);
    },
    T,
  );
});

describe('codex runtime with an explicit argv (factory options)', () => {
  test('a bad harness argv fails start() cleanly', async () => {
    clearAuth();
    seedOrc();
    const f = createCodexRuntime({ argv: [process.execPath, path.join(root, 'no-such-entry.ts')], bootTimeoutMs: 10_000 });
    await expect(f.start(mkLaunch(mkSpec()))).rejects.toThrow(/harness exited during startup/);
  });
});

async function waitUntil(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(10);
  }
}
