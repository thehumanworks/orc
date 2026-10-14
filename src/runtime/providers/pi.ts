/**
 * pi runtime (docs/DESIGN-runtime.md §4.1): drives `pi --mode rpc` (verified: pi 1.2.0) over
 * stdio pipes — no PTY, no screen scraping. The wire mapping lives in ./pi-protocol.ts.
 *
 * Process: Bun.spawn {stdin:'pipe', stdout:'pipe', stderr:<file>, detached:true} → pi is its
 * own session + process-group leader (pgid === pid). stderr is diagnostics only and goes to
 * `<dirname(rawLogPath)>/provider.stderr.log`; it is never parsed.
 *
 * Raw log (launch.rawLogPath), one JSON object per line, tagged from orc's point of view:
 *   {"ts":"<iso>","dir":"out","line":"<verbatim line written to pi's stdin>"}
 *   {"ts":"<iso>","dir":"in","line":"<verbatim line read from pi's stdout>"}
 *   {"ts":"<iso>","dir":"meta","line":"<lifecycle note: spawn argv, stdin closed, exit>"}
 *
 * Lifecycle:
 *   start  → spawn, `get_state` (≤ bootTimeoutMs), validate, emit `ready`
 *            {providerSessionId: the --session-id, transcriptPath: get_state.sessionFile,
 *             info: {version, model, thinkingLevel, messageCount}}.
 *            Rejects when pi exits/times out, has no usable model (`model.provider` is
 *            "unknown"), or — on resume — reports an EMPTY session (messageCount 0): pi
 *            silently creates a fresh session when the cwd differs from the original one.
 *   send   → `{"id":<messageId>,"type":"prompt","message":<text>}`; resolves once pi answered
 *            the prompt (turn.started / turn.failed already emitted) or exited. Rejects when
 *            a turn is open or the runtime is closing.
 *   interrupt → `abort` for the open turn (deferred until the prompt ack, because an abort
 *            that beats pi's preflight is a silent no-op). Every interrupt of an open turn
 *            yields exactly one `interrupt.acked` unless pi exits first. No open turn → no-op.
 *   dialogs → an extension `extension_ui_request` dialog (select/confirm/input/editor) is
 *            emitted as `permission.requested` and cancelled at once, so the turn can end.
 *   close  → end stdin (pi's shutdown: it aborts an active run silently and exits 0), wait
 *            graceMs, then terminate the process group (SIGTERM → SIGKILL). An open turn is
 *            closed as `turn.interrupted`. `exited` is always the final event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { processStartTime, signalProcessGroup, terminateProcessGroup } from '../process.ts';
import type {
  ProcessIdentity,
  ProviderEvent,
  ProviderLaunch,
  ProviderRuntime,
  ProviderRuntimeFactory,
} from '../types.ts';
import {
  JsonlSplitter,
  PI_BOOT_ID,
  PI_SESSION_ID_RE,
  PiTurnMapper,
  buildPiArgs,
  encodePiCommand,
  parsePiLine,
  piSessionIdFor,
  type PiRecord,
} from './pi-protocol.ts';

export const PI_DEFAULT_BOOT_TIMEOUT_MS = 15_000;
export const PI_DEFAULT_CLOSE_GRACE_MS = 3_000;
/** After pi exits, how long to keep reading buffered stdout before giving up. */
const STDOUT_DRAIN_MS = 2_000;

export interface PiRuntimeOptions {
  /** pi executable: a path, or a name looked up on launch.env.PATH. Default `pi`. */
  bin?: string;
  /** Max wait for the boot `get_state` response. Default 15 s. */
  bootTimeoutMs?: number;
}

/** Factory with explicit options (tests, verification gates). */
export function createPiRuntime(opts: PiRuntimeOptions = {}): ProviderRuntimeFactory {
  return { provider: 'pi', start: (launch) => startPi(launch, opts) };
}

/** The production pi runtime (`pi` from PATH). */
export const piRuntime: ProviderRuntimeFactory = createPiRuntime();

