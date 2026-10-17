/**
 * codex runtime: drives orc's in-house codex harness (src/codex/harness.ts — pi-ai +
 * pi-agent-core against the OpenAI Responses API) as a detached child over the JSONL
 * protocol in src/codex/protocol.ts. No external CLI: the harness is this orc build
 * re-executed as `orc __codex-harness <sid>` (compiled: the binary itself; from source:
 * `bun src/cli/index.ts`).
 *
 * Process: Bun.spawn {stdin:'pipe', stdout:'pipe', stderr:<file>, detached:true} → the
 * harness is its own session + process-group leader (pgid === pid); its bash tool children
 * stay in that group, so a group kill stops them. stderr goes to
 * `<dirname(rawLogPath)>/provider.stderr.log` (diagnostics only, never parsed).
 *
 * Raw log (launch.rawLogPath), one JSON object per line:
 *   {"ts","dir":"send","line"}  line written to the harness's stdin; in the init line the
 *                               spec.env VALUES are redacted (keys kept): extraEnv may carry
 *                               secrets
 *   {"ts","dir":"recv","line"}  line read from the harness's stdout
 *   {"ts","dir":"info","line"}  lifecycle note (spawn argv, stdin closed, exit)
 *
 * Lifecycle:
 *   start  → spawn, onSpawn, write `init` {spec, resume, sessionFile}; wait (≤ bootTimeoutMs)
 *            for `ready` → emit it. `fatal`, exit or timeout → start() rejects (the group is
 *            killed). Resume of a session from the removed codex app-server runtime is
 *            refused before spawning.
 *   send   → `prompt`; resolves once the harness acknowledged (turn.started) or ended the
 *            turn, or exited. Rejects when a turn is open or the runtime is closing.
 *   interrupt → `abort` for the open turn (the harness answers each with interrupt.acked);
 *            no open turn → no-op.
 *   close  → with a turn open: abort it and wait (within graceMs) for its outcome, so the
 *            partial reply is persisted; end stdin (the harness exits 0), wait out the rest
 *            of graceMs (at least min(graceMs, 500 ms)), then terminate the process group.
 *   exit   → the group is swept (SIGKILL) for stragglers, stdout drained; a turn still open
 *            is closed as turn.interrupted; `exited` is always the final event.
 * Exactly one outcome per turn: outcomes for a turn that is not open are dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { processStartTime, selfArgv, signalProcessGroup, terminateProcessGroup } from '../process.ts';
import type {
  ProcessIdentity,
  ProviderEvent,
  ProviderLaunch,
  ProviderRuntime,
  ProviderRuntimeFactory,
  SpawnSpec,
} from '../types.ts';
import { JsonlSplitter } from './pi-protocol.ts';
import { HARNESS_SUBCOMMAND, encodeLine, parseHarnessEvent, type HarnessCommand, type HarnessEvent } from '../../codex/protocol.ts';

/** The harness's session file, next to the session's other runtime files. */
export const CODEX_SESSION_FILE_NAME = 'codex-session.jsonl';
/** Boot covers credential resolution, a token refresh and the live model listing. */
export const CODEX_DEFAULT_BOOT_TIMEOUT_MS = 60_000;
export const CODEX_DEFAULT_CLOSE_GRACE_MS = 3_000;
const STDOUT_DRAIN_MS = 2_000;
const ABORT_PREFIX = '__orc:abort:';

export interface CodexRuntimeOptions {
  /** argv prefix that runs this orc build (default: selfArgv()). */
  argv?: string[];
  /** Max wait for `ready`. Default 60 s (env ORC_CODEX_BOOT_TIMEOUT_MS). */
  bootTimeoutMs?: number;
}

/** Where the harness keeps the conversation for a launch (always beside the raw log). */
export function codexSessionFilePath(rawLogPath: string): string {
  return path.join(path.dirname(rawLogPath), CODEX_SESSION_FILE_NAME);
}

/** Where the harness's stderr goes for a given raw log path. */
export function codexStderrLogPath(rawLogPath: string): string {
  return path.join(path.dirname(rawLogPath), 'provider.stderr.log');
}

/**
 * A codex session created by the removed `codex app-server` runtime: its provider session
 * id is a server-assigned codex thread id. Harness sessions use the orc session id.
 */
export function isLegacyCodexSpec(spec: Pick<SpawnSpec, 'provider' | 'sessionId' | 'providerSessionId'>): boolean {
  return spec.provider === 'codex' && !!spec.providerSessionId && spec.providerSessionId !== spec.sessionId;
}

export function createCodexRuntime(opts: CodexRuntimeOptions = {}): ProviderRuntimeFactory {
  return { provider: 'codex', start: (launch) => startCodex(launch, opts) };
}

