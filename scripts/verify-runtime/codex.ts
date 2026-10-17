#!/usr/bin/env bun
/**
 * LIVE gate for orc's codex runtime (src/runtime/providers/codex.ts → the in-house codex
 * harness, src/codex/harness.ts) against the REAL OpenAI Responses API. Depends only on the
 * runtime — not on orc's session layer.
 *
 *   bun scripts/verify-runtime/codex.ts [--model <id>] [--orc-bin <path>]
 *                                       [--turn-timeout <seconds>] [--keep]
 *
 * Uses your normal credentials, in the harness's order: `orc login chatgpt`
 * ($ORC_HOME/auth/chatgpt.json), else pi's ChatGPT login (~/.pi/agent/auth.json), else
 * OPENAI_API_KEY. Without --model the harness picks the first model your account lists.
 * `--orc-bin` runs the harness from a compiled orc binary instead of this checkout.
 * Steps: preflight (credential + live model list) → fresh start → multi-line one-word turn
 * → tool turn (write a file) → interrupt a long turn → close → resume → history check →
 * close. Prints a PASS/FAIL table and exits non-zero on any failure. Never prints env or
 * credentials; the raw protocol log is kept on failure (or with --keep) for debugging.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { resolveCodexAuth } from '../../src/codex/auth.ts';
import { listLiveModels } from '../../src/codex/models.ts';
import { PI_AI_VERSION } from '../../src/codex/harness.ts';
import { codexRuntime, codexStderrLogPath, createCodexRuntime } from '../../src/runtime/providers/codex.ts';
import type { ProviderEvent, ProviderRuntime, ProviderRuntimeFactory, SpawnSpec } from '../../src/runtime/types.ts';
import { parsePi } from '../../src/transcript.ts';

// ------------------------------------------------------------------------------------
// args
// ------------------------------------------------------------------------------------

interface Args {
  model?: string;
  orcBin?: string;
  turnTimeoutMs: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { turnTimeoutMs: 180_000, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--model') a.model = val();
    else if (k === '--orc-bin' || k === '--codex-bin') a.orcBin = path.resolve(val());
    else if (k === '--turn-timeout') a.turnTimeoutMs = Number(val()) * 1_000;
    else if (k === '--keep') a.keep = true;
    else if (k === '-h' || k === '--help') {
      console.log('usage: bun scripts/verify-runtime/codex.ts [--model <id>] [--orc-bin <path>] [--turn-timeout <s>] [--keep]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!Number.isFinite(a.turnTimeoutMs) || a.turnTimeoutMs <= 0) throw new Error('--turn-timeout must be a positive number');
  return a;
}

// ------------------------------------------------------------------------------------
// result table
// ------------------------------------------------------------------------------------

interface Row {
  check: string;
  ok: boolean;
  ms: number;
  detail: string;
}
const rows: Row[] = [];

/** Keep details short and single-line; they come from model output or provider errors only. */
function clip(s: string, n = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

async function step(check: string, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    rows.push({ check, ok: true, ms: Date.now() - t0, detail: clip(detail) });
    return true;
  } catch (e) {
    rows.push({ check, ok: false, ms: Date.now() - t0, detail: clip((e as Error)?.message ?? String(e)) });
    return false;
  }
}

function printTable(): void {
  const w = Math.max(...rows.map((r) => r.check.length), 5);
  console.log(`\n  #  ${'check'.padEnd(w)}  result  time     detail`);
  console.log(`  -  ${'-'.repeat(w)}  ------  -------  ------`);
  rows.forEach((r, i) => {
    const t = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`${String(i + 1).padStart(3)}  ${r.check.padEnd(w)}  ${r.ok ? 'PASS  ' : 'FAIL  '}  ${t}  ${r.detail}`);
  });
}

// ------------------------------------------------------------------------------------
// runtime helpers
// ------------------------------------------------------------------------------------

class Session {
  readonly events: ProviderEvent[] = [];
  readonly done: Promise<void>;
  constructor(readonly rt: ProviderRuntime) {
    this.done = (async () => {
      for await (const e of rt.events()) this.events.push(e);
    })();
  }
  async waitFor(pred: (e: ProviderEvent) => boolean, ms: number, what: string): Promise<ProviderEvent> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (this.events.some((e) => e.type === 'exited')) throw new Error(`the harness exited while waiting for ${what}`);
      if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
      await Bun.sleep(25);
    }
  }
  outcome(messageId: string, ms: number): Promise<ProviderEvent> {
    return this.waitFor(
      (e) =>
        (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted') &&
        e.messageId === messageId,
      ms,
      `the outcome of ${messageId}`,
    );
  }
  ofMessage(messageId: string): string[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === messageId).map((e) => e.type);
  }
}