/** Where pi's stderr goes for a given raw log path. */
export function piStderrLogPath(rawLogPath: string): string {
  return path.join(path.dirname(rawLogPath), 'provider.stderr.log');
}

type ReadyEvent = Extract<ProviderEvent, { type: 'ready' }>;

async function startPi(launch: ProviderLaunch, opts: PiRuntimeOptions): Promise<ProviderRuntime> {
  const { spec, resume, env } = launch;
  if (spec.provider !== 'pi') throw new Error(`pi runtime: spec.provider is '${spec.provider}', expected 'pi'`);
  const sessionId = piSessionIdFor(spec, resume);
  if (!PI_SESSION_ID_RE.test(sessionId)) {
    throw new Error(`pi runtime: invalid pi session id '${sessionId}'`);
  }
  if (!isDir(spec.cwd)) throw new Error(`pi runtime: cwd is not a directory: ${spec.cwd}`);
  if (spec.systemPrompt) {
    const p = spec.systemPrompt.path;
    // pi reads the file when the path exists and otherwise uses the STRING as the prompt.
    if (!path.isAbsolute(p) || !isFile(p)) {
      throw new Error(`pi runtime: system prompt file missing or not absolute: ${p}`);
    }
  }
  if (spec.sessionDir) fs.mkdirSync(spec.sessionDir, { recursive: true, mode: 0o700 });
  const binPath = resolvePiBin(opts.bin ?? 'pi', env);
  const argv = [binPath, ...buildPiArgs(spec, resume)];

  const rt = PiRuntime.spawn(argv, launch);
  try {
    const ready = await rt.boot({
      sessionId,
      resume,
      cwd: spec.cwd,
      timeoutMs: opts.bootTimeoutMs ?? PI_DEFAULT_BOOT_TIMEOUT_MS,
      version: readPiVersion(binPath),
    });
    rt.markReady(ready);
    return rt;
  } catch (e) {
    await rt.close({ graceMs: 1_000 }).catch(() => {});
    throw e;
  }
}

function spawnPiProcess(argv: string[], cwd: string, env: Record<string, string>, stderrFd: number) {
  return Bun.spawn(argv, {
    cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: stderrFd,
    detached: true,
  });
}

type PiProc = ReturnType<typeof spawnPiProcess>;

class PiRuntime implements ProviderRuntime {
  readonly provider = 'pi' as const;
  readonly pid: number;

  private readonly identity: ProcessIdentity;
  private readonly mapper = new PiTurnMapper();
  private readonly queue = new EventQueue<ProviderEvent>();
  /** Events produced before `ready` (flushed after it); null once ready. */
  private held: ProviderEvent[] | null = [];
  private rawFd: number | null;
  private bootWaiter: ((rec: PiRecord | null) => void) | null = null;
  private ackWaiter: { messageId: string; resolve: () => void } | null = null;
  private stdinEnded = false;
  private hasExited = false;
  private stdoutStopped = false;
  private consumed = false;
  private readonly stdoutDone: Promise<void>;
  private readonly exitDone: Promise<void>;

  static spawn(argv: string[], launch: ProviderLaunch): PiRuntime {
    fs.mkdirSync(path.dirname(launch.rawLogPath), { recursive: true, mode: 0o700 });
    const stderrPath = piStderrLogPath(launch.rawLogPath);
    const rawFd = fs.openSync(launch.rawLogPath, 'a', 0o600);
    let stderrFd: number | null = null;
    try {
      stderrFd = fs.openSync(stderrPath, 'a', 0o600);
      const proc = spawnPiProcess(argv, launch.spec.cwd, launch.env, stderrFd);
      return new PiRuntime(proc, rawFd, stderrPath, argv);
    } catch (e) {
      fs.closeSync(rawFd);
      throw e;
    } finally {
      if (stderrFd !== null) fs.closeSync(stderrFd);
    }
  }