/** The production codex runtime. */
export const codexRuntime: ProviderRuntimeFactory = createCodexRuntime();

type ReadyEvent = Extract<ProviderEvent, { type: 'ready' }>;

function bootTimeout(opts: CodexRuntimeOptions, env: Record<string, string>): number {
  if (opts.bootTimeoutMs !== undefined) return opts.bootTimeoutMs;
  const n = Number(env.ORC_CODEX_BOOT_TIMEOUT_MS ?? process.env.ORC_CODEX_BOOT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : CODEX_DEFAULT_BOOT_TIMEOUT_MS;
}

async function startCodex(launch: ProviderLaunch, opts: CodexRuntimeOptions): Promise<ProviderRuntime> {
  const { spec, resume } = launch;
  if (spec.provider !== 'codex') throw new Error(`codex runtime: spec.provider is '${spec.provider}', expected 'codex'`);
  if (resume && isLegacyCodexSpec(spec)) {
    throw new Error(
      `codex runtime: session ${spec.sessionId} was created by the removed codex app-server runtime ` +
        `(thread ${spec.providerSessionId}); it cannot be resumed — start a new session`,
    );
  }
  if (!isDir(spec.cwd)) throw new Error(`codex runtime: cwd is not a directory: ${spec.cwd}`);
  if (spec.systemPrompt && (!path.isAbsolute(spec.systemPrompt.path) || !isFile(spec.systemPrompt.path))) {
    throw new Error(`codex runtime: system prompt file missing or not absolute: ${spec.systemPrompt.path}`);
  }
  const argv = [...(opts.argv ?? selfArgv()), HARNESS_SUBCOMMAND, spec.sessionId];
  const sessionFile = codexSessionFilePath(launch.rawLogPath);
  const rt = CodexRuntime.spawn(argv, launch);
  try {
    const ready = await rt.boot({ type: 'init', spec, resume, sessionFile }, bootTimeout(opts, launch.env));
    rt.markReady(ready);
    return rt;
  } catch (e) {
    await rt.close({ graceMs: 1_000 }).catch(() => {});
    throw e;
  }
}

function spawnHarness(argv: string[], cwd: string, env: Record<string, string>, stderrFd: number) {
  return Bun.spawn(argv, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: stderrFd, detached: true });
}

type HarnessProc = ReturnType<typeof spawnHarness>;

class CodexRuntime implements ProviderRuntime {
  readonly provider = 'codex' as const;
  readonly pid: number;

  private readonly identity: ProcessIdentity;
  private readonly queue = new EventQueue<ProviderEvent>();
  private held: ProviderEvent[] | null = [];
  private rawFd: number | null;
  private bootWaiter: ((ev: HarnessEvent | null) => void) | null = null;
  private openTurn: { messageId: string; acked: boolean } | null = null;
  private ackWaiter: { messageId: string; resolve: () => void } | null = null;
  private stateWaiters: Array<() => void> = [];
  private readonly pendingAborts = new Set<string>();
  private abortSeq = 0;
  private closing: Promise<void> | null = null;
  private stdinEnded = false;
  private hasExited = false;
  private stdoutStopped = false;
  private consumed = false;
  private readonly stdoutDone: Promise<void>;
  private readonly exitDone: Promise<void>;

  static spawn(argv: string[], launch: ProviderLaunch): CodexRuntime {
    fs.mkdirSync(path.dirname(launch.rawLogPath), { recursive: true, mode: 0o700 });
    const rawFd = fs.openSync(launch.rawLogPath, 'a', 0o600);
    let stderrFd: number | null = null;
    try {
      stderrFd = fs.openSync(codexStderrLogPath(launch.rawLogPath), 'a', 0o600);
      const proc = spawnHarness(argv, launch.spec.cwd, launch.env, stderrFd);
      launch.onSpawn?.({ pid: proc.pid, startTime: processStartTime(proc.pid) });
      return new CodexRuntime(proc, rawFd, argv, launch);
    } catch (e) {
      fs.closeSync(rawFd);
      throw new Error(`codex runtime: cannot spawn the harness (${argv.join(' ')}): ${(e as Error).message}`);
    } finally {
      if (stderrFd !== null) fs.closeSync(stderrFd);
    }
  }

  private constructor(
    private readonly proc: HarnessProc,
    rawFd: number,
    argv: string[],
    private readonly launch: ProviderLaunch,
  ) {
    this.pid = proc.pid;
    this.identity = { pid: proc.pid, startTime: processStartTime(proc.pid) };
    this.rawFd = rawFd;
    this.raw('info', `spawn pid=${proc.pid} argv=${JSON.stringify(argv)}`);
    this.stdoutDone = this.readStdout();
    this.exitDone = this.watchExit();
  }

