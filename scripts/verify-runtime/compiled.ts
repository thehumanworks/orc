#!/usr/bin/env bun
/**
 * Offline smoke for an already compiled ORC binary. The Pi and Claude executables are
 * compiled protocol fixtures, so the actor must re-execute the supplied ORC binary and
 * exercise its production adapters. There is no model request or authentication.
 *
 * bun scripts/verify-runtime/compiled.ts ./dist/orc
 * Nix passes --fixtures and --version because its inputs are separate store paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const binary = path.resolve(args.shift() ?? 'dist/orc');
let fixtures = path.join(repo, 'test', 'fixtures');
let expectedVersion: string | undefined;
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (!value || (flag !== '--fixtures' && flag !== '--version')) throw new Error(`unexpected smoke argument: ${flag}`);
  if (flag === '--fixtures') fixtures = path.resolve(value);
  else expectedVersion = value;
}
expectedVersion ??= (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string }).version;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-compiled-smoke-')));
const binDir = path.join(root, 'bin');
const home = path.join(root, 'home');
const orcHome = path.join(root, 'orc-home');
for (const dir of [binDir, home, orcHome]) fs.mkdirSync(dir, { mode: 0o700 });
const env: Record<string, string> = {
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  HOME: home,
  ORC_HOME: orcHome,
  ORC_CLAUDE_BIN: path.join(binDir, 'claude'),
  PI_CODING_AGENT_DIR: path.join(home, 'pi'),
  NO_COLOR: '1',
};
const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
const sessionIds = new Set<string>();

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run(argv: string[], cwd = root): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([binary, ...argv], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 25_000);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } finally {
    clearTimeout(timer);
  }
}

async function json<T = Record<string, unknown>>(argv: string[], cwd = root): Promise<T> {
  const result = await run([...argv, '--json'], cwd);
  assert(result.code === 0, `${argv.join(' ')} exited ${result.code}: ${result.out}${result.err}`);
  assert(result.err === '', `${argv.join(' ')} wrote unexpected stderr: ${result.err}`);
  return JSON.parse(result.out) as T;
}

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    checks.push({ check: name, ok: true });
    return true;
  } catch (error) {
    checks.push({ check: name, ok: false, detail: (error as Error).message });
    return false;
  }
}

function compileFixture(source: string, output: string): void {
  const result = Bun.spawnSync([
    process.execPath, 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', source, '--outfile', output,
  ], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  assert(result.exitCode === 0, `fixture compilation failed: ${result.stderr.toString()}`);
}

type ActorState = { lease?: { pid: number }; provider?: { pid: number } };
function actorState(id: string): ActorState {
  return JSON.parse(fs.readFileSync(path.join(orcHome, 'sessions', id, 'state.json'), 'utf8')) as ActorState;
}

async function waitDone(id: string): Promise<void> {
  const state = await json(['wait', id, '--timeout', '10']);
  assert(state.state === 'done' && state.timedOut === false, `session did not settle: ${JSON.stringify(state)}`);
}

async function providerSmoke(provider: 'pi' | 'claude'): Promise<void> {
  let id: string | undefined;
  const selectedModel = provider === 'pi' ? 'openai/gpt-5.4-mini' : 'haiku';
  const execution = await check(provider === 'pi' ? 'pi-openai-execution' : 'claude-execution', async () => {
    const cwd = path.join(root, `${provider}-cwd`);
    fs.mkdirSync(cwd);
    const record = await json<{ id: string; sessionId: string; provider: string; model?: string }>([
      'spawn', '--provider', provider, '--model', selectedModel, '--cwd', cwd,
      '--prompt', 'Reply with exactly one word: READY.',
    ]);
    // The short id is accepted by the CLI; kernel paths use the full session id.
    id = record.sessionId;
    sessionIds.add(id);
    assert(record.provider === provider && record.model === selectedModel, `wrong recorded provider/model: ${JSON.stringify(record)}`);
    await waitDone(id);
    const raw = await json<{ journal: Array<{ type: string; text?: string }> }>(['read', id, '--raw']);
    assert(raw.journal.some((entry) => entry.type === 'assistant.text' && entry.text?.includes('READY')), 'the adapter did not journal its assistant reply');
    if (provider === 'pi') {
      const parsed = await json<Array<{ role: string; text: string }>>(['read', id, '--full']);
      assert(Array.isArray(parsed), 'compiled Pi read fell back to the journal instead of parsing the provider transcript');
      assert(parsed.some((turn) => turn.role === 'user' && turn.text.includes('Reply with exactly one word: READY.')) &&
        parsed.some((turn) => turn.role === 'assistant' && turn.text === 'READY'), 'compiled Pi transcript parsing lost the conversation');
    }
    const sent = await json(['send', id, 'Reply with exactly one word: AGAIN.', '--idempotency-key', 'compiled-2']);
    assert(sent.phase === 'acknowledged' && sent.replayed === false, `first send not acknowledged: ${JSON.stringify(sent)}`);
    const replay = await json(['send', id, 'Reply with exactly one word: AGAIN.', '--idempotency-key', 'compiled-2']);
    assert(replay.replayed === true, 'duplicate submission was not recognized');
    const conflict = await run(['send', id, 'different prompt', '--idempotency-key', 'compiled-2', '--json']);
    assert(conflict.code === 1 && /conflict|different/i.test(conflict.out), 'conflicting duplicate was not refused');
    await waitDone(id);
    const journal = fs.readFileSync(path.join(orcHome, 'sessions', id, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert(journal.filter((entry) => entry.type === 'turn.intent' && entry.messageId === 'compiled-2').length === 1, 'duplicate submission created another turn intent');
  });
  if (!execution || !id) return;
  const sid = id;
  await check(`${provider}-lifecycle`, async () => {
    const previousActor = actorState(sid).lease?.pid;
    assert(previousActor, 'missing actor identity before crash');
    process.kill(previousActor, 'SIGKILL');
    let suspended = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const state = await json<{ suspended: boolean }>(['state', sid]);
      if (state.suspended) { suspended = true; break; }
      await Bun.sleep(10);
    }
    assert(suspended, 'killed actor did not become suspended');
    // The kernel uses PID/start-time identity and repairs the dead lease on wake.
    await json(['send', sid, 'Reply with exactly one word: RECOVERED.', '--idempotency-key', 'compiled-3']);
    await waitDone(sid);
    assert(actorState(sid).lease?.pid !== previousActor, 'crash recovery did not start a new actor');
    const takeover = await json<{ command: string }>(['takeover', sid]);
    const resumeFlag = provider === 'claude' ? '--resume' : '--session';
    assert(takeover.command.includes(provider) && takeover.command.includes(resumeFlag), 'takeover did not return the native resume command');
    const refused = await run(['send', sid, 'must not run', '--json']);
    assert(refused.code === 1 && refused.out.includes('resume'), 'taken-over session accepted a new prompt');
    await json(['resume', sid]);
    await json(['send', sid, 'Reply with exactly one word: RETURNED.', '--idempotency-key', 'compiled-4']);
    await waitDone(sid);
    await json(['kill', sid, '--purge']);
    assert(!fs.existsSync(path.join(orcHome, 'sessions', sid)), 'purge left session state behind');
    sessionIds.delete(sid);
  });
}

try {
  await check('version-help-settings', async () => {
    const version = await json(['--version']);
    assert(version.version === expectedVersion, `wrong embedded version: ${JSON.stringify(version)}`);
    const help = await run(['--help']);
    assert(help.code === 0 && /^Usage:/m.test(help.out), 'help did not print usage');
    fs.writeFileSync(path.join(orcHome, 'settings.toml'), 'provider = "pi"\n[models]\npi = "openai/gpt-5.4-mini"\n');
    const settings = await json<{ provider: { value: string }; models: { pi: { value: string } } }>(['settings']);
    assert(settings.provider.value === 'pi' && settings.models.pi.value === 'openai/gpt-5.4-mini', 'compiled TOML settings did not resolve');
    const removed = await run(['spawn', '--provider', 'codex', '--json']);
    assert(removed.code === 1 && /pi/i.test(removed.out), 'removed Codex provider lacks a Pi migration error');
  });
  await check('cwd-autoload-disabled', async () => {
    const cwd = path.join(root, 'autoload');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.env'), 'ORC_HOST=from-dotenv\n');
    fs.writeFileSync(path.join(cwd, 'bunfig.toml'), '[[[ not toml\n');
    const settings = await json<{ host: { value: string | null; source: string } }>(['settings'], cwd);
    assert(settings.host.value === null && settings.host.source === 'default', 'compiled binary autoloaded cwd configuration');
  });
  const fixturesBuilt = await check('protocol-fixtures', async () => {
    compileFixture(path.join(fixtures, 'pi-chat-fake.ts'), path.join(binDir, 'pi'));
    compileFixture(path.join(fixtures, 'claude-stream', 'fake-claude.ts'), path.join(binDir, 'claude'));
  });
  if (fixturesBuilt) {
    await providerSmoke('pi');
    await providerSmoke('claude');
  }
} finally {
  const failures: string[] = [];
  // A timed-out spawn or malformed CLI response can leave an actor before its id was
  // captured above. Every session directory belongs to this isolated smoke run.
  const sessions = path.join(orcHome, 'sessions');
  try {
    if (fs.existsSync(sessions)) for (const entry of fs.readdirSync(sessions, { withFileTypes: true })) {
      if (entry.isDirectory()) sessionIds.add(entry.name);
    }
  } catch (error) {
    failures.push(`enumerating sessions: ${(error as Error).message}`);
  }
  for (const id of sessionIds) {
    try {
      const result = await run(['kill', id, '--purge', '--json']);
      if (result.code !== 0 || fs.existsSync(path.join(sessions, id))) {
        failures.push(`purging ${id} exited ${result.code}: ${result.out}${result.err}`);
      }
    } catch (error) {
      failures.push(`purging ${id}: ${(error as Error).message}`);
    }
  }
  if (failures.length === 0) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`removing isolated state: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) checks.push({ check: 'cleanup', ok: false, detail: `${failures.join('; ')}; isolated state retained at ${root}` });
}
const ok = checks.every((entry) => entry.ok) && checks.length === 7;
process.stdout.write(`${JSON.stringify({ ok, checks })}\n`);
process.exitCode = ok ? 0 : 1;
