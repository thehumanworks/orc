#!/usr/bin/env bun
/**
 * One command that verifies orc's tmux-free runtime on an authenticated macOS or Linux host:
 *
 *   bun scripts/verify-runtime/all.ts [--providers claude,codex,pi] [--claude-model M]
 *       [--codex-model M] [--pi-model M] [--keep]
 *       [--claude-bin P] [--codex-bin P] [--pi-bin P] [--no-runtime-gates] [--no-e2e] [--no-workflow]
 *       [--results <file>]   (default: <repo>/verify-results.json)
 *
 * 1. Preflight: OS/arch, bun, each provider's binary + version (a missing provider is SKIP,
 *    never a failure). A `tmux` shim that logs its argv and exits 127 is first on PATH for
 *    everything below; the run fails if it is ever invoked.
 * 2. Runtime gates: scripts/verify-runtime/{claude,codex,pi}.ts as subprocesses.
 * 3. CLI end-to-end per provider, from source (`bun src/cli/index.ts`) with an isolated
 *    ORC_HOME and a temp git repo as cwd (see README.md for every check).
 * 4. A detached 2-step claude workflow followed with `orc workflow attach`.
 * 5. A PASS/FAIL/SKIP table on stdout + verify-results.json in the repo root (no env, no
 *    credentials, no emails). Exit 1 on any FAIL. Temp dirs are removed unless --keep.
 *
 * Safety: every orc call runs with a temp ORC_HOME (your ~/.orc is never touched), inherited
 * ORC_* lineage/test variables are dropped, and provider configs are never modified. Only
 * processes this run started are ever signalled. `--<p>-bin` points a provider at another
 * executable (e.g. test/fixtures/pi-chat-fake.ts) via a wrapper on PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeTranscript } from '../../src/runtime/providers/claude.ts';
import { isSameProcessAlive } from '../../src/runtime/process.ts';
import type { ProcessIdentity } from '../../src/runtime/types.ts';

// ---------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------

const PROVIDERS = ['claude', 'codex', 'pi'] as const;
type Provider = (typeof PROVIDERS)[number];

interface Args {
  providers: Provider[];
  results?: string;
  model: Partial<Record<Provider, string>>;
  bin: Partial<Record<Provider, string>>;
  keep: boolean;
  runtimeGates: boolean;
  e2e: boolean;
  workflow: boolean;
}

const USAGE = `usage: bun scripts/verify-runtime/all.ts [--providers claude,codex,pi] [--claude-model M]
       [--codex-model M] [--pi-model M] [--keep] [--claude-bin P] [--codex-bin P] [--pi-bin P]
       [--no-runtime-gates] [--no-e2e] [--no-workflow] [--results <file>]`;

function parseArgs(argv: string[]): Args {
  const a: Args = { providers: [...PROVIDERS], model: {}, bin: {}, keep: false, runtimeGates: true, e2e: true, workflow: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    const pm = /^--(claude|codex|pi)-(model|bin)$/.exec(k);
    if (k === '--providers') {
      const list = val()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of list) if (!(PROVIDERS as readonly string[]).includes(p)) throw new Error(`unknown provider '${p}'`);
      a.providers = list as Provider[];
    } else if (pm) {
      a[pm[2] as 'model' | 'bin'][pm[1] as Provider] = val();
    } else if (k === '--results') a.results = path.resolve(val());
    else if (k === '--keep') a.keep = true;
    else if (k === '--no-runtime-gates') a.runtimeGates = false;
    else if (k === '--no-workflow') a.workflow = false;
    else if (k === '--no-e2e') a.e2e = false;
    else if (k === '-h' || k === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${k}\n${USAGE}`);
  }
  return a;
}

// ---------------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Row {
  provider: string;
  check: string;
  status: Status;
  detail: string;
  ms: number;
}
const rows: Row[] = [];
const HOME = os.homedir();

/** No credentials, emails or home paths in anything we print or persist. */
function sanitize(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>')
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)([=: ]+)\S+/gi, '$1$2<redacted>')
    .replace(/"(accountUuid|organizationUuid|orgId|account_id|accountId|userId|email)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .split(HOME)
    .join('~');
}
const clip = (s: string, n = 140): string => {
  const one = sanitize(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function record(provider: string, check: string, status: Status, detail: string, ms = 0): void {
  const r: Row = { provider, check, status, detail: clip(detail), ms };
  rows.push(r);
  console.log(`  ${status.padEnd(4)}  ${provider.padEnd(8)} ${check}  (${(ms / 1000).toFixed(1)}s)  ${r.detail}`);
}

class StepRunner {
  private failed = false;
  constructor(private readonly provider: string) {}
  get ok(): boolean {
    return !this.failed;
  }
  async step(check: string, fn: () => Promise<string>): Promise<boolean> {
    if (this.failed) {
      record(this.provider, check, 'SKIP', 'earlier step failed');
      return false;
    }
    const t0 = Date.now();
    try {
      record(this.provider, check, 'PASS', await fn(), Date.now() - t0);
      return true;
    } catch (e) {
      this.failed = true;
      record(this.provider, check, 'FAIL', (e as Error)?.message ?? String(e), Date.now() - t0);
      return false;
    }
  }
  /** Runs regardless of earlier failures (cleanup / leak checks). */
  async always(check: string, fn: () => Promise<string>): Promise<boolean> {
    const t0 = Date.now();
    try {
      record(this.provider, check, 'PASS', await fn(), Date.now() - t0);
      return true;
    } catch (e) {
      this.failed = true;
      record(this.provider, check, 'FAIL', (e as Error)?.message ?? String(e), Date.now() - t0);
      return false;
    }
  }
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------------
// processes (ps works on macOS and Linux; zombies count as dead)
// ---------------------------------------------------------------------------------

interface Proc {
  pid: number;
  stat: string;
  cmd: string;
}
function psList(): Proc[] {
  const r = Bun.spawnSync(['ps', '-axww', '-o', 'pid=,stat=,command='], { stdout: 'pipe', stderr: 'ignore' });
  const out: Proc[] = [];
  for (const line of r.stdout.toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), stat: m[2]!, cmd: m[3]! });
  }
  return out;
}
const liveProcs = (): Proc[] => psList().filter((p) => !p.stat.startsWith('Z') && p.pid !== process.pid);
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(100);
  }
  return pred();
}
/** SIGKILL a process (and its group). Callers pass only pids this run started. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* gone / not a group */
    }
  }
}