  // ------------------------------------------------------------------ public API

  events(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('codex runtime: events() is single-consumer');
    this.consumed = true;
    return this.queue.drain();
  }

  async send(messageId: string, text: string): Promise<void> {
    if (this.closing || this.stdinEnded || this.hasExited) throw new Error('codex runtime: closed');
    if (this.openTurn) throw new Error(`codex runtime: turn ${this.openTurn.messageId} is still open`);
    if (typeof messageId !== 'string' || messageId.length === 0) throw new Error('codex runtime: messageId must be non-empty');
    if (typeof text !== 'string') throw new Error('codex runtime: message text must be a string');
    this.openTurn = { messageId, acked: false };
    const answered = new Promise<void>((resolve) => {
      this.ackWaiter = { messageId, resolve };
    });
    try {
      await this.write({ type: 'prompt', id: messageId, text });
    } catch {
      // Pipe gone: the harness is exiting; the exit path closes the turn and releases `answered`.
    }
    await answered;
  }

  async interrupt(): Promise<void> {
    if (!this.openTurn || this.stdinEnded || this.hasExited) return;
    await this.writeAbort();
  }

  close(opts?: { graceMs?: number }): Promise<void> {
    if (!this.closing) this.closing = this.shutdown(Math.max(0, opts?.graceMs ?? CODEX_DEFAULT_CLOSE_GRACE_MS));
    return this.closing;
  }

  private async writeAbort(): Promise<void> {
    const id = `${ABORT_PREFIX}${++this.abortSeq}`;
    this.pendingAborts.add(id);
    await this.write({ type: 'abort', id }).catch(() => {
      this.pendingAborts.delete(id);
    });
  }

  private async shutdown(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    if (!this.hasExited && !this.stdinEnded && this.openTurn) {
      // Abort first so the harness settles the turn and persists the partial reply.
      await this.writeAbort();
      await this.waitState(() => this.hasExited || this.openTurn === null, deadline - Date.now());
    }
    this.endStdin();
    const exitWindow = Math.max(deadline - Date.now(), Math.min(graceMs, 500));
    if (!(await this.exitedWithin(exitWindow))) {
      await terminateProcessGroup(this.identity, Math.min(graceMs, 1_000)).catch(() => false);
    }
    await this.exitDone;
  }

  // ------------------------------------------------------------------ startup

