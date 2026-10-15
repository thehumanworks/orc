/**
 * codex harness through the actor kernel and the CLI — offline, against the fake OpenAI
 * server (test/fixtures/openai-fake.ts). Real detached `orc __actor` + `orc __codex-harness`
 * processes; isolated ORC_HOME / HOME / pi agent dir (the real ~/.orc and ~/.pi are never
 * touched).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, ensureAwake, interrupt as kernelInterrupt, readJournal, send, stop } from '../src/runtime/client.ts';
import { readActorState } from '../src/runtime/actor-state.ts';
import { writeSpawnSpec } from '../src/runtime/spec.ts';
import { ensureSessionDirs } from '../src/runtime/layout.ts';
import { sessionStatusOf } from '../src/session-status.ts';
import type { SpawnSpec } from '../src/runtime/types.ts';
import { cliEntryPath, isLiveProcess } from '../src/runtime/process.ts';
import { actorPids, entries, liveProcs, waitFor, waitForEntry } from './runtime-helpers.ts';
import { startFakeOpenAI, type FakeOpenAI } from './fixtures/openai-fake.ts';

const T = 60_000;
const prevOrcHome = process.env.ORC_HOME;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-k-')));
const orcHome = path.join(root, 'orc');
const userHome = path.join(root, 'home');
const piDir = path.join(userHome, '.pi', 'agent');
let fake: FakeOpenAI;
const sids: string[] = [];

const harnessPids = (sid: string) => liveProcs(`__codex-harness ${sid}`).map((r) => r.pid);

function seedOrcLogin(): void {
  const file = path.join(orcHome, 'auth', 'chatgpt.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      openai: { type: 'oauth', access: 'tok-k', refresh: 'rt-k', expires: Date.now() + 3_600_000, clientId: 'app_k', scopes: ['chatgpt.tokens.use.direct'] },
    }),
    { mode: 0o600 },
  );
}

/** Env ADDITIONS for the session (merged by the actor over its own env). */
function sessionEnv(): Record<string, string> {
  return { HOME: userHome, PI_CODING_AGENT_DIR: piDir, ORC_CODEX_TEST_ENDPOINT: fake.origin, OPENAI_API_KEY: '' };
}