/** Files under `dir` (depth-bounded) whose path matches `pred`. */
function findFiles(dir: string, pred: (file: string) => boolean, depth = 0): string[] {
  if (depth > 7) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, pred, depth + 1));
    else if (pred(p)) out.push(p);
  }
  return out;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Child processes (orc CLI calls, runtime gates) currently running for this run. */
const activeChildren = new Set<Bun.Subprocess>();

/**
 * Stop everything this run started under `root` (Ctrl-C path). Order matters: detached
 * workflow runners first (they would otherwise spawn new step sessions), then our own
 * child processes, then — twice, to catch an actor that registered late — every actor and
 * provider recorded in a state.json. Every pid is identity-checked (pid + start time).
 */
function stopEverythingUnder(root: string): void {
  const killId = (id: ProcessIdentity | undefined) => {
    if (id && isSameProcessAlive(id)) killTree(id.pid);
  };
  for (const f of findFiles(root, (f) => path.basename(path.dirname(f)) === 'runs' && f.endsWith('.json'))) {
    const run = readJson<{ runner?: ProcessIdentity }>(f);
    if (run?.runner) killId({ pid: run.runner.pid, startTime: run.runner.startTime ?? null });
  }
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    Bun.sleepSync(300);
    for (const f of findFiles(root, (f) => path.basename(f) === 'state.json')) {
      const st = readJson<{ lease?: ProcessIdentity; provider?: ProcessIdentity }>(f);
      killId(st?.lease);
      killId(st?.provider);
    }
  }
}

/** Every session id recorded in a registry.json under `root`. */
function sessionIdsUnder(root: string): string[] {
  const out: string[] = [];
  for (const f of findFiles(root, (f) => path.basename(f) === 'registry.json')) {
    for (const r of readJson<{ sessionId?: string }[]>(f) ?? []) if (r.sessionId) out.push(r.sessionId);
  }
  return out;
}

