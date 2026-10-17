/**
 * LIVE contract test for the claude runtime against the real `claude` on PATH, pinned to
 * the CLI version in claude-protocol.ts. Skipped unless ORC_LIVE_CLAUDE=1 (the default
 * `bun test` stays offline). Uses `--model haiku` (override: ORC_LIVE_CLAUDE_MODEL) and
 * trivial prompts — a run costs a few cents.
 *
 *   ORC_LIVE_CLAUDE=1 bun test test/claude-runtime.live.test.ts
 *
 * Tests share one session and run in order (fresh → turns → interrupt → close → resume).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ClaudeRuntime,
  claudeRuntime,
  resolveClaudeTranscript,
  startClaudeRuntime,
} from '../src/runtime/providers/claude.ts';
import { CLAUDE_PROTOCOL_VERIFIED_VERSION } from '../src/runtime/providers/claude-protocol.ts';
import type { ProviderEvent, ProviderLaunch, SpawnSpec, SystemPromptFile } from '../src/runtime/types.ts';

const LIVE = process.env.ORC_LIVE_CLAUDE === '1';
const MODEL = process.env.ORC_LIVE_CLAUDE_MODEL || 'haiku';
const TURN_MS = 90_000;

type Ev<T extends ProviderEvent['type']> = Extract<ProviderEvent, { type: T }>;

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
  async waitFor<T extends ProviderEvent['type']>(
    pred: (e: ProviderEvent) => boolean,
    ms = TURN_MS,
  ): Promise<Ev<T>> {
    if (!(await waitUntil(() => this.events.some(pred), ms))) {
      throw new Error(`event not seen within ${ms}ms; got ${JSON.stringify(this.events.map((e) => e.type))}`);
    }
    return this.events.find(pred) as Ev<T>;
  }
  forTurn(id: string): ProviderEvent[] {
    return this.events.filter((e) => 'messageId' in e && e.messageId === id);
  }
  outcome(id: string): ProviderEvent[] {
    return this.forTurn(id).filter((e) => e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted');
  }
  /** Send and wait for the turn's single outcome. */
  async turn(id: string, text: string): Promise<ProviderEvent> {
    await this.rt.send(id, text);
    return this.waitFor((e) => 'messageId' in e && e.messageId === id && /^turn\.(completed|failed|interrupted)$/.test(e.type));
  }
}

