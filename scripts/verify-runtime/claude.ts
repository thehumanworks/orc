#!/usr/bin/env bun
/**
 * Standalone live gate for the claude provider runtime (runtime only — no session layer,
 * no actor). Run it on any machine with an authenticated `claude` on PATH (e.g. macOS):
 *
 *   bun scripts/verify-runtime/claude.ts [--model haiku] [--keep]
 *
 * Steps (one fresh process, then a resume in a new process, in a temp cwd):
 *   1. start → ready              5. a normal turn after the interrupt
 *   2. multi-line one-word prompt 6. close → exited, no process left in the group
 *   3. second turn recalls #2     7. resume in a NEW runtime → recalls the codeword
 *   4. interrupt a long turn      8. close the resumed runtime
 * Prints a PASS/FAIL table and exits non-zero on any failure. Never prints env, tokens or
 * account data. Spend: a few cents with haiku. `--keep` keeps the temp dir (raw logs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ClaudeRuntime,
  resolveClaudeTranscript,
  startClaudeRuntime,
} from '../../src/runtime/providers/claude.ts';
import { CLAUDE_PROTOCOL_VERIFIED_VERSION } from '../../src/runtime/providers/claude-protocol.ts';
import type { ProviderEvent, ProviderLaunch, SpawnSpec } from '../../src/runtime/types.ts';

// ---------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: bun scripts/verify-runtime/claude.ts [--model <model>] [--keep]');
  process.exit(0);
}
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx >= 0 ? args[modelIdx + 1] : 'haiku';
if (modelIdx >= 0 && !MODEL) {
  console.error('--model needs a value');
  process.exit(2);
}
const KEEP = args.includes('--keep');
const TURN_MS = 120_000;

// ---------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------

type Ev<T extends ProviderEvent['type']> = Extract<ProviderEvent, { type: T }>;
const OUTCOME = /^turn\.(completed|failed|interrupted)$/;

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

class Tap {
  readonly events: ProviderEvent[] = [];
  readonly done: Promise<void>;
  constructor(readonly rt: ClaudeRuntime) {
    this.done = (async () => {
      for await (const ev of rt.events()) this.events.push(ev);
    })();
  }
  async waitFor<T extends ProviderEvent['type']>(pred: (e: ProviderEvent) => boolean, ms = TURN_MS): Promise<Ev<T>> {
    if (!(await waitUntil(() => this.events.some(pred), ms))) {
      throw new Error(`timed out after ${ms}ms (events: ${this.events.map((e) => e.type).join(',')})`);
    }
    return this.events.find(pred) as Ev<T>;
  }
  forTurn(id: string): ProviderEvent[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === id);
  }
  async outcome(id: string, ms = TURN_MS): Promise<ProviderEvent> {
    return this.waitFor((e) => 'messageId' in e && e.messageId === id && OUTCOME.test(e.type), ms);
  }
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const results: Array<{ step: string; ok: boolean | null; detail: string; ms: number }> = [];
let failed = false;

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  if (failed) {
    results.push({ step: name, ok: null, detail: 'skipped (earlier failure)', ms: 0 });
    return false;
  }
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - t0 });
    return true;
  } catch (e) {
    failed = true;
    results.push({ step: name, ok: false, detail: (e as Error).message.slice(0, 300), ms: Date.now() - t0 });
    return false;
  }
}

const oneLine = (s: string | undefined, n = 60): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-claude-')));
const cwd = path.join(root, 'work');
fs.mkdirSync(cwd);
const sid = randomUUID();
const CODEWORD = `KIWI-${1000 + Math.floor(Math.random() * 9000)}`;
let costTotal = 0;
let versionSeen = '';
const live: ClaudeRuntime[] = [];

const mkLaunch = (resume: boolean): ProviderLaunch => {
  const spec: SpawnSpec = {
    version: 1,
    sessionId: sid,
    provider: 'claude',
    cwd,
    env: { ORC_SESSION_ID: sid },
    ...(MODEL ? { model: MODEL } : {}),
    ...(resume ? { providerSessionId: sid } : {}),
    createdAt: new Date().toISOString(),
  };
  return {
    spec,
    resume,
    env: { ...(process.env as Record<string, string>) },
    rawLogPath: path.join(root, resume ? 'resume' : 'fresh', 'provider.jsonl'),
  };
};
const addCost = (e: ProviderEvent) => {
  if (e.type === 'turn.completed' && typeof e.costUsd === 'number') costTotal += e.costUsd;
};

async function closeChecked(tap: Tap): Promise<string> {
  await tap.rt.close({ graceMs: 5_000 });
  await tap.done;
  const last = tap.events.at(-1);
  check(last?.type === 'exited', `last event is ${last?.type}, expected exited`);
  check(await waitUntil(() => !groupAlive(tap.rt.pid), 5_000), `process group ${tap.rt.pid} still alive`);
  return `exit code=${(last as Ev<'exited'>).code} signal=${(last as Ev<'exited'>).signal}; group gone`;
}

const t0 = Date.now();
let A: Tap | undefined;
let B: Tap | undefined;
try {
  await step('fresh start → ready', async () => {
    const rt = await startClaudeRuntime(mkLaunch(false));
    live.push(rt);
    A = new Tap(rt);
    const ready = await A.waitFor<'ready'>((e) => e.type === 'ready', 10_000);
    check(ready.providerSessionId === sid, 'ready.providerSessionId mismatch');
    check(ready.info?.pid === rt.pid, 'initialize pid != spawned pid');
    versionSeen = String(ready.info?.claude_code_version ?? '?');
    return `claude ${versionSeen}${versionSeen === CLAUDE_PROTOCOL_VERIFIED_VERSION ? '' : ` (verified: ${CLAUDE_PROTOCOL_VERIFIED_VERSION})`}, pid ${rt.pid}`;
  });

  await step('multi-line one-word prompt (one message)', async () => {
    const tap = A as Tap;
    const text =
      `Remember this codeword for later: "${CODEWORD}".\n` +
      `This line has 'single' and "double" quotes and unicode: ünïcödé ✓ 日本語.\n\n` +
      'Reply with only the single word OK.';
    await tap.rt.send('t1', text);
    const out = await tap.outcome('t1');
    addCost(out);
    check(out.type === 'turn.completed', `outcome ${out.type}${out.type === 'turn.failed' ? `: ${out.error}` : ''}`);
    const kinds = tap.forTurn('t1').map((e) => e.type);
    check(kinds.filter((k) => k === 'turn.started').length === 1, `turn.started x${kinds.filter((k) => k === 'turn.started').length}`);
    check(kinds.filter((k) => OUTCOME.test(k)).length === 1, 'more than one outcome');
    check(/\bok\b/i.test(out.result ?? ''), `unexpected reply "${oneLine(out.result)}"`);
    return `reply "${oneLine(out.result)}"`;
  });

  await step('init contract (skills, agents, capabilities)', async () => {
    const info = (A as Tap).rt.initInfo;
    check(info, 'no system/init seen');
    check(info.skillsCount > 0, 'skills.length == 0 (is -p running --bare?)');
    check(info.agents.includes('general-purpose'), 'agents lack general-purpose');
    check(info.capabilities.includes('interrupt_receipt_v1'), 'capability interrupt_receipt_v1 missing');
    check(typeof info.apiKeySource === 'string', 'apiKeySource missing');
    return `skills=${info.skillsCount} agents=${info.agents.length} apiKeySource=${info.apiKeySource} model=${info.model}`;
  });

  await step('second turn recalls the first', async () => {
    const tap = A as Tap;
    await tap.rt.send('t2', 'What codeword did I ask you to remember? Reply with only the codeword.');
    const out = await tap.outcome('t2');
    addCost(out);
    check(out.type === 'turn.completed', `outcome ${out.type}`);
    check((out.result ?? '').includes(CODEWORD), `did not recall (got "${oneLine(out.result)}")`);
    return `recalled ${CODEWORD}`;
  });

  await step('interrupt a long third turn', async () => {
    const tap = A as Tap;
    const acks = tap.events.filter((e) => e.type === 'interrupt.acked').length;
    await tap.rt.send(
      't3',
      'Write a detailed essay of about 3000 words on the history of numerals, then count from 1 to 500 in English words, one per line.',
    );
    await tap.waitFor((e) => e.type === 'turn.started' && e.messageId === 't3', 60_000);
    await Bun.sleep(2_000);
    await tap.rt.interrupt();
    const out = await tap.outcome('t3', 60_000);
    check(out.type === 'turn.interrupted', `outcome ${out.type} (expected turn.interrupted)`);
    check(await waitUntil(() => tap.events.filter((e) => e.type === 'interrupt.acked').length > acks, 10_000), 'no interrupt.acked');
    return 'turn.interrupted + interrupt.acked';
  });

  await step('turn after the interrupt', async () => {
    const tap = A as Tap;
    await tap.rt.send('t4', 'Reply with only the word READY.');
    const out = await tap.outcome('t4');
    addCost(out);
    check(out.type === 'turn.completed', `outcome ${out.type}`);
    return `reply "${oneLine(out.result)}"`;
  });

  await step('close (fresh)', () => closeChecked(A as Tap));

  await step('resume in a new runtime → recall', async () => {
    const rt = await startClaudeRuntime(mkLaunch(true));
    live.push(rt);
    B = new Tap(rt);
    const ready = await B.waitFor<'ready'>((e) => e.type === 'ready', 10_000);
    check(ready.transcriptPath && fs.existsSync(ready.transcriptPath), 'ready.transcriptPath missing');
    await rt.send('r1', 'What codeword did I ask you to remember? Reply with only the codeword.');
    const out = await B.outcome('r1');
    check(out.type === 'turn.completed', `outcome ${out.type}`);
    check((out.result ?? '').includes(CODEWORD), `did not recall (got "${oneLine(out.result)}")`);
    return `recalled ${CODEWORD}; transcript found`;
  });

  await step('close (resumed)', () => closeChecked(B as Tap));
} finally {
  for (const rt of live) await rt.close({ graceMs: 1_000 }).catch(() => {});
  const t = resolveClaudeTranscript(sid);
  if (!KEEP) {
    if (t && path.basename(path.dirname(t)).includes('orc-verify-claude-')) {
      fs.rmSync(path.dirname(t), { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------

const w = Math.max(...results.map((r) => r.step.length));
console.log(`\norc claude runtime verification — model ${MODEL}, claude ${versionSeen || '?'}, ${process.platform}`);
console.log('-'.repeat(w + 30));
for (const r of results) {
  const tag = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP';
  console.log(`${tag}  ${r.step.padEnd(w)}  ${String(r.ms).padStart(6)}ms  ${r.detail}`);
}
console.log('-'.repeat(w + 30));
const passed = results.filter((r) => r.ok === true).length;
console.log(
  `${failed ? 'FAILED' : 'ALL PASSED'}: ${passed}/${results.length} steps in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
    `reported spend ≈ $${costTotal.toFixed(4)} (fresh-process turns)` +
    (KEEP ? `\nraw logs kept in ${root}` : ''),
);
process.exit(failed ? 1 : 0);