/** Remove the claude transcript dirs this run created (their slug embeds the temp root name). */
function removeClaudeTranscripts(root: string, sids: Iterable<string>, env: Record<string, string>): void {
  const marker = path.basename(root);
  for (const sid of sids) {
    const t = resolveClaudeTranscript(sid, env);
    if (t && path.basename(path.dirname(t)).includes(marker)) {
      fs.rmSync(path.dirname(t), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------------

const REPO = path.resolve(import.meta.dir, '..', '..');
const CLI = path.join(REPO, 'src', 'cli', 'index.ts');
const BUN = process.execPath;
const BIN_ENV: Record<Provider, string | undefined> = { claude: 'ORC_CLAUDE_BIN', codex: 'ORC_CODEX_BIN', pi: undefined };

/** process.env minus ORC_* (except provider bin overrides), with the shim dir first on PATH. */
function baseEnv(shimDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = new Set(['ORC_CLAUDE_BIN', 'ORC_CODEX_BIN', 'ORC_CLAUDE_KEEP_ENV']);
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('ORC_') && !keep.has(k)) continue;
    env[k] = v;
  }
  env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`;
  return env;
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** Resolve a provider the way its runtime does (bin env override, else PATH). */
function resolveBin(p: Provider, env: Record<string, string>): string | undefined {
  const override = BIN_ENV[p] ? env[BIN_ENV[p]!] : undefined;
  if (override) {
    if (override.includes('/')) return fs.existsSync(override) ? override : undefined;
    return Bun.which(override, { PATH: env.PATH }) ?? undefined;
  }
  return Bun.which(p, { PATH: env.PATH }) ?? undefined;
}

function versionOf(bin: string, env: Record<string, string>): string {
  const r = Bun.spawnSync([bin, '--version'], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 20_000 });
  const text = (r.stdout.toString() || r.stderr.toString()).trim().split('\n')[0] ?? '';
  return r.exitCode === 0 ? text || '?' : `? (--version exited ${r.exitCode})`;
}

// ---------------------------------------------------------------------------------
// orc CLI from source
// ---------------------------------------------------------------------------------

interface Ctx {
  provider: string;
  home: string;
  repo: string;
  env: Record<string, string>;
}
interface Run {
  code: number;
  out: string;
  err: string;
}

async function orc(ctx: Ctx, args: string[], timeoutMs = 240_000): Promise<Run> {
  const proc = Bun.spawn([BUN, CLI, ...args], {
    cwd: ctx.repo,
    env: { ...ctx.env, ORC_HOME: ctx.home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  activeChildren.add(proc);
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } finally {
    clearTimeout(timer);
    activeChildren.delete(proc);
  }
}

async function orcJson<T = Record<string, unknown>>(ctx: Ctx, args: string[], timeoutMs?: number): Promise<T> {
  const r = await orc(ctx, [...args, '--json'], timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    throw new Error(`orc ${args[0]} exited ${r.code}: ${r.err || r.out}`);
  }
  if (r.code !== 0) {
    const msg = (parsed as { error?: string })?.error ?? (r.err || r.out);
    throw new Error(`orc ${args[0]} exited ${r.code}: ${msg}`);
  }
  return parsed as T;
}

function readState(ctx: Ctx, sid: string): { lease?: ProcessIdentity; provider?: ProcessIdentity; phase?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.home, 'sessions', sid, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function waitDone(ctx: Ctx, id: string): Promise<string> {
  const w = await orcJson<{ state: string; timedOut: boolean; elapsedMs: number }>(
    ctx,
    ['wait', id, '--for', 'settled', '--timeout', '300'],
    330_000,
  );
  check(!w.timedOut && w.state === 'done', `wait → ${w.state}${w.timedOut ? ' (timed out)' : ''}`);
  return `done in ${(w.elapsedMs / 1000).toFixed(1)}s`;
}

/**
 * The latest parsed turn (`orc read --json`) must hold an ASSISTANT reply containing
 * `word`. The prompt itself contains the word, so only assistant text counts, and the
 * journal fallback (`{fallback: true}` — no provider transcript on disk) is a failure.
 * Retries briefly: a provider may flush its transcript just after the turn's result.
 */
async function replyContains(ctx: Ctx, id: string, word: string): Promise<string> {
  let last = '';
  const deadline = Date.now() + 10_000;
  while (true) {
    const r = await orc(ctx, ['read', id, '--json']);
    check(r.code === 0, `read exited ${r.code}: ${r.err}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.out);
    } catch {
      throw new Error(`read --json is not JSON: ${clip(r.out, 100)}`);
    }
    if (Array.isArray(parsed)) {
      const reply = parsed
        .filter((t: { role?: string }) => t?.role === 'assistant')
        .map((t: { text?: string }) => String(t?.text ?? ''))
        .join('\n');
      if (reply.toUpperCase().includes(word.toUpperCase())) return `assistant: "${clip(reply, 60)}"`;
      last = reply ? `assistant reply lacks ${word}: "${clip(reply, 80)}"` : 'no assistant turn in the latest read';
    } else {
      last = (parsed as { fallback?: boolean })?.fallback
        ? 'no provider transcript on disk (read fell back to the journal)'
        : `unexpected read shape: ${clip(r.out, 80)}`;
    }
    if (Date.now() >= deadline) throw new Error(last);
    await Bun.sleep(500);
  }
}