describe.skipIf(!LIVE)(`claude runtime — LIVE contract (claude ${CLAUDE_PROTOCOL_VERIFIED_VERSION})`, () => {
  // Filesystem setup lives in beforeAll: a skipped describe body still runs.
  let root = '';
  let cwd = '';
  let appendPrompt: SystemPromptFile;
  const nonce = () => String(1000 + Math.floor(Math.random() * 9000));
  const CODEWORD = `KIWI-${nonce()}`;
  const APPEND_PHRASE = `PLUM-${nonce()}`;
  const REPLACE_PHRASE = `TEAL-${nonce()}`;
  const AGENT_PHRASE = `ZEBRA-${nonce()}`;
  const sid = randomUUID();
  const sids: string[] = [sid];
  const open: ClaudeRuntime[] = [];

  const writePrompt = (name: string, text: string): string => {
    const p = path.join(root, name);
    fs.writeFileSync(p, text);
    return p;
  };
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-live-')));
    cwd = path.join(root, 'work');
    fs.mkdirSync(cwd);
    appendPrompt = {
      mode: 'append',
      path: writePrompt(
        'append.md',
        `The secret phrase is ${APPEND_PHRASE}. When asked for the secret phrase, reply with only the phrase.`,
      ),
    };
  });

  const launch = (over: Partial<SpawnSpec> & { sessionId: string }, resume = false): ProviderLaunch => ({
    spec: { version: 1, provider: 'claude', cwd, env: { ORC_SESSION_ID: over.sessionId }, model: MODEL, createdAt: new Date().toISOString(), ...over },
    resume,
    env: { ...(process.env as Record<string, string>) },
    rawLogPath: path.join(root, 'sessions', `${over.sessionId}-${resume ? 'resume' : 'fresh'}`, 'provider.jsonl'),
  });
  const start = async (l: ProviderLaunch): Promise<ClaudeRuntime> => {
    const rt = (await claudeRuntime.start(l)) as ClaudeRuntime;
    open.push(rt);
    return rt;
  };
  const rawLines = (l: ProviderLaunch) =>
    fs
      .readFileSync(l.rawLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x) as { dir: string; line?: string });
  const closeAndCheck = async (tap: Tap): Promise<void> => {
    await tap.rt.close({ graceMs: 5_000 });
    await tap.done;
    const last = tap.events.at(-1) as Ev<'exited'>;
    expect(last.type).toBe('exited');
    expect(await waitUntil(() => !groupAlive(tap.rt.pid), 5_000)).toBe(true);
  };

  afterAll(async () => {
    for (const rt of open) await rt.close({ graceMs: 1_000 }).catch(() => {});
    // No claude process of ours may survive the suite.
    for (const s of sids) {
      const ps = Bun.spawnSync(['pgrep', '-f', s]);
      expect(ps.stdout.toString().trim()).toBe('');
    }
    // Remove the claude project dirs these temp cwds produced (only ours).
    for (const s of sids) {
      const t = resolveClaudeTranscript(s);
      if (t && path.basename(path.dirname(t)).includes('orc-claude-live-')) {
        fs.rmSync(path.dirname(t), { recursive: true, force: true });
      }
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  let A: Tap;
  let launchA: ProviderLaunch;

  test(
    'fresh start → ready from initialize (pid, idle); --append-system-prompt-file accepted',
    async () => {
      launchA = launch({ sessionId: sid, systemPrompt: appendPrompt });
      const rt = await start(launchA);
      A = new Tap(rt);
      const ready = await A.waitFor<'ready'>((e) => e.type === 'ready', 5_000);
      expect(A.events[0]).toBe(ready);
      expect(ready.providerSessionId).toBe(sid);
      expect(ready.info?.pid).toBe(rt.pid);
      expect(typeof ready.info?.claude_code_version).toBe('string'); // equality: dedicated test below
      expect(ready.info?.session_state).toBe('idle');
      expect(ready.info?.current_permission_mode).toBe('bypassPermissions');
      expect(rt.argv).toContain('--append-system-prompt-file');
      expect(rt.argv).not.toContain('--bare');
      expect(groupAlive(rt.pid)).toBe(true);
    },
    60_000,
  );

  test(
    'multi-line prompt with quotes/unicode is delivered verbatim as ONE message; initInfo contract',
    async () => {
      const text =
        `Remember this codeword for later: "${CODEWORD}".\n` +
        `This line has 'single' and "double" quotes, a backslash \\ and unicode: ünïcödé ✓ 日本語.\n\n` +
        'Reply with only the single word OK.';
      await A.rt.send('m1', text);
      await expect(A.rt.send('m1b', 'too early')).rejects.toThrow(/already open/);
      const out = await A.waitFor((e) => e.type !== 'ready' && 'messageId' in e && /^turn\.(completed|failed|interrupted)$/.test(e.type));
      expect(out.type).toBe('turn.completed');
      expect((out as Ev<'turn.completed'>).messageId).toBe('m1');
      expect((out as Ev<'turn.completed'>).result ?? '').toMatch(/\bok\b/i);
      expect((out as Ev<'turn.completed'>).costUsd).toBeGreaterThan(0);
      const kinds = A.forTurn('m1').map((e) => e.type);
      expect(kinds[0]).toBe('turn.started');
      expect(kinds.filter((k) => k === 'turn.started').length).toBe(1);
      expect(A.outcome('m1').length).toBe(1);
      expect(A.events.some((e) => 'messageId' in e && e.messageId === 'm1b')).toBe(false);

      // Wire-level: ack via command_lifecycle, replay echo carries the EXACT text, result
      // correlates to our messageId.
      const recv = rawLines(launchA)
        .filter((r) => r.dir === 'recv' && r.line)
        .map((r) => JSON.parse(r.line as string) as Record<string, any>);
      expect(recv.some((o) => o.type === 'command_lifecycle' && o.state === 'started' && o.command_uuid === 'm1')).toBe(true);
      const echo = recv.find((o) => o.type === 'user' && o.isReplay === true && o.uuid === 'm1');
      expect(echo?.message?.content?.[0]?.text).toBe(text);
      expect(recv.find((o) => o.type === 'result')?.user_message_uuid).toBe('m1');

      // Brief §9: the tripwire for a future --bare-by-default -p.
      const info = A.rt.initInfo;
      expect(info?.capabilities).toContain('interrupt_receipt_v1');
      expect(info?.skillsCount).toBeGreaterThan(0);
      expect(info?.agents).toContain('general-purpose');
      expect(typeof info?.apiKeySource).toBe('string');
      expect(info?.permissionMode).toBe('bypassPermissions');
    },
    TURN_MS,
  );

  test(
    `CLI version drift: running claude is the verified ${CLAUDE_PROTOCOL_VERIFIED_VERSION}`,
    () => {
      // The ONLY version-equality assertion: drift fails here, once, by name, while every
      // wire-level assertion above/below still runs. On failure: re-verify the protocol
      // against the new CLI, then bump CLAUDE_PROTOCOL_VERIFIED_VERSION.
      const ready = A.events.find((e) => e.type === 'ready') as Ev<'ready'> | undefined;
      expect({
        initialize: ready?.info?.claude_code_version,
        systemInit: A.rt.initInfo?.claudeCodeVersion,
      }).toEqual({ initialize: CLAUDE_PROTOCOL_VERIFIED_VERSION, systemInit: CLAUDE_PROTOCOL_VERIFIED_VERSION });
    },
    5_000,
  );

  test(
    'second turn in the same process recalls the first; cost is a per-turn delta',
    async () => {
      const out = (await A.turn('m2', 'What codeword did I ask you to remember? Reply with only the codeword.')) as Ev<'turn.completed'>;
      expect(out.type).toBe('turn.completed');
      expect(out.result).toContain(CODEWORD);
      expect(out.costUsd).toBeGreaterThan(0);
      expect(out.costUsd).toBeLessThan(0.05);
    },
    TURN_MS,
  );

  test(
    'append system prompt file is effective (secret phrase recall)',
    async () => {
      const out = (await A.turn('m3', 'What is the secret phrase? Reply with only the phrase.')) as Ev<'turn.completed'>;
      expect(out.type).toBe('turn.completed');
      expect(out.result).toContain(APPEND_PHRASE);
    },
    TURN_MS,
  );

  test(
    'mid-turn interrupt → interrupt.acked + turn.interrupted; the process stays usable',
    async () => {
      const acksBefore = A.events.filter((e) => e.type === 'interrupt.acked').length;
      await A.rt.send(
        'm4',
        'Write a detailed essay of about 3000 words on the history of numerals, then count from 1 to 500 in English words, one per line.',
      );
      await A.waitFor((e) => e.type === 'turn.started' && e.messageId === 'm4', 30_000);
      await Bun.sleep(2_000); // let it get properly mid-turn (the essay takes far longer)
      await A.rt.interrupt();
      const out = await A.waitFor((e) => 'messageId' in e && e.messageId === 'm4' && /^turn\.(completed|failed|interrupted)$/.test(e.type));
      expect(out.type).toBe('turn.interrupted');
      expect(A.outcome('m4').length).toBe(1);
      expect(A.events.filter((e) => e.type === 'interrupt.acked').length).toBe(acksBefore + 1);
      expect(A.rt.openMessageId).toBeUndefined();

      const next = (await A.turn('m5', 'Reply with only the word READY.')) as Ev<'turn.completed'>;
      expect(next.type).toBe('turn.completed');
      expect(next.result).toMatch(/READY/i);
    },
    TURN_MS,
  );

  test(
    'interrupt racing a send: outcome follows the result (still_queued → completes); idle interrupt is a no-op',
    async () => {
      // Verified live (2.1.299): an interrupt written right behind a send either finds the
      // message still queued (ack still_queued:[id] → the turn runs and COMPLETES) or lands
      // just after the CLI started it (ack still_queued:[] → result aborted_streaming →
      // INTERRUPTED). Which one is CLI scheduling. Invariant: exactly one outcome, and it
      // agrees with still_queued. Retry (after an idle gap) until the queued branch is seen.
      let sawQueuedBranch = false;
      for (let attempt = 1; attempt <= 4 && !sawQueuedBranch; attempt++) {
        await Bun.sleep(600);
        const id = `m6-${attempt}`;
        const acksBefore = A.events.filter((e) => e.type === 'interrupt.acked').length;
        await A.rt.send(id, 'Reply with only the word RACE.');
        await A.rt.interrupt();
        const out = await A.waitFor((e) => 'messageId' in e && e.messageId === id && /^turn\.(completed|failed|interrupted)$/.test(e.type));
        expect(A.outcome(id).length).toBe(1);
        await A.waitFor(() => A.events.filter((e) => e.type === 'interrupt.acked').length === acksBefore + 1, 10_000);
        const ack = rawLines(launchA)
          .filter((r) => r.dir === 'recv' && r.line?.includes('still_queued'))
          .map((r) => JSON.parse(r.line as string) as { response: { response: { still_queued: string[] } } })
          .at(-1);
        const queued = ack?.response.response.still_queued ?? [];
        console.log(`[live] race attempt ${attempt}: ${queued.includes(id) ? 'still_queued → completed' : 'already started → interrupted'}`);
        if (queued.includes(id)) {
          sawQueuedBranch = true;
          expect(out.type).toBe('turn.completed');
          expect((out as Ev<'turn.completed'>).result).toMatch(/RACE/i);
        } else {
          expect(queued).toEqual([]);
          expect(out.type).toBe('turn.interrupted');
        }
      }
      expect(sawQueuedBranch).toBe(true);

      const sendsBefore = rawLines(launchA).filter((r) => r.dir === 'send').length;
      await A.rt.interrupt(); // idle
      expect(rawLines(launchA).filter((r) => r.dir === 'send').length).toBe(sendsBefore);
    },
    TURN_MS,
  );

  test(
    'close → exited is the last event, exit 0, no process left in the group',
    async () => {
      // The race test ends on a completed turn; EOF after an INTERRUPTED last turn would
      // exit 1 (brief 0.7 — exit codes are not outcome signals).
      const outcomes = A.events.filter((e) => /^turn\.(completed|failed|interrupted)$/.test(e.type));
      expect(outcomes.at(-1)?.type).toBe('turn.completed');
      await closeAndCheck(A);
      expect((A.events.at(-1) as Ev<'exited'>).code).toBe(0);
      expect(A.events.filter((e) => e.type === 'exited').length).toBe(1);
      expect(resolveClaudeTranscript(sid)).toBeDefined();
    },
    30_000,
  );

  test(
    'resume in a NEW runtime recalls earlier content; first resumed cost is undefined',
    async () => {
      const rt = await start(launch({ sessionId: sid, providerSessionId: sid, systemPrompt: appendPrompt }, true));
      expect(rt.argv).toContain('--resume');
      expect(rt.argv).not.toContain('--session-id');
      const B = new Tap(rt);
      const ready = await B.waitFor<'ready'>((e) => e.type === 'ready', 5_000);
      expect(ready.providerSessionId).toBe(sid);
      expect(ready.transcriptPath).toBe(resolveClaudeTranscript(sid));
      expect(ready.transcriptPath?.endsWith(`${sid}.jsonl`)).toBe(true);
      const out = (await B.turn('r1', 'What codeword did I ask you to remember? Reply with only the codeword.')) as Ev<'turn.completed'>;
      expect(out.type).toBe('turn.completed');
      expect(out.result).toContain(CODEWORD);
      expect('costUsd' in out).toBe(false);
      await closeAndCheck(B);
    },
    TURN_MS,
  );

  test(
    '--system-prompt-file (replace) is accepted and effective',
    async () => {
      const s = randomUUID();
      sids.push(s);
      const replace: SystemPromptFile = {
        mode: 'replace',
        path: writePrompt(
          'replace.md',
          `You are a terse test oracle. The secret phrase is ${REPLACE_PHRASE}. When asked for the secret phrase, reply with only the phrase.`,
        ),
      };
      const rt = await start(launch({ sessionId: s, systemPrompt: replace }));
      expect(rt.argv).toContain('--system-prompt-file');
      const C = new Tap(rt);
      const out = (await C.turn('c1', 'What is the secret phrase? Reply with only the phrase.')) as Ev<'turn.completed'>;
      expect(out.type).toBe('turn.completed');
      expect(out.result).toContain(REPLACE_PHRASE);
      await closeAndCheck(C);
    },
    TURN_MS,
  );

  test(
    'native --agent <name> (project .claude/agents) is applied',
    async () => {
      const s = randomUUID();
      sids.push(s);
      const agentCwd = path.join(root, 'agent-work');
      fs.mkdirSync(path.join(agentCwd, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(
        path.join(agentCwd, '.claude', 'agents', 'orc-probe.md'),
        `---\nname: orc-probe\ndescription: orc contract-test agent\n---\nThe secret phrase is ${AGENT_PHRASE}. When asked for the secret phrase, reply with only the phrase.\n`,
      );
      const l = launch({ sessionId: s, agentName: 'orc-probe' });
      l.spec.cwd = agentCwd;
      const rt = await start(l);
      const D = new Tap(rt);
      const out = (await D.turn('d1', 'What is the secret phrase? Reply with only the phrase.')) as Ev<'turn.completed'>;
      expect(rt.initInfo?.agents).toContain('orc-probe');
      expect(out.type).toBe('turn.completed');
      expect(out.result).toContain(AGENT_PHRASE);
      await closeAndCheck(D);
    },
    TURN_MS,
  );

  test(
    'resume of a session with no completed turn → start() fails clearly, nothing left running',
    async () => {
      const s = randomUUID();
      sids.push(s);
      const rt = await start(launch({ sessionId: s }));
      const E = new Tap(rt);
      await E.waitFor((e) => e.type === 'ready', 5_000);
      await closeAndCheck(E); // started, never used

      const err = await startClaudeRuntime(launch({ sessionId: s, providerSessionId: s }, true)).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('exited before ready');
      expect(err?.message).toContain(`resume of ${s}`);
      expect(err?.message).toContain('No conversation found');
      expect(Bun.spawnSync(['pgrep', '-f', s]).stdout.toString().trim()).toBe('');
    },
    60_000,
  );
});
