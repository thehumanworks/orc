#!/usr/bin/env bun
/**
 * LIVE gate for the pi runtime (S4) — run on an AUTHENTICATED host against the real pi:
 *
 *   bun scripts/verify-runtime/pi.ts [--model <provider/id>] [--bin <path-to-pi>] [--keep]
 *
 * Exercises ONLY src/runtime/providers/pi.ts (no orc session/agent/registry layer) with the
 * user's normal pi config + auth (~/.pi/agent or $PI_CODING_AGENT_DIR) and default model
 * unless --model is given. Everything else lives in a fresh temp dir (cwd, --session-dir,
 * raw protocol log, appended system-prompt file):
 *
 *   1. fresh start → ready             5. close → exited, process group gone
 *   2. multi-line prompt → 1-word reply 6. resume (same spec + cwd) → ready with history
 *   3. second turn remembers the word   7. turn after resume remembers the word
 *   4. long third turn → interrupt      8. close → exited, process group gone
 *
 * Prints a PASS/WARN/FAIL table and exits 1 on any FAIL. Output never includes env values,
 * credentials or the system prompt; model replies are truncated. The temp dir is removed on
 * success (kept on failure or with --keep, for its provider.jsonl / provider.stderr.log).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PI_VERIFIED_VERSION } from '../../src/runtime/providers/pi-protocol.ts';
import { createPiRuntime } from '../../src/runtime/providers/pi.ts';
import type { ProviderEvent, ProviderLaunch, ProviderRuntime, SpawnSpec } from '../../src/runtime/types.ts';

const TURN_TIMEOUT_MS = 180_000;
const INTERRUPT_AFTER_MS = 1_500;

// ---------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------

function parseArgs(argv: string[]): { model?: string; bin: string; keep: boolean } {
  let model: string | undefined;
  let bin = 'pi';
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' && argv[i + 1]) model = argv[++i];
    else if (a === '--bin' && argv[i + 1]) bin = argv[++i] as string;
    else if (a === '--keep') keep = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: bun scripts/verify-runtime/pi.ts [--model <provider/id>] [--bin <path-to-pi>] [--keep]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { model, bin, keep };
}

// ---------------------------------------------------------------------------------
// result table
// ---------------------------------------------------------------------------------

type Status = 'PASS' | 'WARN' | 'FAIL';
const rows: Array<{ step: string; status: Status; detail: string; ms: number }> = [];

async function check(step: string, fn: () => Promise<string | { warn: string }>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const r = await fn();
    if (typeof r === 'string') rows.push({ step, status: 'PASS', detail: r, ms: Date.now() - t0 });
    else rows.push({ step, status: 'WARN', detail: r.warn, ms: Date.now() - t0 });
    return true;
  } catch (e) {
    rows.push({ step, status: 'FAIL', detail: oneLine((e as Error).message ?? String(e)), ms: Date.now() - t0 });
    return false;
  }
}

function printTable(): void {
  const w1 = Math.max(4, ...rows.map((r) => r.step.length));
  console.log(`\n${'step'.padEnd(w1)}  status  ${'ms'.padStart(6)}  detail`);
  console.log(`${'-'.repeat(w1)}  ------  ${'-'.repeat(6)}  ${'-'.repeat(40)}`);
  for (const r of rows) {
    console.log(`${r.step.padEnd(w1)}  ${r.status.padEnd(6)}  ${String(r.ms).padStart(6)}  ${r.detail}`);
  }
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------------
// event collector
// ---------------------------------------------------------------------------------

class Collector {
  readonly events: ProviderEvent[] = [];
  ended = false;
  private waiters: Array<() => void> = [];
  readonly done: Promise<void>;

  constructor(rt: ProviderRuntime) {
    this.done = (async () => {
      for await (const ev of rt.events()) {
        this.events.push(ev);
        this.waiters.splice(0).forEach((w) => w());
      }
      this.ended = true;
      this.waiters.splice(0).forEach((w) => w());
    })();
  }

  async waitFor(pred: (e: ProviderEvent) => boolean, timeoutMs: number, what: string): Promise<ProviderEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (this.ended) throw new Error(`event stream ended before ${what} (saw: ${this.summary()})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (saw: ${this.summary()})`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 500));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  outcome(messageId: string): Promise<ProviderEvent> {
    return this.waitFor(
      (e) =>
        (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') &&
        e.messageId === messageId,
      TURN_TIMEOUT_MS,
      `the outcome of ${messageId}`,
    );
  }

  summary(): string {
    return this.events.map((e) => e.type).join(',') || 'nothing';
  }
}

function describeOutcome(e: ProviderEvent): string {
  if (e.type === 'turn.failed') return `turn.failed: ${oneLine(e.error, 120)}`;
  if (e.type === 'turn.completed') return `turn.completed: "${oneLine(e.result ?? '', 60)}"`;
  return e.type;
}

function expectCompletedWith(e: ProviderEvent, word: string): string {
  if (e.type !== 'turn.completed') throw new Error(`expected turn.completed, got ${describeOutcome(e)}`);
  const result = e.result ?? '';
  if (!result.toUpperCase().includes(word)) {
    throw new Error(`turn.completed but the reply does not contain ${word}: "${oneLine(result, 80)}"`);
  }
  return `turn.completed: "${oneLine(result, 60)}"`;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

async function closeAndCheck(rt: ProviderRuntime, c: Collector): Promise<string> {
  await rt.close({ graceMs: 5_000 });
  await c.done;
  const last = c.events.at(-1);
  if (!last || last.type !== 'exited') throw new Error(`last event is ${last?.type ?? 'none'}, expected exited`);
  if (groupAlive(rt.pid)) throw new Error(`process group ${rt.pid} still has members after close`);
  return `exited code=${last.code} signal=${last.signal}; group ${rt.pid} gone`;
}

// ---------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const factory = createPiRuntime({ bin: args.bin, bootTimeoutMs: 60_000 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-pi-'));
  fs.mkdirSync(path.join(root, 'cwd'), { mode: 0o700 });
  const cwd = fs.realpathSync(path.join(root, 'cwd'));
  const promptFile = path.join(root, 'append-system-prompt.md');
  fs.writeFileSync(
    promptFile,
    'You are being exercised by an automated runtime check. Follow the formatting instructions in each user message exactly. Do not use tools.\n',
    { mode: 0o600 },
  );
  const words = ['PINEAPPLE', 'LIGHTHOUSE', 'MARMALADE', 'TANGERINE', 'KALEIDOSCOPE', 'AVALANCHE'];
  const word = words[Math.floor(Math.random() * words.length)] as string;
  const spec: SpawnSpec = {
    version: 1,
    sessionId: crypto.randomUUID(),
    provider: 'pi',
    cwd,
    env: {},
    model: args.model,
    systemPrompt: { mode: 'append', path: promptFile },
    sessionDir: path.join(root, 'pi-sessions'),
    createdAt: new Date().toISOString(),
  };
  const launch = (resume: boolean): ProviderLaunch => ({
    spec,
    resume,
    env,
    rawLogPath: path.join(root, resume ? 'provider.resume.jsonl' : 'provider.jsonl'),
  });

  console.log(`orc pi runtime live gate — temp dir ${root}`);
  console.log(`model: ${args.model ?? '(pi default)'}; pi: ${args.bin}`);

  let rt: ProviderRuntime | null = null;
  let c: Collector | null = null;
  let transcriptPath: string | undefined;
  const cleanup = async () => {
    if (rt) await rt.close({ graceMs: 2_000 }).catch(() => {});
  };
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    await check('pi --version', async () => {
      const r = Bun.spawnSync([args.bin, '--version'], { env, stdout: 'pipe', stderr: 'pipe' });
      const v = r.stdout.toString().trim();
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${oneLine(r.stderr.toString(), 120)}`);
      return v === PI_VERIFIED_VERSION ? v : { warn: `${v} (runtime verified against ${PI_VERIFIED_VERSION})` };
    });

    const started = await check('1 fresh start → ready', async () => {
      rt = await factory.start(launch(false));
      c = new Collector(rt);
      const ready = await c.waitFor((e) => e.type === 'ready', 10_000, 'ready');
      if (ready.type !== 'ready') throw new Error('unreachable');
      if (ready.providerSessionId !== spec.sessionId) throw new Error(`providerSessionId ${ready.providerSessionId}`);
      transcriptPath = ready.transcriptPath;
      return `pid=${rt.pid} model=${String(ready.info?.model)} version=${String(ready.info?.version ?? '?')}`;
    });
    if (!started || !rt || !c) return finish(root, args.keep);
    const r1 = rt as ProviderRuntime;
    const c1 = c as Collector;

    await check('2 multi-line prompt → one-word reply', async () => {
      const text =
        'orc runtime verification, turn 1.\n' +
        'This message spans several lines and contains "double quotes", \'single quotes\', a back\\slash and unicode (café ✓).\n' +
        `Reply with exactly one word and nothing else: ${word}`;
      await r1.send('verify-1', text);
      return expectCompletedWith(await c1.outcome('verify-1'), word);
    });

    await check('3 second turn → completed (in-process history)', async () => {
      await r1.send('verify-2', 'Turn 2: reply with exactly the same single word you replied with last time, and nothing else.');
      return expectCompletedWith(await c1.outcome('verify-2'), word);
    });

    await check('4 long third turn → interrupt → turn.interrupted', async () => {
      await r1.send('verify-3', 'Turn 3: count from 1 to 3000, one number per line, with no other text.');
      await c1.waitFor((e) => e.type === 'turn.started' && e.messageId === 'verify-3', 60_000, 'turn.started');
      await Bun.sleep(INTERRUPT_AFTER_MS);
      await r1.interrupt();
      const out = await c1.outcome('verify-3');
      if (out.type !== 'turn.interrupted') throw new Error(`expected turn.interrupted, got ${describeOutcome(out)}`);
      await c1.waitFor((e) => e.type === 'interrupt.acked', 30_000, 'interrupt.acked');
      return 'turn.interrupted + interrupt.acked';
    });

    await check('5 close → exited, group gone', async () => {
      const r = await closeAndCheck(r1, c1);
      rt = null;
      return r;
    });

    const resumed = await check('6 resume (same spec + cwd) → ready with history', async () => {
      rt = await factory.start(launch(true));
      c = new Collector(rt);
      const ready = await c.waitFor((e) => e.type === 'ready', 10_000, 'ready');
      if (ready.type !== 'ready') throw new Error('unreachable');
      const count = ready.info?.messageCount;
      if (typeof count !== 'number' || count <= 0) throw new Error(`messageCount=${String(count)}`);
      if (transcriptPath && ready.transcriptPath !== transcriptPath) {
        throw new Error(`transcript path changed: ${ready.transcriptPath} vs ${transcriptPath}`);
      }
      return `messageCount=${count}`;
    });

    if (resumed && rt && c) {
      const r2 = rt as ProviderRuntime;
      const c2 = c as Collector;
      await check('7 turn after resume remembers the word', async () => {
        await r2.send(
          'verify-4',
          'After a restart: which single word did you reply with to my first message? Reply with that one word only.',
        );
        return expectCompletedWith(await c2.outcome('verify-4'), word);
      });
      await check('8 close → exited, group gone', async () => {
        const r = await closeAndCheck(r2, c2);
        rt = null;
        return r;
      });
    }
  } finally {
    await cleanup();
  }
  return finish(root, args.keep);
}

function finish(root: string, keep: boolean): number {
  printTable();
  const failed = rows.some((r) => r.status === 'FAIL');
  if (failed || keep) {
    console.log(`\nartifacts kept: ${root} (provider*.jsonl, provider.stderr.log, pi-sessions/)`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  return failed ? 1 : 0;
}

process.exit(await main());
