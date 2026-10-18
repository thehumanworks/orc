/**
 * CLI colour end to end (from source, isolated ORC_HOME, fake provider): the global
 * `--color[=WHEN]` / `--no-color` flags, NO_COLOR / FORCE_COLOR / CLICOLOR_FORCE, `--json`
 * never styled (local, error and `--host` paths), a detached runner's log kept plain while
 * `workflow attach` colours it, hidden entrypoints untouched, and agent text made
 * terminal-safe on a TTY (a real pseudo-terminal) but never altered when piped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { extractColorFlag, extractHostFlag, isRunnerInvocation, terminalStylesFor } from '../src/cli/index.ts';
import { HELP_TEXT, renderWorkflowEvent, runnerLogWriter } from '../src/cli/output.ts';
import { serveDaemon } from '../src/daemon/server.ts';
import { readRegistry } from '../src/registry.ts';
import { Style, stripAnsi } from '../src/style.ts';
import { killSessionProcesses, mkTmp, TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';
import { workflowEvents } from './fixtures/render-fixtures.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 60_000;
const root = fs.realpathSync(mkTmp('orc-cli-colour-'));
const home = path.join(root, 'orc');
const work = path.join(root, 'work');
const daemonHome = path.join(root, 'daemon-home');
const sids: string[] = [];
const ESC = '\x1b';
const COLOUR_ENV = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'TERM'];

/** A prompt full of terminal escapes: title, clear screen, colour, OSC 8 link, a lone CR. */
const NASTY = `${ESC}]0;PWNED${ESC}\\hello ${ESC}[2J${ESC}[31mworld${ESC}[0m ${ESC}]8;;http://e.example${ESC}\\link${ESC}]8;;${ESC}\\ ok\rX`;

const prevHome = process.env.ORC_HOME;
let server: Bun.Server<undefined> | undefined;

beforeAll(() => {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(daemonHome, { recursive: true });
  // The in-process daemon (for the --host JSON check) serves its own ORC_HOME.
  process.env.ORC_HOME = daemonHome;
  server = serveDaemon({
    hostname: '127.0.0.1',
    port: 0,
    secret: 's3cret',
    allowlist: [],
    whois: async () => null,
    version: 'test',
    hostName: 'testhost',
  });
});

afterAll(async () => {
  server?.stop(true);
  for (const r of await readRegistry().catch(() => [])) sids.push(r.sessionId);
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
}, TEARDOWN_TIMEOUT_MS);

/** process.env without ORC_* and without any colour variable, plus this suite's ORC_HOME. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('ORC_') && !COLOUR_ENV.includes(k)) out[k] = v;
  }
  return { ...out, ORC_HOME: home, [FAKE_PROVIDER_ENV]: '1', ORC_DAEMON_SECRET: 's3cret', ...extra };
}

async function orc(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: work,
    env: env(extra),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** Bun.spawn's `terminal` option (a real PTY) — available on Bun versions that ship Bun.Terminal. */
const HAS_PTY = typeof (Bun as unknown as { Terminal?: unknown }).Terminal === 'function';