function mkRepo(dir: string, env: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, env, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  };
  // Neutral settings: no hooks, no signing prompts (a signed-commit setup would block), no
  // default-branch hint. The user's git config is read, never written.
  const neutral = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
  git([...neutral, 'init', '-q']);
  git([...neutral, '-c', 'user.name=orc-verify', '-c', 'user.email=orc-verify@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
}

// ---------------------------------------------------------------------------------
// 3. CLI end-to-end per provider
// ---------------------------------------------------------------------------------

const claudeSids = new Set<string>();

async function cliE2E(p: Provider, ctx: Ctx, model: string | undefined): Promise<void> {
  const s = new StepRunner(p);
  const tag = Math.floor(1000 + Math.random() * 9000);
  const CODEWORD = `ORCHID${tag}`;
  let id = '';
  let sid = '';
  const providers = new Map<number, ProcessIdentity>();
  const notePids = () => {
    const st = sid ? readState(ctx, sid) : {};
    if (st.provider?.pid) providers.set(st.provider.pid, st.provider);
    return st;
  };
  try {
    await s.step('e2e spawn (3-line prompt) → wait done', async () => {
      const spawned = await orcJson<{ id: string; sessionId: string; runtime?: string }>(ctx, [
        'spawn',
        '--provider',
        p,
        ...(model ? ['--model', model] : []),
        '--prompt',
        `Remember the codeword ${CODEWORD}.\nDo not use any tools.\nReply with exactly one word: MANGO`,
      ]);
      id = spawned.id;
      sid = spawned.sessionId;
      if (p === 'claude') claudeSids.add(sid);
      check(spawned.runtime === 'actor', `record runtime=${spawned.runtime}`);
      notePids();
      return `${id} ${await waitDone(ctx, id)}`;
    });
    await s.step('e2e read → assistant reply word', () => replyContains(ctx, id, 'MANGO'));
    await s.step('e2e send --idempotency-key k2 (+ replay)', async () => {
      const prompt = 'Do not use any tools. Reply with exactly one word: KIWI';
      const a = await orcJson<{ phase: string; replayed: boolean }>(ctx, ['send', id, prompt, '--idempotency-key', 'k2']);
      check(a.phase === 'acknowledged' || a.phase === 'queued', `phase ${a.phase}`);
      check(a.replayed === false, 'first send reported replayed');
      const b = await orcJson<{ phase: string; replayed: boolean }>(ctx, ['send', id, prompt, '--idempotency-key', 'k2']);
      check(b.replayed === true, 'replay not reported as replayed');
      await waitDone(ctx, id);
      return `phase ${a.phase}; replay → replayed:true; ${await replyContains(ctx, id, 'KIWI')}`;
    });
    let oldProvider: ProcessIdentity | undefined;
    await s.step('e2e SIGKILL actor → list shows suspended', async () => {
      const st = notePids();
      const actor = st.lease;
      check(actor && isSameProcessAlive(actor), 'no live actor in state.json');
      oldProvider = st.provider;
      process.kill(actor.pid, 'SIGKILL');
      let status = '';
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        const list = await orcJson<{ id: string; status: string }[]>(ctx, ['list']);
        status = list.find((r) => r.id === id)?.status ?? 'missing';
        if (status === 'suspended') break;
        await Bun.sleep(300);
      }
      check(status === 'suspended', `list status ${status}`);
      return `actor ${actor.pid} killed; status suspended`;
    });
    await s.step('e2e send wakes it and recalls the codeword', async () => {
      const r = await orcJson<{ phase: string }>(ctx, [
        'send',
        id,
        'Do not use any tools. What codeword did I ask you to remember? Reply with only the codeword.',
      ]);
      check(r.phase === 'acknowledged' || r.phase === 'queued', `phase ${r.phase}`);
      await waitDone(ctx, id);
      return `woke (${r.phase}); ${await replyContains(ctx, id, CODEWORD)}`;
    });
    await s.step('e2e exactly one provider process for the session', async () => {
      const st = notePids();
      const fresh = st.provider;
      check(fresh && isSameProcessAlive(fresh), 'no live provider recorded after wake');
      check(fresh.pid !== oldProvider?.pid, 'provider pid did not change across the wake');
      const gone = await until(() => !isSameProcessAlive(oldProvider), 10_000);
      check(gone, `the pre-crash provider ${oldProvider?.pid} is still running`);
      const others = liveProcs().filter((x) => x.cmd.includes(sid) && !x.cmd.includes('__actor') && x.pid !== fresh.pid);
      check(others.length === 0, `other live processes for the session: ${others.map((o) => o.pid).join(',')}`);
      // codex app-server's argv carries no session id, so the argv scan cannot see a stray
      // codex; the pid + start-time checks on the recorded providers still hold.
      const how = p === 'codex' ? ' (codex: pid + start-time identity only; no session id in its argv)' : '';
      return `pre-crash provider ${oldProvider?.pid ?? '?'} gone; one live provider ${fresh.pid}${how}`;
    });
    await s.step('e2e takeover → resume command; send refused', async () => {
      const live = notePids().provider;
      const t = await orcJson<{ command: string; cwd: string }>(ctx, ['takeover', id]);
      check(t.command && !t.command.startsWith('#') && t.command.includes(' && '), `command "${t.command}"`);
      check(await until(() => !isSameProcessAlive(live), 15_000), `provider ${live?.pid} still running after takeover`);
      const refused = await orc(ctx, ['send', id, 'this must be refused']);
      check(refused.code !== 0, 'send after takeover succeeded');
      check(/orc resume/.test(refused.err), `refusal lacks the resume hint: ${refused.err}`);
      return `command: ${t.command.replace(t.cwd, '<cwd>')}`;
    });
    await s.step('e2e resume → send works', async () => {
      const d = await orcJson<{ status: string }>(ctx, ['resume', id], 300_000);
      check(d.status === 'running', `status ${d.status}`);
      notePids();
      const r = await orcJson<{ phase: string }>(ctx, ['send', id, 'Do not use any tools. Reply with exactly one word: LEMON']);
      check(r.phase === 'acknowledged' || r.phase === 'queued', `phase ${r.phase}`);
      await waitDone(ctx, id);
      return `running; ${await replyContains(ctx, id, 'LEMON')}`;
    });
    await s.step('e2e kill → prune', async () => {
      notePids();
      const k = await orcJson<{ ok: boolean }>(ctx, ['kill', id]);
      check(k.ok, 'kill not ok');
      const pr = await orcJson<{ pruned: string[] }>(ctx, ['prune']);
      check(pr.pruned.includes(id), `prune removed [${pr.pruned.join(',')}]`);
      check(!fs.existsSync(path.join(ctx.home, 'sessions', sid)), 'session dir still exists after prune');
      return `killed + pruned ${id}`;
    });
  } finally {
    // Never leave anything behind, even after a failure.
    if (sid && fs.existsSync(path.join(ctx.home, 'sessions', sid))) {
      notePids();
      await orc(ctx, ['kill', id, '--purge'], 60_000).catch(() => undefined);
    }
    await s.always('e2e no orc/provider processes left', async () => {
      if (!sid) return 'nothing was started';
      const ids = [...providers.values()];
      const settled = await until(
        () => !ids.some((x) => isSameProcessAlive(x)) && !liveProcs().some((x) => x.cmd.includes(sid)),
        15_000,
      );
      if (!settled) {
        const leaked = [
          ...liveProcs().filter((x) => x.cmd.includes(sid)).map((x) => x.pid),
          ...ids.filter((x) => isSameProcessAlive(x)).map((x) => x.pid),
        ];
        for (const pid of leaked) killTree(pid);
        throw new Error(`leaked processes (now killed): ${[...new Set(leaked)].join(',')}`);
      }
      return `none (provider pids seen: ${[...providers.keys()].join(',') || '-'})`;
    });
  }
}

