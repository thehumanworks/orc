/**
 * `fake` provider runtime: a REAL child process (./fake-child.ts) driven over JSONL
 * pipes, in its own process group, scripted by `spec.fakeScript`. It exists so the actor
 * kernel can be tested end-to-end (spawn, turns, interrupts, crashes, orphaned providers,
 * resume) without any provider CLI.
 *
 * Wire protocol (verbatim lines are appended to launch.rawLogPath):
 *   stdin  → {"op":"send","messageId","text"} | {"op":"interrupt"}
 *   stdout ← ProviderEvent-shaped objects (everything except `exited`, which the parent
 *            synthesises from the child's exit status)
 *
 * Runs from source only: the child is `<bun> fake-child.ts` (not available inside a
 * `bun build --compile` binary — tests only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processStartTime, signalProcessGroup } from '../process.ts';
import type {
  ProviderEvent,
  ProviderLaunch,
  ProviderRuntime,
  ProviderRuntimeFactory,
} from '../types.ts';

export const FAKE_CHILD_PATH = path.join(import.meta.dir, 'fake-child.ts');

/**
 * Per-turn behaviour.
 * - reply      (default) turn.started → assistant.text → turn.completed after delayMs
 * - fail       turn.started → turn.failed{error} after delayMs
 * - hang       turn.started, then nothing until interrupted (→ turn.interrupted)
 * - permission turn.started → permission.requested after delayMs, then hang until interrupted
 * - exit       turn.started → process exits with exitCode after delayMs
 * - crash      turn.started → process SIGKILLs itself after delayMs
 */
export type FakeAction = 'reply' | 'fail' | 'hang' | 'permission' | 'exit' | 'crash';

export interface FakeBehaviour {
  action?: FakeAction;
  /** Delay before turn.started (the delivery ack). Default 0. */
  ackDelayMs?: number;
  /** Delay between turn.started and the action's effect. Default 10. */
  delayMs?: number;
  /** Reply text (default `echo: <message>`). */
  text?: string;
  /** turn.failed error. */
  error?: string;
  /** Exit code for `exit`. Default 1. */
  exitCode?: number;
  /** permission.requested detail. */
  detail?: unknown;
  /** Acknowledge interrupts but keep the turn running (a provider that ignores them). */
  ignoreInterrupt?: boolean;
}

export interface FakeRule extends FakeBehaviour {
  /** Applies when the message text contains this substring (first matching rule wins). */
  match: string;
}

export interface FakeScript {
  /** Delay before `ready`. Default 0. */
  readyDelayMs?: number;
  /**
   * The factory's start() resolves this long AFTER spawning the child (simulates a
   * provider handshake: the window between spawn and the runtime being returned).
   */
  startDelayMs?: number;
  /** Exit immediately at start with this code (provider fails to start). */
  exitAtStart?: number;
  /** Exit immediately with this code when started in RESUME mode (provider rejects the resume). */
  exitOnResume?: number;
  /** Env var names whose values the child reports in `ready.info.env` (absent → omitted). */
  reportEnv?: string[];
  /**
   * On stdin EOF keep running for this long before exiting (simulates a provider that
   * outlives its actor). Default: exit immediately on EOF.
   */
  ignoreStdinEofMs?: number;
  /** Provider session id for a FRESH start (default `fake-<uuid>`, codex-like server-assigned). */
  providerSessionId?: string;
  rules?: FakeRule[];
  /** Behaviour when no rule matches. Default `{ action: 'reply' }`. */
  default?: FakeBehaviour;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'turn.started',
  'assistant.text',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'interrupt.acked',
  'permission.requested',
]);

function toEvent(line: string): ProviderEvent | undefined {
  try {
    const o = JSON.parse(line) as { type?: unknown };
    if (o && typeof o === 'object' && typeof o.type === 'string' && EVENT_TYPES.has(o.type)) {
      return o as ProviderEvent;
    }
  } catch {
    /* not protocol */
  }
  return undefined;
}

type FakeProc = Bun.Subprocess<'pipe', 'pipe', 'inherit'>;

class FakeRuntime implements ProviderRuntime {
  readonly provider = 'fake' as const;
  private consumed = false;

  constructor(
    private readonly proc: FakeProc,
    private readonly rawLogPath: string,
  ) {}

  get pid(): number {
    return this.proc.pid;
  }

  private raw(dir: 'send' | 'recv', line: string): void {
    try {
      fs.appendFileSync(this.rawLogPath, `${JSON.stringify({ ts: new Date().toISOString(), dir, line })}\n`, {
        mode: 0o600,
      });
    } catch {
      /* debug stream only */
    }
  }

  private write(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj);
    this.raw('send', line);
    try {
      this.proc.stdin.write(`${line}\n`);
      void this.proc.stdin.flush();
    } catch {
      /* child gone: `exited` will follow */
    }
  }

  events(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('fake runtime: events() is single-consumer');
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<ProviderEvent> {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim().length === 0) continue;
          this.raw('recv', line);
          const ev = toEvent(line);
          if (ev) yield ev;
        }
      }
    } catch {
      /* stream error → treat as EOF */
    }
    await this.proc.exited;
    yield { type: 'exited', code: this.proc.exitCode, signal: this.proc.signalCode ?? null };
  }

  async send(messageId: string, text: string): Promise<void> {
    this.write({ op: 'send', messageId, text });
  }

  async interrupt(): Promise<void> {
    this.write({ op: 'interrupt' });
  }

  async close(opts: { graceMs?: number } = {}): Promise<void> {
    const graceMs = opts.graceMs ?? 2_000;
    try {
      void this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    const exited = await Promise.race([
      this.proc.exited.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    if (!exited) {
      try {
        signalProcessGroup(this.proc.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      await this.proc.exited;
    }
  }
}

export const fakeRuntimeFactory: ProviderRuntimeFactory = {
  provider: 'fake',
  async start(launch: ProviderLaunch): Promise<ProviderRuntime> {
    const { spec } = launch;
    const script = (spec.fakeScript ?? {}) as FakeScript;
    let providerSessionId: string;
    if (launch.resume) {
      if (!spec.providerSessionId) throw new Error('fake runtime: resume requires spec.providerSessionId');
      providerSessionId = spec.providerSessionId;
    } else {
      providerSessionId = script.providerSessionId ?? `fake-${randomUUID()}`;
    }
    const proc = Bun.spawn(
      [
        process.execPath,
        FAKE_CHILD_PATH,
        '--orc-session',
        spec.sessionId,
        '--provider-session',
        providerSessionId,
        '--mode',
        launch.resume ? 'resume' : 'fresh',
      ],
      {
        cwd: spec.cwd,
        env: { ...launch.env, ORC_FAKE_SCRIPT: JSON.stringify(script) },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        detached: true,
      },
    );
    launch.onSpawn?.({ pid: proc.pid, startTime: processStartTime(proc.pid) });
    // Simulated start handshake (claude/codex take seconds between spawn and ready).
    if (script.startDelayMs) await Bun.sleep(script.startDelayMs);
    return new FakeRuntime(proc, launch.rawLogPath);
  },
};