/** Run the CLI on a pseudo-terminal (stdout and stderr are the TTY); `\r\n` normalised. */
async function orcPty(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  let out = '';
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: work,
    env: env({ TERM: 'xterm-256color', ...extra }),
    terminal: {
      cols: 250,
      rows: 50,
      data(_t: unknown, d: Uint8Array) {
        out += decoder.decode(d, { stream: true });
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const code = await proc.exited;
  await Bun.sleep(150); // let the PTY drain
  return { code, out: out.replace(/\r\n/g, '\n') };
}

describe('global flag + per-stream decision (pure)', () => {
  test('extractColorFlag: forms, last one wins, invalid WHEN, stops at a literal --', () => {
    expect(extractColorFlag(['list'])).toEqual({ rest: ['list'] });
    expect(extractColorFlag(['--color', 'list'])).toEqual({ color: 'always', rest: ['list'] });
    expect(extractColorFlag(['list', '--color=never', '--json'])).toEqual({ color: 'never', rest: ['list', '--json'] });
    expect(extractColorFlag(['--color=auto', 'help'])).toEqual({ color: 'auto', rest: ['help'] });
    expect(extractColorFlag(['--no-color', 'help', '--color=always'])).toEqual({ color: 'always', rest: ['help'] });
    expect(extractColorFlag(['help', '--color=always', '--no-color'])).toEqual({ color: 'never', rest: ['help'] });
    expect(extractColorFlag(['--color=sometimes', 'list'])).toEqual({
      error: "invalid --color 'sometimes' (auto|always|never)",
      rest: ['list'],
    });
    expect(extractColorFlag(['--color=', 'list']).error).toBe("invalid --color '' (auto|always|never)");
    // `--` ends option parsing: it and everything after it are kept verbatim.
    expect(extractColorFlag(['send', 'x', '--', '--color', '--no-color'])).toEqual({
      rest: ['send', 'x', '--', '--color', '--no-color'],
    });
    expect(extractColorFlag(['--no-color', 'send', 'x', '--', '--color=always'])).toEqual({
      color: 'never',
      rest: ['send', 'x', '--', '--color=always'],
    });
    // Look-alikes are not ours; --host/--local are left for extractHostFlag.
    expect(extractColorFlag(['spawn', '--prompt=--color', '--colors', '--host', 'h']).rest).toEqual([
      'spawn',
      '--prompt=--color',
      '--colors',
      '--host',
      'h',
    ]);
    expect(extractHostFlag(extractColorFlag(['--color', '--host', 'studio', 'list', '--no-color']).rest)).toEqual({
      host: 'studio',
      rest: ['list'],
    });
  });

  test('terminalStylesFor: per stream; --json and detached runners never colour; TTY ⇒ sanitize', () => {
    const tty = { stdoutIsTTY: true, stderrIsTTY: true };
    const s1 = terminalStylesFor({ json: false, runner: false, env: {}, stdoutIsTTY: false, stderrIsTTY: true });
    expect([s1.out.color, s1.out.sanitize, s1.err.color, s1.err.sanitize]).toEqual([false, false, true, true]);
    const s2 = terminalStylesFor({ json: true, runner: false, env: { FORCE_COLOR: '1' }, mode: 'always', ...tty });
    expect([s2.out.color, s2.err.color]).toEqual([false, false]);
    expect(s2.out.sanitize).toBe(true); // human notices on a TTY are still made safe
    const s3 = terminalStylesFor({ json: false, runner: true, env: { FORCE_COLOR: '1' }, mode: 'always', ...tty });
    expect([s3.out.color, s3.err.color]).toEqual([false, false]);
    const s4 = terminalStylesFor({ json: false, runner: false, env: { NO_COLOR: '1' }, mode: 'always', stdoutIsTTY: false, stderrIsTTY: false });
    expect([s4.out.color, s4.out.sanitize, s4.err.color]).toEqual([true, false, true]);
    const s5 = terminalStylesFor({ json: false, runner: false, env: { FORCE_COLOR: '1' }, mode: 'never', ...tty });
    expect([s5.out.color, s5.err.color, s5.out.sanitize]).toEqual([false, false, true]);
  });

  test('isRunnerInvocation recognises the detached runner argv only', () => {
    expect(isRunnerInvocation('workflow', ['run', '/abs/wf.ts', '--run-id', 'r1'])).toBe(true);
    expect(isRunnerInvocation('workflow', ['retry', 'r1', '/abs/wf.ts', '--step', 'a', '--runner'])).toBe(true);
    expect(isRunnerInvocation('workflow', ['resume', 'r1', '/abs/wf.ts', '--runner'])).toBe(true);
    expect(isRunnerInvocation('workflow', ['run', '/abs/wf.ts'])).toBe(false);
    expect(isRunnerInvocation('list', ['--runner'])).toBe(false);
  });
});

describe('runnerLogWriter (orc workflow attach)', () => {
  const log = workflowEvents.map((e) => renderWorkflowEvent(e)).join('');
  const collect = (st: Style, chunks: string[]) => {
    let out = '';
    const w = runnerLogWriter(st, (t) => (out += t));
    for (const c of chunks) w.write(c);
    w.end();
    return out;
  };
  const chunked = (s: string, n: number) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n));

  test('piped without colour: an exact passthrough', () => {
    expect(collect(new Style(), chunked(`${log}${NASTY}`, 7))).toBe(`${log}${NASTY}`);
  });

  test('colour: complete lines styled like the live run, whatever the chunking', () => {
    const live = workflowEvents.map((e) => renderWorkflowEvent(e, new Style({ color: true }))).join('');
    for (const n of [1, 5, 64, log.length]) expect(collect(new Style({ color: true }), chunked(log, n))).toBe(live);
    // A trailing partial line is flushed (styled) by end().
    expect(collect(new Style({ color: true }), ['= run r1 done'])).toBe('\x1b[1m= run\x1b[22m \x1b[1mr1\x1b[22m \x1b[32m✓ done\x1b[39m');
  });

  test('TTY: escapes are removed even when split across chunks', () => {
    const tty = new Style({ sanitize: true });
    for (const n of [1, 2, 3, 9]) expect(collect(tty, chunked(NASTY, n))).toBe('hello world link okX');
  });
});