/** Uppercase letters only — tolerant of trailing punctuation / formatting around a one-word reply. */
const word = (s: string | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

function groupAlive(pgid: number): boolean {
  const r = Bun.spawnSync(['ps', '-A', '-o', 'pgid=,stat='], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout
    .toString()
    .split('\n')
    .some((l) => {
      const [g, st] = l.trim().split(/\s+/);
      return g === String(pgid) && !!st && !st.startsWith('Z');
    });
}

async function runTurn(s: Session, messageId: string, text: string, timeoutMs: number): Promise<ProviderEvent> {
  await s.rt.send(messageId, text);
  try {
    return await s.outcome(messageId, timeoutMs);
  } catch (e) {
    // Interrupt a turn that outlived the timeout so the following checks still run.
    await s.rt.interrupt().catch(() => {});
    await s.outcome(messageId, 30_000).catch(() => {});
    throw e;
  }
}

function expectCompletedWord(ev: ProviderEvent, s: Session, messageId: string, want: string): string {
  if (ev.type !== 'turn.completed') {
    throw new Error(`expected turn.completed, got ${ev.type}${ev.type === 'turn.failed' ? `: ${ev.error}` : ''}`);
  }
  const seq = s.ofMessage(messageId);
  if (seq[0] !== 'turn.started') throw new Error(`turn.started was not first: ${seq.join(',')}`);
  if (!seq.includes('assistant.text')) throw new Error(`no assistant.text before the outcome: ${seq.join(',')}`);
  if (word(ev.result) !== want) throw new Error(`expected "${want}", got "${clip(ev.result ?? '<none>', 40)}"`);
  const u = ev.usage;
  return `result "${clip(ev.result ?? '', 30)}"${u ? `, tokens in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'}` : ''}`;
}

// ------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-verify-codex-'));
  fs.mkdirSync(path.join(root, 'cwd'));
  const cwd = fs.realpathSync(path.join(root, 'cwd'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const rawLogPath = path.join(stateDir, 'provider.jsonl');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const factory: ProviderRuntimeFactory = args.orcBin ? createCodexRuntime({ argv: [args.orcBin] }) : codexRuntime;
  const spec: SpawnSpec = {
    version: 1,
    sessionId: crypto.randomUUID(),
    provider: 'codex',
    cwd,
    env: {},
    createdAt: new Date().toISOString(),
    ...(args.model ? { model: args.model } : {}),
  };
  const T = args.turnTimeoutMs;
  console.log(`orc codex harness live gate (pi-ai ${PI_AI_VERSION}; harness: ${args.orcBin ?? 'this checkout'})`);
  console.log(`cwd: ${cwd}${args.model ? `  model: ${args.model}` : ''}`);

  let current: Session | null = null;
  const onSignal = (): void => {
    void current?.rt.close({ graceMs: 500 }).finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let transcriptPath: string | undefined;
  let model = '';
  const first = 'PINEAPPLE';
  try {
    const ok = await step('preflight: credential + live model list', async () => {
      registerBunOAuthFlows();
      const auth = await resolveCodexAuth(env);
      const models = createModels({ credentials: auth.store });
      models.setProvider(openaiProvider());
      try {
        const listed = await listLiveModels({ models, accountKey: auth.accountKey, force: true });
        return `${auth.label}; ${listed.ids.length} models, first: ${listed.ids.slice(0, 3).join(', ')}`;
      } catch (e) {
        if (args.model) return `${auth.label}; listing failed (${(e as Error).message}) — using --model`;
        throw e;
      }
    });
    const started = ok && (await step('fresh start → ready', async () => {
      const rt = await factory.start({ spec, resume: false, env, rawLogPath });
      current = new Session(rt);
      const ready = await current.waitFor((e) => e.type === 'ready', 60_000, 'ready');
      if (ready.type !== 'ready') throw new Error('unreachable');
      transcriptPath = ready.transcriptPath;
      const info = ready.info ?? {};
      model = String(info.model);
      return `model ${model} (${String(info.modelSource)}), auth ${String(info.authSource)}, thinking ${String(info.thinkingLevel)}`;
    }));
    if (started && current) {
      const s: Session = current;
      await step('turn 1: multi-line prompt → one-word reply', async () => {
        const prompt = [
          'orc runtime live check (codex harness). This message spans several lines.',
          `Line 2 has "double quotes", 'single quotes', a backslash \\ and unicode: ✓ 日本語 🚀.`,
          '',
          `Reply with exactly one word and nothing else: ${first}`,
        ].join('\n');
        return expectCompletedWord(await runTurn(s, 'verify-1', prompt, T), s, 'verify-1', first);
      });
      await step('transcript (codex-session.jsonl) parses', async () => {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) throw new Error(`missing: ${transcriptPath}`);
        const turns = parsePi(fs.readFileSync(transcriptPath, 'utf8'));
        if (!turns.some((t) => t.role === 'assistant')) throw new Error('no assistant turn in the transcript');
        return `${path.basename(transcriptPath)}: ${turns.length} turns`;
      });
      await step('turn 2: tool use (write a file in the cwd)', async () => {
        const ev = await runTurn(
          s,
          'verify-2',
          'Use your write tool to create a file named codeword.txt in the current directory containing exactly the word SECOND (no newline). Then reply with exactly one word and nothing else: DONE',
          T,
        );
        const detail = expectCompletedWord(ev, s, 'verify-2', 'DONE');
        const file = path.join(cwd, 'codeword.txt');
        if (!fs.existsSync(file)) throw new Error('codeword.txt was not created');
        if (fs.readFileSync(file, 'utf8').trim() !== 'SECOND') throw new Error('codeword.txt has unexpected content');
        return `${detail}; codeword.txt written`;
      });
      await step('turn 3: interrupt a long turn → turn.interrupted', async () => {
        await s.rt.send('verify-3', 'Write every integer from 1 to 5000 in words, one per line, with no other text. Do not use tools.');
        await s.waitFor((e) => e.type === 'turn.started' && e.messageId === 'verify-3', 60_000, 'turn.started');
        await Bun.sleep(1_500); // let the model get going
        const t0 = Date.now();
        await s.rt.interrupt();
        const ev = await s.outcome('verify-3', 60_000);
        if (ev.type !== 'turn.interrupted') throw new Error(`expected turn.interrupted, got ${ev.type}`);
        if (!s.events.some((e) => e.type === 'interrupt.acked')) throw new Error('no interrupt.acked');
        return `interrupted ${Date.now() - t0}ms after interrupt()`;
      });
      await step('close → exited, process group gone', async () => {
        await s.rt.close({ graceMs: 3_000 });
        await s.done;
        const last = s.events.at(-1);
        if (last?.type !== 'exited') throw new Error(`last event is ${last?.type}`);
        if (groupAlive(s.rt.pid)) throw new Error(`process group ${s.rt.pid} still has live members`);
        return `exit code ${last.code}, signal ${last.signal ?? 'none'}`;
      });
      current = null;

      // ---- resume ------------------------------------------------------------------
      const resumed = await step('resume → ready (history loaded, same model)', async () => {
        const rt = await factory.start({
          spec: { ...spec, providerSessionId: spec.sessionId, ...(transcriptPath ? { transcriptPath } : {}) },
          resume: true,
          env,
          rawLogPath,
        });
        current = new Session(rt);
        const ready = await current.waitFor((e) => e.type === 'ready', 60_000, 'ready');
        if (ready.type !== 'ready') throw new Error('unreachable');
        const info = ready.info ?? {};
        if (info.mode !== 'resume') throw new Error(`mode ${String(info.mode)}`);
        if (String(info.model) !== model) throw new Error(`model changed: ${String(info.model)}`);
        return `${String(info.messageCount)} messages loaded`;
      });
      if (resumed && current) {
        const r: Session = current;
        await step('turn 4: history survives resume', async () =>
          expectCompletedWord(
            await runTurn(
              r,
              'verify-4',
              'What was the one-word reply you gave to my FIRST message in this conversation? Reply with exactly that one word and nothing else.',
              T,
            ),
            r,
            'verify-4',
            first,
          ),
        );
        await step('close resumed session', async () => {
          await r.rt.close({ graceMs: 3_000 });
          await r.done;
          if (groupAlive(r.rt.pid)) throw new Error(`process group ${r.rt.pid} still has live members`);
          return 'exited';
        });
        current = null;
      }
    }
  } finally {
    const cur = current as Session | null;
    if (cur) await cur.rt.close({ graceMs: 1_000 }).catch(() => {});
  }

  printTable();
  const failed = rows.filter((r) => !r.ok).length;
  if (failed > 0 || args.keep) {
    console.log(`\nraw protocol log: ${rawLogPath}`);
    console.log(`harness stderr log: ${codexStderrLogPath(rawLogPath)}`);
    if (transcriptPath) console.log(`session file: ${transcriptPath}`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed === 0 ? `\nPASS (${rows.length} checks)` : `\nFAIL (${failed} of ${rows.length} checks failed)`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`verify-runtime/codex: ${(e as Error)?.message ?? String(e)}`);
    process.exit(2);
  },
);