  async boot(init: Extract<HarnessCommand, { type: 'init' }>, timeoutMs: number): Promise<ReadyEvent> {
    const ev = await new Promise<HarnessEvent | null | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs);
      this.bootWaiter = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.write(init).catch(() => {});
    });
    this.bootWaiter = null;
    if (ev === 'timeout') throw new Error(`codex runtime: harness not ready within ${timeoutMs} ms${this.stderrHint()}`);
    if (ev === null) {
      throw new Error(
        `codex runtime: harness exited during startup (code=${this.proc.exitCode}, signal=${this.proc.signalCode})${this.stderrHint()}`,
      );
    }
    if (ev.type === 'fatal') throw new Error(ev.error);
    return ev as ReadyEvent;
  }

  markReady(ready: ReadyEvent): void {
    this.queue.push(ready);
    const held = this.held ?? [];
    this.held = null;
    for (const ev of held) this.queue.push(ev);
  }

  // ------------------------------------------------------------------ internals

  private emit(ev: ProviderEvent): void {
    if (this.held) this.held.push(ev);
    else this.queue.push(ev);
  }

  private async write(cmd: HarnessCommand): Promise<void> {
    if (this.hasExited || this.stdinEnded) throw new Error('codex runtime: stdin closed');
    const line = encodeLine(cmd);
    this.raw('send', cmd.type === 'init' ? encodeLine(redactInit(cmd)) : line);
    const sink = this.proc.stdin;
    sink.write(`${line}\n`);
    await sink.flush();
  }

  private endStdin(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    if (this.hasExited) return;
    this.raw('info', 'stdin closed');
    try {
      const r = this.proc.stdin.end();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // already closed
    }
  }

  private async waitState(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.stateWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  private notifyState(): void {
    const ws = this.stateWaiters;
    this.stateWaiters = [];
    for (const w of ws) w();
  }

  private async exitedWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.exitDone.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private releaseAck(messageId: string): void {
    const w = this.ackWaiter;
    if (w && w.messageId === messageId) {
      this.ackWaiter = null;
      w.resolve();
    }
  }

  private onLine(line: string): void {
    if (this.stdoutStopped) return;
    try {
      this.handleLine(line);
    } finally {
      this.notifyState();
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    this.raw('recv', line);
    const ev = parseHarnessEvent(line);
    if (!ev) return;
    if (ev.type === 'ready' || ev.type === 'fatal') {
      this.bootWaiter?.(ev);
      return;
    }
    if (ev.type === 'log') return;
    if (ev.type === 'interrupt.acked') {
      if (this.pendingAborts.delete(ev.id)) this.emit({ type: 'interrupt.acked' });
      return;
    }
    const t = this.openTurn;
    if (!t || ev.messageId !== t.messageId) return; // not ours / already closed
    switch (ev.type) {
      case 'turn.started':
        if (t.acked) return;
        t.acked = true;
        this.emit({ type: 'turn.started', messageId: t.messageId });
        this.releaseAck(t.messageId);
        return;
      case 'assistant.text':
        this.emit({ type: 'assistant.text', messageId: t.messageId, text: ev.text });
        return;
      case 'turn.completed': {
        this.openTurn = null;
        const out: Extract<ProviderEvent, { type: 'turn.completed' }> = { type: 'turn.completed', messageId: t.messageId };
        if (typeof ev.result === 'string') out.result = ev.result;
        if (ev.usage && typeof ev.usage === 'object') out.usage = ev.usage;
        if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) out.costUsd = ev.costUsd;
        this.emit(out);
        this.releaseAck(t.messageId);
        return;
      }
      case 'turn.failed':
        this.openTurn = null;
        this.emit({ type: 'turn.failed', messageId: t.messageId, error: ev.error });
        this.releaseAck(t.messageId);
        return;
      case 'turn.interrupted':
        this.openTurn = null;
        this.emit({ type: 'turn.interrupted', messageId: t.messageId });
        this.releaseAck(t.messageId);
        return;
    }
  }

  private async readStdout(): Promise<void> {
    const split = new JsonlSplitter();
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stdout) {
        for (const line of split.push(dec.decode(chunk, { stream: true }))) this.onLine(line);
      }
    } catch {
      // stream error → treat as EOF
    }
    for (const line of split.push(dec.decode())) this.onLine(line);
    const rest = split.flush();
    if (rest.length > 0 && !this.stdoutStopped) this.raw('recv', rest);
  }

  private async watchExit(): Promise<void> {
    await this.proc.exited;
    this.hasExited = true;
    // Sweep stragglers (bash tool commands) left in the harness's group.
    try {
      signalProcessGroup(this.pid, 'SIGKILL');
    } catch {
      // EPERM / already gone
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.stdoutDone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STDOUT_DRAIN_MS);
      }),
    ]);
    clearTimeout(timer);
    this.stdoutStopped = true;

    const code = this.proc.exitCode;
    const signal = this.proc.signalCode ?? null;
    this.raw('info', `exit code=${code} signal=${signal}`);
    const t = this.openTurn;
    this.openTurn = null;
    if (t) this.emit({ type: 'turn.interrupted', messageId: t.messageId });
    this.pendingAborts.clear();
    this.bootWaiter?.(null);
    const waiter = this.ackWaiter;
    this.ackWaiter = null;
    waiter?.resolve();
    this.emit({ type: 'exited', code, signal });
    this.queue.end();
    this.notifyState();
    if (this.rawFd !== null) {
      try {
        fs.closeSync(this.rawFd);
      } catch {
        // ignore
      }
      this.rawFd = null;
    }
  }

  private raw(dir: 'send' | 'recv' | 'info', line: string): void {
    if (this.rawFd === null) return;
    try {
      fs.writeSync(this.rawFd, `${JSON.stringify({ ts: new Date().toISOString(), dir, line })}\n`);
    } catch {
      // debug stream only
    }
  }

  private stderrHint(): string {
    try {
      const buf = fs.readFileSync(codexStderrLogPath(this.launch.rawLogPath));
      const tail = buf.subarray(Math.max(0, buf.length - 600)).toString('utf8').replace(/\s+/g, ' ').trim();
      return tail ? ` — harness stderr: ${tail}` : '';
    } catch {
      return '';
    }
  }
}

/** The init command as logged: spec.env values replaced (keys kept for debugging). */
export function redactInit(cmd: Extract<HarnessCommand, { type: 'init' }>): Extract<HarnessCommand, { type: 'init' }> {
  const env: Record<string, string> = {};
  for (const k of Object.keys(cmd.spec.env ?? {})) env[k] = '<redacted>';
  return { ...cmd, spec: { ...cmd.spec, env } };
}

/** Unbounded single-consumer queue that buffers until (and while) the consumer iterates. */
class EventQueue<T> {
  private readonly buf: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(v: T): void {
    if (this.ended) return;
    this.buf.push(v);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buf.length > 0) yield this.buf.shift() as T;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