  private constructor(
    private readonly proc: PiProc,
    rawFd: number,
    private readonly stderrPath: string,
    argv: string[],
  ) {
    this.pid = proc.pid;
    this.identity = { pid: proc.pid, startTime: processStartTime(proc.pid) };
    this.rawFd = rawFd;
    this.raw('meta', `spawn pid=${proc.pid} argv=${JSON.stringify(argv)}`);
    this.stdoutDone = this.readStdout();
    this.exitDone = this.watchExit();
  }

  // ------------------------------------------------------------------ public API

  events(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('pi runtime: events() is single-consumer');
    this.consumed = true;
    return this.queue.drain();
  }

  async send(messageId: string, text: string): Promise<void> {
    if (this.stdinEnded || this.hasExited) throw new Error('pi runtime: closed');
    const open = this.mapper.openMessageId;
    if (open !== null) throw new Error(`pi runtime: turn ${open} is still open`);
    const cmd = this.mapper.beginTurn(messageId, text);
    const answered = new Promise<void>((resolve) => {
      this.ackWaiter = { messageId, resolve };
    });
    try {
      await this.write(cmd);
    } catch {
      // Pipe gone: pi is exiting; the exit path closes the turn and releases `answered`.
    }
    await answered;
  }

  async interrupt(): Promise<void> {
    if (this.stdinEnded || this.hasExited) return;
    const r = this.mapper.requestInterrupt();
    for (const ev of r.events) this.emit(ev);
    for (const w of r.writes) await this.write(w).catch(() => {});
  }

  async close(opts?: { graceMs?: number }): Promise<void> {
    const graceMs = Math.max(0, opts?.graceMs ?? PI_DEFAULT_CLOSE_GRACE_MS);
    this.endStdin();
    if (!(await this.exitedWithin(graceMs))) {
      await terminateProcessGroup(this.identity, Math.min(graceMs, 1_000)).catch(() => false);
    }
    await this.exitDone;
  }

  // ------------------------------------------------------------------ startup