// ---------------------------------------------------------------------------------
// 4. detached 2-step claude workflow
// ---------------------------------------------------------------------------------

async function workflowE2E(ctx: Ctx, model: string | undefined): Promise<void> {
  const s = new StepRunner('claude');
  const file = path.join(ctx.repo, 'two-step.workflow.ts');
  fs.writeFileSync(
    file,
    `export default {
  name: 'verify-two-step',
  steps: [
    {
      id: 'alpha',
      provider: 'claude',
      prompt: 'Do not use any tools. Reply with exactly one word: ALPHA',
      done: (ctx) => ctx.state === 'done' && ctx.capture.toUpperCase().includes('ALPHA'),
    },
    {
      id: 'beta',
      provider: 'claude',
      needs: ['alpha'],
      prompt: 'Do not use any tools. Reply with exactly one word: BETA',
      done: (ctx) => ctx.state === 'done' && (ctx.lastAssistantText ?? '').toUpperCase().includes('BETA'),
    },
  ],
};\n`,
  );
  // Workflow steps take the provider's default model; --claude-model applies via the env.
  const wctx: Ctx = { ...ctx, env: { ...ctx.env, ...(model ? { ANTHROPIC_MODEL: model } : {}) } };
  let runId = '';
  let runner: ProcessIdentity | undefined;
  try {
    await s.step('workflow run --detach', async () => {
      const r = await orcJson<{ runId: string }>(wctx, ['workflow', 'run', file, '--detach']);
      runId = r.runId;
      // The full record carries the runner's start time (the public status view does not).
      const rec = JSON.parse(fs.readFileSync(path.join(ctx.home, 'runs', `${runId}.json`), 'utf8')) as {
        runner?: ProcessIdentity;
      };
      runner = rec.runner ? { pid: rec.runner.pid, startTime: rec.runner.startTime ?? null } : undefined;
      return `run ${runId} (runner pid ${runner?.pid ?? '?'})`;
    });
    await s.step('workflow attach follows to done', async () => {
      const r = await orc(wctx, ['workflow', 'attach', runId], 900_000);
      check(r.code === 0, `attach exited ${r.code}: ${r.err}`);
      check(r.err.includes(`# run ${runId} done`), `attach ended with: ${clip(r.err || r.out, 120)}`);
      check(r.out.includes('[ok] alpha') && r.out.includes('[ok] beta'), 'runner log lacks both [ok] steps');
      return `followed runner log to "# run ${runId} done"`;
    });
    await s.step('workflow status: both steps succeeded', async () => {
      const st = await orcJson<{ status: string; steps: { id: string; ok: boolean }[] }>(wctx, ['workflow', 'status', runId]);
      check(st.status === 'done', `status ${st.status}`);
      check(st.steps.length === 2 && st.steps.every((x) => x.ok), `steps ${JSON.stringify(st.steps.map((x) => [x.id, x.ok]))}`);
      return 'alpha ok, beta ok';
    });
  } finally {
    const sids = (() => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(ctx.home, 'registry.json'), 'utf8')) as { sessionId: string }[]).map(
          (r) => r.sessionId,
        );
      } catch {
        return [] as string[];
      }
    })();
    for (const x of sids) claudeSids.add(x);
    await s.always('workflow cleanup → no processes left', async () => {
      if (runId) await orc(wctx, ['workflow', 'cleanup', runId, '--sessions', '--json'], 120_000);
      await orc(wctx, ['prune', '--json'], 60_000);
      const settled = await until(
        () => !isSameProcessAlive(runner) && !liveProcs().some((x) => sids.some((sid) => x.cmd.includes(sid))),
        20_000,
      );
      if (!settled) {
        const leaked = liveProcs()
          .filter((x) => sids.some((sid) => x.cmd.includes(sid)))
          .map((x) => x.pid);
        if (runner && isSameProcessAlive(runner)) leaked.push(runner.pid);
        for (const pid of leaked) killTree(pid);
        throw new Error(`leaked processes (now killed): ${leaked.join(',')}`);
      }
      return `${sids.length} step session(s) cleaned up; runner gone`;
    });
  }
}