describe('orc help', () => {
  test('piped: exactly HELP_TEXT; FORCE_COLOR=1 styles it and stripping gives HELP_TEXT back', async () => {
    const plain = await orc(['help']);
    expect(plain.out).toBe(HELP_TEXT);
    const forced = await orc(['help'], { FORCE_COLOR: '1' });
    expect(forced.out).toContain(`${ESC}[1mUsage:${ESC}[22m`);
    expect(forced.out).toContain(`${ESC}[36m--color${ESC}[39m`);
    expect(stripAnsi(forced.out)).toBe(HELP_TEXT);
  }, T);

  test('precedence through the CLI: flags > NO_COLOR > FORCE_COLOR/CLICOLOR_FORCE > TERM=dumb > TTY', async () => {
    const coloured = (s: string) => s.includes(`${ESC}[`);
    expect(coloured((await orc(['help'], { NO_COLOR: '1', FORCE_COLOR: '1' })).out)).toBe(false);
    expect(coloured((await orc(['--no-color', 'help'], { FORCE_COLOR: '1' })).out)).toBe(false);
    expect(coloured((await orc(['help', '--color=never'], { CLICOLOR_FORCE: '1' })).out)).toBe(false);
    expect(coloured((await orc(['--color=always', 'help'], { NO_COLOR: '1' })).out)).toBe(true);
    expect(coloured((await orc(['--color', 'help'])).out)).toBe(true);
    expect(coloured((await orc(['help'], { CLICOLOR_FORCE: '1' })).out)).toBe(true);
    expect(coloured((await orc(['help'], { FORCE_COLOR: '0', CLICOLOR_FORCE: '1' })).out)).toBe(false);
    expect(coloured((await orc(['help'], { TERM: 'dumb', FORCE_COLOR: '1' })).out)).toBe(true);
    expect(coloured((await orc(['--color=auto', 'help'], { TERM: 'dumb' })).out)).toBe(false);
  }, T);

  test('an invalid --color value is an error (human and --json)', async () => {
    const bad = await orc(['--color=sometimes', 'list']);
    expect(bad.code).toBe(1);
    expect(bad.err).toBe("error: invalid --color 'sometimes' (auto|always|never)\n");
    const badJson = await orc(['list', '--color=sometimes', '--json'], { FORCE_COLOR: '1' });
    expect(badJson.code).toBe(1);
    expect(badJson.out).toBe(`${JSON.stringify({ error: "invalid --color 'sometimes' (auto|always|never)" })}\n`);
  }, T);

  test('a literal -- ends flag parsing: a --color after it is not ours', async () => {
    const r = await orc(['settings', '--', '--color']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(ESC);
    expect(r.out).toBe((await orc(['settings'])).out);
  }, T);
});

describe('--json is never styled', () => {
  test('list / settings / errors, even with FORCE_COLOR=1 and --color=always', async () => {
    const forced = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
    for (const args of [
      ['list', '--json'],
      ['list', '--all', '--json', '--color=always'],
      ['--color', 'settings', '--json'],
      ['remote', 'list', '--json', '--color=always'],
    ]) {
      const r = await orc(args, forced);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(ESC);
      expect(r.err).not.toContain(ESC);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
    const missing = await orc(['state', 'nope', '--json', '--color=always'], forced);
    expect(missing.code).toBe(1);
    expect(missing.out).toBe(`${JSON.stringify({ error: "no session found for 'nope'" })}\n`);
    expect(missing.err).toBe('');
    // The same error for a human: bold red label on stderr.
    const human = await orc(['state', 'nope'], forced);
    expect(human.err).toBe(`${ESC}[1;31merror:${ESC}[22;39m no session found for 'nope'\n`);
  }, T);

  test('over --host: the remote JSON paths stay clean; the human view is coloured', async () => {
    const host = ['--host', `127.0.0.1:${server!.port}`];
    const json = await orc([...host, 'list', '--all', '--json', '--color=always'], { FORCE_COLOR: '1' });
    expect(json.code).toBe(0);
    expect(json.out).not.toContain(ESC);
    expect(JSON.parse(json.out)).toEqual([]);
    const missing = await orc([...host, 'state', 'nope', '--json'], { FORCE_COLOR: '1' });
    expect(missing.code).toBe(1);
    expect(missing.out).not.toContain(ESC);
    expect(JSON.parse(missing.out)).toHaveProperty('error');
    const human = await orc([...host, 'list', '--all'], { FORCE_COLOR: '1' });
    expect(human.out).toBe(`${ESC}[2m(no sessions)${ESC}[22m\n`);
  }, T);

  test('empty states are dim when coloured, unchanged when not', async () => {
    const empty = { ORC_HOME: path.join(root, 'empty-home') }; // independent of test order
    expect((await orc(['remote', 'list'], { ...empty, FORCE_COLOR: '1' })).out).toBe(`${ESC}[2m(no peers)${ESC}[22m\n`);
    expect((await orc(['remote', 'list'], empty)).out).toBe('(no peers)\n');
    expect((await orc(['workflow', 'list'], { ...empty, FORCE_COLOR: '1' })).out).toBe(`${ESC}[2m(no runs)${ESC}[22m\n`);
    expect((await orc(['workflow', 'list'], empty)).out).toBe('(no runs)\n');
    expect((await orc(['list', '--all'], { ...empty, FORCE_COLOR: '1' })).out).toBe(`${ESC}[2m(no sessions)${ESC}[22m\n`);
  }, T);

  test('the removed harness is an unknown command with no protocol output, even with color forced', async () => {
    const r = await orc(['__codex-harness', '--self-test', '--json'], { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).not.toContain(ESC);
    expect(r.err).toContain("unknown command '__codex-harness'");
  }, T);
});

describe('sessions (fake provider)', () => {
  let id = '';

  beforeAll(async () => {
    const r = await orc(['spawn', '--provider', 'claude', '--prompt', NASTY, '--json']);
    if (r.code !== 0) throw new Error(`spawn failed: ${r.out}\n${r.err}`);
    const rec = JSON.parse(r.out) as { id: string; sessionId: string };
    sids.push(rec.sessionId);
    id = rec.id;
    const w = await orc(['wait', id, '--timeout', '15', '--json']);
    if (JSON.parse(w.out).state !== 'done') throw new Error(`wait: ${w.out}`);
  }, T);

  test('piped output is never altered: the agent text reaches the pipe byte for byte', async () => {
    const r = await orc(['read', id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`> ${NASTY}`);
    expect(r.out).toContain(`echo: ${NASTY}`);
    // Forced colour on a pipe: our SGR is added, the agent text is still untouched.
    const forced = await orc(['read', id], { FORCE_COLOR: '1' });
    expect(forced.out).toContain(`${ESC}[1;36m>${ESC}[22;39m ${NASTY}`);
    expect(forced.err).toBe(`${ESC}[2m(no on-disk transcript yet — showing the session journal; --raw for JSONL)${ESC}[22m\n`);
  }, T);

  test('read --raw (JSONL) and --json are never styled', async () => {
    const raw = await orc(['read', id, '--raw', '--color=always'], { FORCE_COLOR: '1' });
    expect(raw.out).not.toContain(ESC);
    for (const line of raw.out.trim().split('\n')) expect(typeof JSON.parse(line).seq).toBe('number');
    expect(raw.out).toBe((await orc(['read', id, '--raw'])).out);
    const json = await orc(['read', id, '--json'], { FORCE_COLOR: '1' });
    expect(json.out).not.toContain(ESC);
    expect(JSON.parse(json.out).journal.some((e: { text?: string }) => e.text === NASTY)).toBe(true);
  }, T);

  test('list / state / wait use the one status palette', async () => {
    const list = await orc(['list'], { FORCE_COLOR: '1' });
    expect(list.out).toContain(`${ESC}[1m${id}${ESC}[22m  claude ${ESC}[36m● running${ESC}[39m ${ESC}[32mdone${ESC}[39m`);
    expect((await orc(['state', id], { FORCE_COLOR: '1' })).out).toBe(`${ESC}[32m✓ done${ESC}[39m\n`);
    expect((await orc(['wait', id, '--timeout', '5'], { FORCE_COLOR: '1' })).out).toBe(`${ESC}[32m✓ done${ESC}[39m\n`);
    expect((await orc(['state', id])).out).toBe('done\n');
  }, T);

  test.skipIf(!HAS_PTY)('on a TTY, agent text is made terminal-safe — colour off or on', async () => {
    const off = await orcPty(['read', id], { NO_COLOR: '1' });
    expect(off.code).toBe(0);
    expect(off.out).not.toContain(ESC); // colour off and sanitized: no escape at all
    expect(off.out).toContain('> hello world link okX');
    expect(off.out).toContain('echo: hello world link okX');
    const on = await orcPty(['read', id]);
    expect(on.out).toContain(`${ESC}[1;36m>${ESC}[22;39m hello world link okX`); // auto: colour on a TTY
    expect(on.out).not.toContain(`${ESC}]`);
    expect(on.out).not.toContain(`${ESC}[2J`);
    expect(on.out).not.toContain(`${ESC}[31m`);
    expect(on.out).not.toContain('\r');
    // JSON on a TTY: never styled, never altered.
    const json = await orcPty(['list', '--json'], { FORCE_COLOR: '1' });
    expect(json.out).not.toContain(ESC);
    expect((JSON.parse(json.out) as { id: string }[]).some((r) => r.id === id)).toBe(true);
  }, T);
});

describe('detached workflow runner', () => {
  test('the runner log stays plain under FORCE_COLOR; workflow attach colours it (and only on request)', async () => {
    const file = path.join(work, 'colour.workflow.ts');
    fs.writeFileSync(
      file,
      `export default { name: 'colour', steps: [{ id: 'a', provider: 'claude', prompt: 'hi', allowUnverified: true }] };\n`,
    );
    const forced = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
    const launched = await orc(['workflow', 'run', file, '--detach', '--json'], forced);
    expect(launched.code).toBe(0);
    const { runId, logPath } = JSON.parse(launched.out) as { runId: string; logPath: string };
    const attach = await orc(['workflow', 'attach', runId], forced);
    expect(attach.code).toBe(0);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).not.toContain(ESC);
    expect(log).toContain('= run');
    // attach: each complete log line styled like a live run; stripping the codes gives the
    // log back with only the same-width markers swapped.
    expect(attach.out).toContain(`${ESC}[1m= run${ESC}[22m ${ESC}[1m${runId}${ESC}[22m ${ESC}[32m✓ done${ESC}[39m`);
    expect(stripAnsi(attach.out)).toBe(
      log
        .replace(/^ {2}\[ok\] /gm, '  ✓ ok ')
        .replace(/^ {2}\[FAIL\] /gm, '  ✗ FAIL ')
        .replace(/^ {2}- /gm, '  ● ')
        .replace(/^= run (\S+) done$/gm, '= run $1 ✓ done'),
    );
    expect(attach.err).toBe(`${ESC}[2m# run${ESC}[22m ${ESC}[1m${runId}${ESC}[22m ${ESC}[32m✓ done${ESC}[39m\n`);
    // Without colour, attach is a byte-for-byte passthrough of the log.
    const plain = await orc(['workflow', 'attach', runId]);
    expect(plain.out).toBe(log);
    expect(plain.err).toBe(`# run ${runId} done\n`);
  }, T);
});