  async boot(o: {
    sessionId: string;
    resume: boolean;
    cwd: string;
    timeoutMs: number;
    version?: string;
  }): Promise<ReadyEvent> {
    const rec = await new Promise<PiRecord | null | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), o.timeoutMs);
      this.bootWaiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.write({ id: PI_BOOT_ID, type: 'get_state' }).catch(() => {});
    });
    this.bootWaiter = null;
    if (rec === 'timeout') {
      throw new Error(`pi runtime: no get_state response within ${o.timeoutMs} ms${this.stderrHint()}`);
    }
    if (rec === null) {
      throw new Error(
        `pi runtime: pi exited during startup (code=${this.proc.exitCode}, signal=${this.proc.signalCode})${this.stderrHint()}`,
      );
    }
    if (rec.success !== true) {
      throw new Error(`pi runtime: get_state failed: ${typeof rec.error === 'string' ? rec.error : 'unknown error'}`);
    }
    const data = isRecord(rec.data) ? rec.data : {};
    const model = isRecord(data.model) ? data.model : {};
    const modelProvider = typeof model.provider === 'string' ? model.provider : undefined;
    if (!modelProvider || modelProvider === 'unknown') {
      throw new Error(
        'pi runtime: pi has no usable model (get_state.model.provider is "unknown") — set the session model or configure/log in to pi',
      );
    }
    const messageCount = typeof data.messageCount === 'number' ? data.messageCount : undefined;
    if (o.resume && messageCount === 0) {
      throw new Error(
        `pi runtime: resuming pi session ${o.sessionId} produced an EMPTY session (messageCount 0). ` +
          'pi only finds a --session-dir session from the cwd it was created in, so the cwd likely differs ' +
          `(cwd=${o.cwd}) or the session has no history; refusing to continue in a silently fresh session`,
      );
    }
    const info: Record<string, unknown> = {
      model: `${modelProvider}/${typeof model.id === 'string' ? model.id : 'unknown'}`,
    };
    if (o.version) info.version = o.version;
    if (typeof data.thinkingLevel === 'string') info.thinkingLevel = data.thinkingLevel;
    if (messageCount !== undefined) info.messageCount = messageCount;
    const ready: ReadyEvent = { type: 'ready', providerSessionId: o.sessionId, info };
    if (typeof data.sessionFile === 'string' && data.sessionFile.length > 0) ready.transcriptPath = data.sessionFile;
    return ready;
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

  private async write(cmd: PiRecord): Promise<void> {
    if (this.hasExited || this.stdinEnded) throw new Error('pi runtime: stdin closed');
    const line = encodePiCommand(cmd);
    this.raw('out', line);
    const sink = this.proc.stdin;
    sink.write(`${line}\n`);
    await sink.flush();
  }

  private endStdin(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    if (this.hasExited) return;
    this.raw('meta', 'stdin closed');
    try {
      const r = this.proc.stdin.end();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // already closed
    }
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

  private onLine(line: string): void {
    if (this.stdoutStopped) return;
    this.raw('in', line);
    const rec = parsePiLine(line);
    if (!rec) {
      if (line.trim().length > 0) this.mapper.nonJsonLines++;
      return;
    }
    if (rec.type === 'response' && rec.id === PI_BOOT_ID) {
      this.bootWaiter?.(rec);
      return;
    }
    const r = this.mapper.handleRecord(rec);
    for (const ev of r.events) this.emit(ev);
    for (const w of r.writes) this.write(w).catch(() => {});
    const waiter = this.ackWaiter;
    // Released by the prompt's response, or (defensively) by its turn closing without one.
    if (
      waiter &&
      ((rec.type === 'response' && rec.id === waiter.messageId) || this.mapper.openMessageId !== waiter.messageId)
    ) {
      this.ackWaiter = null;
      waiter.resolve();
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
    // An unterminated line at EOF is a protocol error: logged, never interpreted.
    if (rest.length > 0 && !this.stdoutStopped) this.raw('in', rest);
  }

  private async watchExit(): Promise<void> {
    await this.proc.exited;
    this.hasExited = true;
    // Sweep stragglers (e.g. a bash tool child) left in pi's group: no orphan writers.
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
    this.raw('meta', `exit code=${code} signal=${signal}`);
    for (const ev of this.mapper.finishOnExit()) this.emit(ev);
    this.bootWaiter?.(null);
    const waiter = this.ackWaiter;
    this.ackWaiter = null;
    waiter?.resolve();
    this.emit({ type: 'exited', code, signal });
    this.queue.end();
    if (this.rawFd !== null) {
      try {
        fs.closeSync(this.rawFd);
      } catch {
        // ignore
      }
      this.rawFd = null;
    }
  }

  private raw(dir: 'in' | 'out' | 'meta', line: string): void {
    if (this.rawFd === null) return;
    try {
      fs.writeSync(this.rawFd, `${JSON.stringify({ ts: new Date().toISOString(), dir, line })}\n`);
    } catch {
      // debug stream only: never fail the runtime over it
    }
  }

  private stderrHint(): string {
    try {
      const buf = fs.readFileSync(this.stderrPath);
      const tail = buf.subarray(Math.max(0, buf.length - 600)).toString('utf8').replace(/\s+/g, ' ').trim();
      return tail ? ` — pi stderr: ${tail}` : '';
    } catch {
      return '';
    }
  }

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

function resolvePiBin(bin: string, env: Record<string, string>): string {
  if (bin.includes('/')) {
    const abs = path.resolve(bin);
    if (!isFile(abs)) throw new Error(`pi runtime: pi executable not found: ${abs}`);
    return abs;
  }
  const found = Bun.which(bin, { PATH: env.PATH ?? process.env.PATH ?? '' });
  if (!found) throw new Error(`pi runtime: '${bin}' not found on PATH`);
  return found;
}

/** pi's version from the package.json next to the (symlink-resolved) executable, if any. */
export function readPiVersion(binPath: string): string | undefined {
  try {
    let dir = path.dirname(fs.realpathSync(binPath));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (
          isRecord(parsed) &&
          typeof parsed.name === 'string' &&
          parsed.name.endsWith('pi-coding-agent') &&
          typeof parsed.version === 'string'
        ) {
          return parsed.version;
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // unknown layout (compiled binary, …)
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