// ---------------------------------------------------------------------------------
// 2. runtime gates
// ---------------------------------------------------------------------------------

interface GateResult {
  exitCode: number;
  summary: string;
  rows: { status: string; check: string; detail: string }[];
}

/** Parse the three gate table formats (claude: "PASS  step …", codex: "#  check PASS …", pi: "step  PASS …"). */
function parseGateRows(text: string): GateResult['rows'] {
  const out: GateResult['rows'] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m = /^(PASS|FAIL|SKIP|WARN)\s{2}(.+?)\s{2,}\d+ms\s{2}(.*)$/.exec(line);
    if (m) {
      out.push({ status: m[1]!, check: m[2]!.trim(), detail: m[3]! });
      continue;
    }
    m = /^\s*\d+\s{2}(.+?)\s{2}(PASS|FAIL)\s+\S+s\s{2}(.*)$/.exec(line);
    if (m) {
      out.push({ status: m[2]!, check: m[1]!.trim(), detail: m[3]! });
      continue;
    }
    m = /^(.+?)\s{2}(PASS|FAIL|WARN)\s+\d+\s{2}(.*)$/.exec(line);
    if (m) out.push({ status: m[2]!, check: m[1]!.trim(), detail: m[3]! });
  }
  return out.map((r) => ({ status: r.status, check: clip(r.check, 80), detail: clip(r.detail) }));
}