function codexSpec(over: Partial<SpawnSpec> = {}): SpawnSpec {
  const sid = randomUUID();
  sids.push(sid);
  return {
    version: 1,
    sessionId: sid,
    provider: 'codex',
    cwd: fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-'))),
    env: sessionEnv(),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

async function outcome(sid: string, messageId: string, ms = 20_000) {
  return waitForEntry(
    sid,
    (e) => (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') && e.messageId === messageId,
    `outcome ${messageId}`,
    ms,
  );
}

function killAll(sid: string): void {
  for (const pid of [...actorPids(sid), ...harnessPids(sid)]) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* not a group leader */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
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

beforeAll(() => {
  fake = startFakeOpenAI();
  process.env.ORC_HOME = orcHome;
  seedOrcLogin();
});

beforeEach(() => {
  process.env.ORC_HOME = orcHome;
});

afterAll(async () => {
  for (const sid of sids) await stop(sid, { graceMs: 500, timeoutMs: 3_000 }).catch(() => {});
  for (const sid of sids) killAll(sid);
  fake.stop();
  if (prevOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevOrcHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codex harness through the actor kernel', () => {
  test(
    'fresh session: provider.ready (live default model) → turn.completed with usage in the journal',
    async () => {
      const spec = codexSpec();
      await createSession(spec);
      const ready = await waitForEntry(spec.sessionId, (e) => e.type === 'provider.ready', 'provider.ready', 20_000);
      expect(ready).toMatchObject({ providerSessionId: spec.sessionId, info: { model: 'gpt-fake-1', authSource: 'orc' } });
      const r = await send(spec.sessionId, { messageId: 'k1', text: 'hello kernel' });
      expect(r.verdict).toBe('acknowledged');
      const o = await outcome(spec.sessionId, 'k1');
      expect(o).toMatchObject({ type: 'turn.completed', result: 'ok', usage: { inputTokens: 17, outputTokens: 3 } });
      expect(entries(spec.sessionId, 'assistant.text', 'k1').map((e) => e.text)).toEqual(['ok']);
    },
    T,
  );

  test(
    'SIGKILL the actor → the harness sees stdin EOF and exits; wake resumes the history (one harness process)',
    async () => {
      const spec = codexSpec();
      await createSession(spec);
      await waitForEntry(spec.sessionId, (e) => e.type === 'provider.ready', 'provider.ready', 20_000);
      await send(spec.sessionId, { messageId: 'r1', text: 'remember the word OSPREY' });
      expect((await outcome(spec.sessionId, 'r1')).type).toBe('turn.completed');

      const lease = readActorState(spec.sessionId)!.lease!;
      const harnessBefore = harnessPids(spec.sessionId);
      expect(harnessBefore).toHaveLength(1);
      process.kill(lease.pid, 'SIGKILL');
      // The actor must be gone (not just signalled) or ensureAwake still sees a live lease.
      await waitFor(
        () => !isLiveProcess(lease) || undefined,
        `the SIGKILLed actor ${lease.pid} to die (state: ${JSON.stringify(readActorState(spec.sessionId))})`,
        15_000,
      );
      await waitFor(() => !pidAlive(harnessBefore[0]!) || undefined, 'the orphaned harness to exit on stdin EOF', 15_000);

      const woke = await ensureAwake(spec.sessionId);
      if (woke.status !== 'started') {
        throw new Error(`ensureAwake → ${woke.status}; actor state: ${JSON.stringify(readActorState(spec.sessionId))}`);
      }
      await waitForEntry(
        spec.sessionId,
        (e) => e.type === 'actor.started' && e.mode === 'resume',
        'actor.started resume',
        20_000,
      );
      const ready = readJournal(spec.sessionId).filter((e) => e.type === 'provider.ready').at(-1)!;
      expect(ready).toMatchObject({ info: { mode: 'resume', modelSource: 'session' } });
      const before = fake.responses().length;
      await send(spec.sessionId, { messageId: 'r2', text: 'FAKE:RECALL' });
      const o = await outcome(spec.sessionId, 'r2');
      expect(o).toMatchObject({ type: 'turn.completed', result: 'recall: remember the word OSPREY | FAKE:RECALL' });
      expect(fake.responses()[before]!.userTexts).toEqual(['remember the word OSPREY', 'FAKE:RECALL']);
      const after = harnessPids(spec.sessionId);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(harnessBefore[0]);
    },
    T,
  );

  test(
    'interrupt through the inbox → interrupt.acked + turn.interrupted (reason interrupt)',
    async () => {
      const spec = codexSpec();
      await createSession(spec);
      await waitForEntry(spec.sessionId, (e) => e.type === 'provider.ready', 'provider.ready', 20_000);
      await send(spec.sessionId, { messageId: 'i1', text: 'FAKE:SLOW go' });
      await waitFor(() => fake.openSlowStreams() > 0 || undefined, 'slow stream', 10_000);
      expect((await kernelInterrupt(spec.sessionId)).status).toBe('requested');
      const o = await outcome(spec.sessionId, 'i1');
      expect(o).toMatchObject({ type: 'turn.interrupted', reason: 'interrupt' });
      await waitForEntry(spec.sessionId, (e) => e.type === 'interrupt.acked', 'interrupt.acked', 5_000);
    },
    T,
  );

  test(
    'stop (orc kill) while bash runs: the command tree dies with the provider group',
    async () => {
      const spec = codexSpec();
      await createSession(spec);
      await waitForEntry(spec.sessionId, (e) => e.type === 'provider.ready', 'provider.ready', 20_000);
      const script = [{ tools: [{ name: 'bash', args: { command: 'sleep 300 & echo $! > child.pid; echo $$ > shell.pid; wait' } }] }];
      await send(spec.sessionId, { messageId: 'b1', text: `FAKE:SCRIPT ${JSON.stringify(script)}` });
      const childFile = path.join(spec.cwd, 'child.pid');
      await waitFor(() => (fs.existsSync(childFile) && fs.readFileSync(childFile, 'utf8').trim()) || undefined, 'bash child', 10_000);
      const child = Number(fs.readFileSync(childFile, 'utf8'));
      const harness = harnessPids(spec.sessionId)[0]!;
      expect(pidAlive(child)).toBe(true);
      await stop(spec.sessionId, { graceMs: 2_000 });
      await waitFor(() => !pidAlive(child) || undefined, 'bash child gone', 10_000);
      expect(pidAlive(harness)).toBe(false);
      const ended = entries(spec.sessionId, 'turn.interrupted', 'b1');
      expect(ended).toHaveLength(1);
    },
    T,
  );

  test('a codex session from the removed app-server runtime reports dead (not resumable)', () => {
    const spec = codexSpec({ providerSessionId: '019a0000-0000-7000-8000-00000000abcd' });
    ensureSessionDirs(spec.sessionId);
    writeSpawnSpec(spec);
    expect(sessionStatusOf({ sessionId: spec.sessionId, createdAt: spec.createdAt })).toBe('dead');
    // A harness session (provider session id = orc session id) without a live actor is resumable.
    const ok = codexSpec({ providerSessionId: undefined });
    ensureSessionDirs(ok.sessionId);
    writeSpawnSpec({ ...ok, providerSessionId: ok.sessionId });
    expect(sessionStatusOf({ sessionId: ok.sessionId, createdAt: ok.createdAt })).toBe('suspended');
  });
});

// ---------------------------------------------------------------------------------
// CLI end to end
// ---------------------------------------------------------------------------------

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
  }
  return { ...env, ORC_HOME: orcHome, ...sessionEnv(), ...extra };
}

async function orc(args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, cliEntryPath(), ...args], {
    cwd: opts.cwd ?? root,
    env: cliEnv(),
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe('orc CLI with --provider codex', () => {
  test(
    'spawn prints the live default model; read shows the reply; takeover prints pi --session; resume + kill',
    async () => {
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cli-')));
      const spawn = await orc(['spawn', '--provider', 'codex', '--cwd', cwd, '--prompt', 'hello from the cli', '--json']);
      expect(spawn.code).toBe(0);
      const rec = JSON.parse(spawn.out) as { id: string; sessionId: string; model?: string };
      sids.push(rec.sessionId);
      expect(rec.model).toBe('gpt-fake-1');
      const human = await orc(['list', '--all']);
      expect(human.out).toContain(rec.id);

      const wait = await orc(['wait', rec.id, '--for', 'done', '--timeout', '30', '--json']);
      expect(JSON.parse(wait.out).state).toBe('done');
      const read = await orc(['read', rec.id, '--json']);
      expect(read.code).toBe(0);
      expect(read.out).toContain('hello from the cli');
      expect(read.out).toContain('"ok"');

      const take = await orc(['takeover', rec.id]);
      expect(take.code).toBe(0);
      const sessionFile = path.join(orcHome, 'sessions', rec.sessionId, 'codex-session.jsonl');
      expect(take.out).toContain(`pi --session ${sessionFile}`);
      expect(take.out).toContain('signed in to OpenAI in pi');
      expect(harnessPids(rec.sessionId)).toEqual([]);

      const resumed = await orc(['resume', rec.id]);
      expect(resumed.code).toBe(0);
      const sent = await orc(['send', rec.id, 'FAKE:RECALL', '--json']);
      expect(JSON.parse(sent.out).phase).toBe('acknowledged');
      await orc(['wait', rec.id, '--for', 'done', '--timeout', '30']);
      const read2 = await orc(['read', rec.id, '--json']);
      expect(read2.out).toContain('recall: hello from the cli | FAKE:RECALL');

      const kill = await orc(['kill', rec.id]);
      expect(kill.code).toBe(0);
      expect(harnessPids(rec.sessionId)).toEqual([]);
    },
    T * 2,
  );

  test(
    'spawn without any credential fails with the login hint and leaves nothing behind',
    async () => {
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'cli-')));
      const auth = path.join(orcHome, 'auth', 'chatgpt.json');
      const saved = fs.readFileSync(auth);
      fs.rmSync(auth);
      try {
        const r = await orc(['spawn', '--provider', 'codex', '--cwd', cwd, '--json']);
        expect(r.code).toBe(1);
        expect(r.out + r.err).toContain('orc login chatgpt');
        expect(r.out + r.err).toContain('OPENAI_API_KEY');
      } finally {
        fs.writeFileSync(auth, saved, { mode: 0o600 });
      }
    },
    T,
  );

  test('login status / logout never print secrets', async () => {
    const s = await orc(['login', 'status', '--json']);
    expect(s.code).toBe(0);
    const st = JSON.parse(s.out);
    expect(st.active).toBe('orc');
    expect(st.orc.credential).toContain('chatgpt oauth');
    expect(s.out).not.toContain('tok-k');
    expect(s.out).not.toContain('rt-k');
  });
});

/** Port 1455 (pi-ai's fixed Sign in with ChatGPT callback port) is free on loopback. */
async function callbackPortFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(1455, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

describe('orc login chatgpt (offline: fake auth + token endpoints)', () => {
  test(
    'browser callback → token exchange → credential stored 0600 with the issued client id; device id persisted',
    async () => {
      if (!(await callbackPortFree())) {
        console.warn('[codex-kernel] port 1455 busy: login flow test skipped');
        return;
      }
      const home = fs.mkdtempSync(path.join(root, 'login-'));
      const env = { ...cliEnv(), ORC_HOME: path.join(home, 'orc') };
      const p = Bun.spawn([process.execPath, cliEntryPath(), 'login', 'chatgpt', '--no-browser'], {
        cwd: root,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let out = '';
      const reader = (async () => {
        const dec = new TextDecoder();
        for await (const c of p.stdout) out += dec.decode(c);
      })();
      await waitFor(() => /https:\/\/auth\.openai\.com\/\S+/.test(out) || undefined, 'authorize URL', 15_000);
      const url = new URL(/https:\/\/auth\.openai\.com\/\S+/.exec(out)![0]);
      expect(url.pathname).toBe('/api/accounts/authorize');
      expect(url.searchParams.get('agent_name_hint')).toBe('orc');
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
      const deviceId = fs.readFileSync(path.join(home, 'orc', 'auth', 'device-id'), 'utf8').trim();
      expect(url.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${deviceId}`);
      const tokenBefore = fake.tokenRequests().length;
      const cb = await fetch(
        `http://127.0.0.1:1455/auth/callback?code=code-123&state=${encodeURIComponent(url.searchParams.get('state')!)}&client_id=app_issued_login`,
      );
      expect(cb.status).toBe(200);
      const code = await p.exited;
      await reader;
      expect(code).toBe(0);
      expect(out).toContain('signed in with ChatGPT');
      expect(out).toContain('default codex model: gpt-fake-1');
      const tok = fake.tokenRequests()[tokenBefore]!;
      expect(tok.get('grant_type')).toBe('authorization_code');
      expect(tok.get('client_id')).toBe('app_issued_login');
      expect(tok.get('code')).toBe('code-123');
      const file = path.join(home, 'orc', 'auth', 'chatgpt.json');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const cred = JSON.parse(fs.readFileSync(file, 'utf8')).openai;
      expect(cred).toMatchObject({ type: 'oauth', clientId: 'app_issued_login' });
      expect(cred.scopes).toContain('chatgpt.tokens.use.direct');
      expect(out).not.toContain(cred.access);
      expect(await callbackPortFree()).toBe(true);
    },
    T,
  );

  test(
    'a pasted redirect URL completes the login (remote browser); a wrong one is rejected',
    async () => {
      if (!(await callbackPortFree())) {
        console.warn('[codex-kernel] port 1455 busy: pasted-redirect login test skipped');
        return;
      }
      const home = fs.mkdtempSync(path.join(root, 'login-paste-'));
      const env = { ...cliEnv(), ORC_HOME: path.join(home, 'orc') };
      const p = Bun.spawn([process.execPath, cliEntryPath(), 'login', 'chatgpt', '--no-browser'], {
        cwd: root,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let out = '';
      const reader = (async () => {
        const dec = new TextDecoder();
        for await (const c of p.stdout) out += dec.decode(c);
      })();
      await waitFor(() => /https:\/\/auth\.openai\.com\/\S+/.test(out) || undefined, 'authorize URL', 15_000);
      const url = new URL(/https:\/\/auth\.openai\.com\/\S+/.exec(out)![0]);
      const state = url.searchParams.get('state')!;
      p.stdin.write(`http://127.0.0.1:1455/auth/callback?code=pasted-code&state=${encodeURIComponent(state)}&client_id=app_pasted\n`);
      await p.stdin.flush();
      const code = await p.exited;
      await reader;
      expect(code).toBe(0);
      const cred = JSON.parse(fs.readFileSync(path.join(home, 'orc', 'auth', 'chatgpt.json'), 'utf8')).openai;
      expect(cred.clientId).toBe('app_pasted');
      expect(fs.statSync(path.join(home, 'orc', 'auth', 'device-id')).mode & 0o777).toBe(0o600);
      expect(fake.tokenRequests().at(-1)!.get('code')).toBe('pasted-code');
      expect(await callbackPortFree()).toBe(true);
    },
    T,
  );

  test(
    '--import-pi copies pi\'s login into orc\'s store; logout removes only orc\'s copy',
    async () => {
      const home = fs.mkdtempSync(path.join(root, 'import-'));
      const pi = path.join(home, 'pi');
      fs.mkdirSync(pi, { recursive: true });
      const cred = { type: 'oauth', access: 'tok-pi-import', refresh: 'rt-pi-import', expires: Date.now() + 3_600_000, clientId: 'app_pi_i', scopes: ['chatgpt.tokens.use.direct'] };
      fs.writeFileSync(path.join(pi, 'auth.json'), JSON.stringify({ openai: cred }), { mode: 0o600 });
      const env = { ...cliEnv(), ORC_HOME: path.join(home, 'orc'), PI_CODING_AGENT_DIR: pi };
      const run = async (args: string[]) => {
        const p = Bun.spawn([process.execPath, cliEntryPath(), ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
        const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, out: o + e };
      };
      expect(JSON.parse((await run(['login', 'status', '--json'])).out).active).toBe('pi');
      const imp = await run(['login', 'chatgpt', '--import-pi']);
      expect(imp.code).toBe(0);
      expect(imp.out).toContain('refresh independently');
      expect(JSON.parse(fs.readFileSync(path.join(home, 'orc', 'auth', 'chatgpt.json'), 'utf8')).openai).toEqual(cred);
      expect(JSON.parse((await run(['login', 'status', '--json'])).out).active).toBe('orc');
      const out = await run(['logout', 'chatgpt']);
      expect(out.code).toBe(0);
      expect(out.out).toContain("pi's ChatGPT login");
      expect(fs.existsSync(path.join(home, 'orc', 'auth', 'chatgpt.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(pi, 'auth.json'), 'utf8')).openai).toEqual(cred);
      expect(JSON.parse((await run(['login', 'status', '--json'])).out).active).toBe('pi');
    },
    T,
  );

  test(
    'an expired pi credential is refreshed by the harness against the token endpoint and written back to pi',
    async () => {
      const auth = path.join(orcHome, 'auth', 'chatgpt.json');
      const saved = fs.readFileSync(auth);
      fs.rmSync(auth);
      fs.rmSync(path.join(orcHome, 'cache'), { recursive: true, force: true });
      fs.mkdirSync(piDir, { recursive: true });
      const piFile = path.join(piDir, 'auth.json');
      fs.writeFileSync(
        piFile,
        JSON.stringify({
          'some-other': { type: 'api_key', key: 'keep' },
          openai: { type: 'oauth', access: 'tok-pi-expired', refresh: 'rt-pi-old', expires: Date.now() - 60_000, clientId: 'app_pi', scopes: ['chatgpt.tokens.use.direct'] },
        }),
        { mode: 0o600 },
      );
      try {
        const before = fake.tokenRequests().length;
        const spec = codexSpec();
        await createSession(spec);
        const ready = await waitForEntry(spec.sessionId, (e) => e.type === 'provider.ready', 'provider.ready', 20_000);
        expect(ready).toMatchObject({ info: { authSource: 'pi' } });
        const tok = fake.tokenRequests().slice(before);
        expect(tok).toHaveLength(1);
        expect(tok[0]!.get('grant_type')).toBe('refresh_token');
        expect(tok[0]!.get('refresh_token')).toBe('rt-pi-old');
        expect(tok[0]!.get('client_id')).toBe('app_pi');
        const pi = JSON.parse(fs.readFileSync(piFile, 'utf8'));
        expect(pi.openai.refresh).toMatch(/^rt-rotated-/);
        expect(pi['some-other']).toEqual({ type: 'api_key', key: 'keep' });
        expect(fs.existsSync(auth)).toBe(false); // never forked into orc's store
        expect(fake.modelRequests().at(-1)!.headers.authorization).toBe(`Bearer ${pi.openai.access}`);
        await stop(spec.sessionId, { graceMs: 1_000 });
      } finally {
        fs.rmSync(piFile, { force: true });
        fs.writeFileSync(auth, saved, { mode: 0o600 });
      }
    },
    T,
  );
});