async function runtimeGate(p: Provider, env: Record<string, string>, model: string | undefined): Promise<GateResult> {
  const script = path.join(import.meta.dir, `${p}.ts`);
  const proc = Bun.spawn([BUN, script, ...(model ? ['--model', model] : [])], {
    cwd: REPO,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  activeChildren.add(proc);
  const timer = setTimeout(() => proc.kill('SIGTERM'), 900_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  activeChildren.delete(proc);
  const text = sanitize(`${out}\n${err}`);
  for (const l of text.trim().split('\n')) console.log(`      | ${l}`);
  const lines = text.trim().split('\n').filter(Boolean);
  return { exitCode, summary: clip(lines.at(-1) ?? '', 160), rows: parseGateRows(text) };
}

// ---------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const startedAt = new Date().toISOString();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-all-')));
  const shimDir = path.join(root, 'bin');
  fs.mkdirSync(shimDir);
  const shimLog = path.join(root, 'tmux-invocations.log');
  writeExecutable(path.join(shimDir, 'tmux'), `#!/bin/sh\necho "tmux $*" >> '${shimLog}'\nexit 127\n`);
  for (const p of PROVIDERS) {
    const b = args.bin[p];
    if (!b) continue;
    const abs = path.resolve(b);
    const exec = abs.endsWith('.ts') || abs.endsWith('.js') ? `"${BUN}" "${abs}"` : `"${abs}"`;
    writeExecutable(path.join(shimDir, p), `#!/bin/sh\nexec ${exec} "$@"\n`);
  }
  const env = baseEnv(shimDir);
  for (const p of PROVIDERS) if (args.bin[p] && BIN_ENV[p]) env[BIN_ENV[p]!] = path.join(shimDir, p);
  // Ctrl-C: stop every actor/provider this run started (found via its temp ORC_HOMEs).
  const onInterrupt = () => {
    console.error('\ninterrupted: stopping the runners and sessions this run started…');
    stopEverythingUnder(root);
    if (!args.keep) {
      removeClaudeTranscripts(root, new Set([...claudeSids, ...sessionIdsUnder(root)]), env);
      fs.rmSync(root, { recursive: true, force: true });
    }
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  console.log('orc runtime verification (tmux-free actor runtime)');
  const host = { platform: process.platform, arch: process.arch, osRelease: os.release() };
  console.log(`host: ${host.platform}/${host.arch} ${host.osRelease}; bun ${Bun.version}; repo ${sanitize(REPO)}`);
  console.log(`tmux shim first on PATH: ${sanitize(path.join(shimDir, 'tmux'))}${args.keep ? `; temp root ${root}` : ''}`);

  // 1. preflight
  console.log('\n[1/4] preflight');
  const available: Provider[] = [];
  const providerInfo: Record<
    string,
    { selected: boolean; bin?: string; version?: string; overridden?: boolean; model?: string }
  > = {};
  for (const p of PROVIDERS) {
    if (!args.providers.includes(p)) {
      providerInfo[p] = { selected: false };
      continue;
    }
    const bin = resolveBin(p, env);
    if (!bin) {
      providerInfo[p] = { selected: true };
      record(p, 'preflight', 'SKIP', `'${p}' not found on PATH${BIN_ENV[p] ? ` (or $${BIN_ENV[p]})` : ''}`);
      continue;
    }
    const version = versionOf(bin, env);
    providerInfo[p] = {
      selected: true,
      bin: sanitize(bin),
      version: sanitize(version),
      overridden: !!args.bin[p],
      model: args.model[p] ?? '(provider default)',
    };
    record(p, 'preflight', 'PASS', `${bin} — ${version}${args.bin[p] ? ' (override)' : ''}`);
    if (!args.model[p]) {
      console.log(`  note  ${p} will use your default model (pass --${p}-model <cheap model> to choose)`);
    }
    available.push(p);
  }

  // 2. runtime gates
  console.log('\n[2/4] runtime gates');
  const gates: Record<string, GateResult> = {};
  for (const p of args.providers) {
    if (!available.includes(p) || !args.runtimeGates) {
      record(p, 'runtime gate', 'SKIP', args.runtimeGates ? 'provider unavailable' : '--no-runtime-gates');
      continue;
    }
    console.log(`  running scripts/verify-runtime/${p}.ts …`);
    const t0 = Date.now();
    try {
      const g = await runtimeGate(p, env, args.model[p]);
      gates[p] = g;
      const passed = g.rows.filter((r) => r.status === 'PASS').length;
      record(p, 'runtime gate', g.exitCode === 0 ? 'PASS' : 'FAIL', `${passed}/${g.rows.length} steps; ${g.summary}`, Date.now() - t0);
    } catch (e) {
      record(p, 'runtime gate', 'FAIL', `harness error: ${(e as Error)?.message ?? String(e)}`, Date.now() - t0);
    }
  }

  // 3. CLI e2e
  console.log('\n[3/4] CLI end-to-end (isolated ORC_HOME, temp git repo)');
  for (const p of args.providers) {
    if (!available.includes(p) || !args.e2e) {
      record(p, 'e2e', 'SKIP', args.e2e ? 'provider unavailable' : '--no-e2e');
      continue;
    }
    const ctx: Ctx = { provider: p, home: path.join(root, p, 'orc-home'), repo: path.join(root, p, 'repo'), env };
    try {
      fs.mkdirSync(ctx.home, { recursive: true });
      mkRepo(ctx.repo, env);
      await cliE2E(p, ctx, args.model[p]);
    } catch (e) {
      record(p, 'e2e', 'FAIL', `harness error: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  // 4. workflow
  console.log('\n[4/4] detached 2-step workflow (claude)');
  if (!args.providers.includes('claude') || !available.includes('claude') || !args.workflow) {
    record('claude', 'workflow', 'SKIP', !args.workflow ? '--no-workflow' : 'claude unavailable or not selected');
  } else {
    const ctx: Ctx = { provider: 'claude', home: path.join(root, 'workflow', 'orc-home'), repo: path.join(root, 'workflow', 'repo'), env };
    try {
      fs.mkdirSync(ctx.home, { recursive: true });
      mkRepo(ctx.repo, env);
      await workflowE2E(ctx, args.model.claude);
    } catch (e) {
      record('claude', 'workflow', 'FAIL', `harness error: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  // tmux shim
  const invoked = fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').trim() : '';
  record('all', 'tmux never invoked', invoked ? 'FAIL' : 'PASS', invoked ? `invoked: ${invoked.split('\n')[0]}` : 'shim log empty');

  // cleanup: temp root + claude transcripts this run created (only dirs named after our temp root)
  if (!args.keep) {
    removeClaudeTranscripts(root, new Set([...claudeSids, ...sessionIdsUnder(root)]), env);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 5. report
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 } as Record<Status, number>;
  for (const r of rows) counts[r.status]++;
  const ok = counts.FAIL === 0;
  const wp = Math.max(8, ...rows.map((r) => r.provider.length));
  const wc = Math.max(5, ...rows.map((r) => r.check.length));
  console.log(`\n${'provider'.padEnd(wp)}  ${'check'.padEnd(wc)}  result  ${'time'.padStart(7)}  detail`);
  console.log(`${'-'.repeat(wp)}  ${'-'.repeat(wc)}  ------  ${'-'.repeat(7)}  ------`);
  for (const r of rows) {
    console.log(
      `${r.provider.padEnd(wp)}  ${r.check.padEnd(wc)}  ${r.status.padEnd(6)}  ${`${(r.ms / 1000).toFixed(1)}s`.padStart(7)}  ${r.detail}`,
    );
  }
  const resultsPath = args.results ?? path.join(REPO, 'verify-results.json');
  const results = {
    tool: 'scripts/verify-runtime/all.ts',
    ok,
    counts,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { ...host, bun: Bun.version },
    options: {
      providers: args.providers,
      models: args.model,
      binOverrides: Object.keys(args.bin),
      runtimeGates: args.runtimeGates,
      e2e: args.e2e,
      workflow: args.workflow,
      kept: args.keep,
    },
    providers: providerInfo,
    checks: rows,
    runtimeGates: gates,
    tmuxShimInvoked: invoked.length > 0,
  };
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    `\n${ok ? 'ALL PASSED' : 'FAILED'}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip — results: ${sanitize(resultsPath)}` +
      (args.keep ? `\nkept: ${root}` : ''),
  );
  return ok ? 0 : 1;
}

process.exit(await main());
