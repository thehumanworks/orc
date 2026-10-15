/**
 * codex provider runtime: drives `codex app-server` (JSON-RPC 2.0 over stdio JSONL) as a
 * detached child in its own process group. Wire facts and the raw→event mapping were
 * verified against codex-cli 0.162.1 (see ./codex-protocol.ts and docs/DESIGN-runtime.md
 * §4.1).
 *
 * Lifecycle
 *   spawn `[codex, "app-server"]` (bin: env ORC_CODEX_BIN, else `codex` on PATH), stdin/stdout
 *   pipes, stderr appended to `provider.stderr.log` next to `launch.rawLogPath`, detached.
 *   → `initialize` → `initialized` → `thread/start` (fresh) | `thread/resume` (resume)
 *   → `ready { providerSessionId: thread.id, transcriptPath: thread.path }`.
 *   Yolo lives on thread/start: approvalPolicy "never", sandbox "danger-full-access" (the
 *   CLI bypass flag is rejected by app-server). The persona travels over stdin, never argv:
 *   systemPrompt append → `developerInstructions`, replace → `baseInstructions`.
 *
 * Turn mapping (one open turn at a time; exactly one outcome per turn while the provider
 * lives — a turn still open when the process exits gets NO outcome from here: `exited` is
 * the signal and the kernel journals `turn.interrupted{reason:'provider-exit'}`):
 *   turn/start response            → turn.started (the delivery ack; carries the turnId)
 *   turn/start error / timeout     → turn.failed (the turn never opened)
 *   item/completed agentMessage    → assistant.text (one per non-empty completed item)
 *   thread/tokenUsage/updated      → summed per turn into turn.completed.usage
 *   turn/completed completed       → turn.completed { result: last agentMessage text,
 *                                     preferring phase "final_answer" }
 *   turn/completed failed          → turn.failed { error: turn.error.message }
 *   turn/completed interrupted     → turn.interrupted (also without an orc interrupt)
 *   turn/interrupt response        → interrupt.acked (turn/interrupt is only sent once codex
 *                                     announced the turn with `turn/started`: an interrupt
 *                                     between the ack and turn/started is otherwise dropped)
 *   approval / input server requests → permission.requested, then a never-accepting reply
 *   unknown server requests        → JSON-RPC error -32601 (codex never blocks on orc)
 *   process exit                   → exited (always last; after stdout drained and the whole
 *                                     process group — incl. codex's `git` helpers — is gone)
 *
 * Raw log: every protocol line in both directions is appended to `launch.rawLogPath` as
 * `{"ts","dir":"send"|"recv","line"}` (send = orc→codex stdin, recv = codex→orc stdout;
 * the orc-wide raw-log format); runtime notes (stray lines, orphan interrupts, auto-replies
 * to unknown requests) use `dir:"info"`.
 */
import fs from 'node:fs';
import path from 'node:path';
import pkg from '../../../package.json';
import { processStartTime, signalProcessGroup, terminateProcessGroup } from '../process.ts';
import type {
  ProcessIdentity,
  ProviderEvent,
  ProviderLaunch,
  ProviderRuntime,
  ProviderRuntimeFactory,
  SpawnSpec,
  TurnUsage,
} from '../types.ts';
import {
  NOTIFY,
  RPC_METHOD_NOT_FOUND,
  SERVER_REQUEST,
  type AgentMessageItem,
  type ApprovalDecisionResponse,
  type ClientInfo,
  type ErrorNotification,
  type InitializeParams,
  type InitializeResponse,
  type ItemNotification,
  type LegacyReviewDecisionResponse,
  type PermissionsApprovalResponse,
  type RpcRequest,
  type ThreadOpenResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadTokenUsageUpdatedNotification,
  type TurnNotification,
  type Turn,
  type TurnInterruptParams,
  type TurnInterruptResponse,
  type TurnStartParams,
  type TurnStartResponse,
  type UserMessageItem,
} from './codex-protocol.ts';
import { JsonRpcClient, RpcClosedError, RpcError, RpcTimeoutError } from './codex-rpc.ts';

export { CODEX_PROTOCOL_VERIFIED_VERSION } from './codex-protocol.ts';

/** Defaults. Handshake covers a cold first start (~8 s observed once). */
export const CODEX_HANDSHAKE_TIMEOUT_MS = 60_000;
export const CODEX_REQUEST_TIMEOUT_MS = 30_000;
/** After the leader exits, how long to wait for stdout to drain before emitting `exited`. */
export const CODEX_EXIT_DRAIN_MS = 2_000;
export const CODEX_DEFAULT_CLOSE_GRACE_MS = 2_000;
/** Bound on waiting for SIGKILLed group members to disappear before `exited`. */
const GROUP_GONE_WAIT_MS = 2_000;
/**
 * codex acks turn/start BEFORE the turn is active: a turn/interrupt sent between the ack and
 * the `turn/started` notification is answered "no active turn to interrupt" and dropped
 * (verified, 0.162.1). interrupt() therefore waits for `turn/started`, and retries a "no
 * active turn" answer while orc still considers the turn open.
 */
const INTERRUPT_RETRY_MS = 50;
const INTERRUPT_RETRIES = 40;

const DECLINE_REASON = 'orc runs codex unattended (approvalPolicy=never); approval declined';

// ---------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------

export type CodexStartFailure = 'no-rollout' | 'active-writer' | 'rpc' | 'timeout' | 'exited' | 'spawn' | 'config';

/** start() rejection. `reason` lets the kernel tell an unresumable thread from a crash. */
export class CodexStartError extends Error {
  readonly reason: CodexStartFailure;
  constructor(message: string, reason: CodexStartFailure, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CodexStartError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------
// Protocol core (transport-agnostic; unit-tested with captured lines)
// ---------------------------------------------------------------------------------

export interface CodexProtocolOptions {
  /** Write one protocol line to codex stdin (no trailing newline). May throw. */
  write: (line: string) => void;
  emit: (event: ProviderEvent) => void;
  /** Runtime notes worth keeping in the raw log (stray lines, auto-replies). */
  note?: (message: string) => void;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface EarlyNotification {
  method: string;
  params: unknown;
  turnId: string;
}

/** Cap on buffered early notifications per turn (deltas are not buffered). */
const EARLY_BUFFER_MAX = 1_000;

interface OpenTurn {
  messageId: string;
  /** Known once the turn/start response arrived. */
  turnId: string | null;
  startedEmitted: boolean;
  /** codex announced the turn (`turn/started`): only now does turn/interrupt take effect. */
  activeSeen: boolean;
  /**
   * Turn-scoped notifications that arrived while the turn/start response (which names our
   * turn id) was still in flight. Not observed with 0.162.1 (the response always came
   * first), but if it happens they are replayed in order right after `turn.started`, so a
   * fast turn/completed can never be dropped and leave the turn open forever.
   */
  early: EarlyNotification[];
  /** Resolves when the turn is active in codex, or ended / the connection closed. */
  active: Promise<void>;
  resolveActive: () => void;
  lastText?: string;
  finalAnswerText?: string;
  usage: Required<TurnUsage>;
  sawUsage: boolean;
  lastError?: string;
  interrupting?: Promise<void>;
}

export class CodexProtocol {
  readonly rpc: JsonRpcClient;
  private readonly emit: (event: ProviderEvent) => void;
  private readonly note: (message: string) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private threadIdValue: string | null = null;
  private turn: OpenTurn | null = null;
  private closedReason: Error | null = null;

  constructor(opts: CodexProtocolOptions) {
    this.emit = opts.emit;
    this.note = opts.note ?? (() => {});
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? CODEX_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;
    this.rpc = new JsonRpcClient({
      write: opts.write,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (req) => this.onServerRequest(req),
      onStray: (line, why) => this.note(`stray line (${why}): ${line.slice(0, 200)}`),
    });
  }

  get threadId(): string | null {
    return this.threadIdValue;
  }

  /** messageId of the open turn, if any. */
  get openTurnMessageId(): string | null {
    return this.turn?.messageId ?? null;
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  handleLine(line: string): void {
    this.rpc.handleLine(line);
  }

  /**
   * The transport is gone (process exited / stdout EOF). Pending requests reject; an open
   * turn is dropped WITHOUT an outcome event (the kernel synthesizes provider-exit).
   */
  connectionClosed(reason: Error): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    const t = this.turn;
    this.turn = null;
    t?.resolveActive();
    this.rpc.close(reason);
  }

  async initialize(clientInfo: ClientInfo): Promise<InitializeResponse> {
    const params: InitializeParams = { clientInfo };
    const res = await this.rpc.request<InitializeResponse>('initialize', params, {
      timeoutMs: this.handshakeTimeoutMs,
    });
    this.rpc.notify('initialized');
    return res;
  }

  async startThread(params: ThreadStartParams): Promise<ThreadOpenResponse> {
    const res = await this.rpc.request<ThreadOpenResponse>('thread/start', params, {
      timeoutMs: this.handshakeTimeoutMs,
    });
    this.adoptThread(res);
    return res;
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadOpenResponse> {
    const res = await this.rpc.request<ThreadOpenResponse>('thread/resume', params, {
      timeoutMs: this.handshakeTimeoutMs,
    });
    this.adoptThread(res);
    return res;
  }

  /**
   * Start a turn. Rejects only on precondition failures (closed, no thread, a turn already
   * open). Once `turn/start` is written the result flows through events: the response →
   * `turn.started`; an error response or timeout → `turn.failed`. Resolves after that.
   */
  send(messageId: string, text: string): Promise<void> {
    if (this.closedReason) {
      return Promise.reject(new Error(`codex runtime: provider connection closed (${this.closedReason.message})`));
    }
    const threadId = this.threadIdValue;
    if (!threadId) return Promise.reject(new Error('codex runtime: no thread is open yet'));
    if (this.turn) {
      return Promise.reject(
        new Error(`codex runtime: a turn is already open (messageId ${this.turn.messageId}); send() refused`),
      );
    }
    let resolveActive!: () => void;
    const active = new Promise<void>((r) => (resolveActive = r));
    const turn: OpenTurn = {
      messageId,
      turnId: null,
      startedEmitted: false,
      activeSeen: false,
      early: [],
      active,
      resolveActive,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sawUsage: false,
    };
    this.turn = turn;
    const params: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: messageId,
    };
    return new Promise<void>((resolve) => {
      this.rpc
        .request<TurnStartResponse>('turn/start', params, {
          timeoutMs: this.requestTimeoutMs,
          onSettled: (o) => {
            try {
              if (this.turn !== turn) return; // connection closed meanwhile
              if (o.ok) {
                this.markStarted(turn, o.result.turn.id);
                return;
              }
              if (o.error instanceof RpcClosedError) return; // `exited` follows
              this.turn = null;
              turn.resolveActive();
              // A timed-out turn/start may still have started a turn in codex (its turn/started
              // was buffered): interrupt it so nothing keeps running behind the kernel's back.
              for (const id of new Set(turn.early.filter((e) => e.method === NOTIFY.turnStarted).map((e) => e.turnId))) {
                this.interruptOrphan(id);
              }
              this.emit({ type: 'turn.failed', messageId, error: `codex turn/start failed: ${o.error.message}` });
            } finally {
              resolve();
            }
          },
        })
        .catch(() => {
          /* settled via onSettled */
        });
    });
  }

  /**
   * Interrupt the open turn: `turn/interrupt {threadId, turnId}` once codex announced the
   * turn (`turn/started`); its response emits `interrupt.acked` and codex then completes the
   * turn with status "interrupted". No-op when no turn is open. Concurrent calls share one
   * request. Never hangs: the wait for `turn/started` and each request are bounded. Rejects
   * on a request timeout, or when codex keeps denying an active turn orc still has open.
   */
  interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || this.closedReason) return Promise.resolve();
    if (turn.interrupting) return turn.interrupting;
    const p = (async () => {
      if (!turn.activeSeen) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([turn.active, new Promise<void>((r) => (timer = setTimeout(r, this.requestTimeoutMs)))]);
        clearTimeout(timer);
      }
      for (let attempt = 0; ; attempt++) {
        if (this.turn !== turn || !turn.turnId || !this.threadIdValue) return; // ended meanwhile
        const params: TurnInterruptParams = { threadId: this.threadIdValue, turnId: turn.turnId };
        try {
          await this.rpc.request<TurnInterruptResponse>(
            'turn/interrupt',
            params,
            {
              timeoutMs: this.requestTimeoutMs,
              onSettled: (o) => {
                if (o.ok) this.emit({ type: 'interrupt.acked' });
              },
            },
          );
          return;
        } catch (e) {
          if (e instanceof RpcClosedError) return; // provider gone: `exited` follows
          if (e instanceof RpcError) {
            if (this.turn !== turn) return; // benign race: the turn ended first
            if (/no active turn/i.test(e.message) && attempt < INTERRUPT_RETRIES) {
              await Bun.sleep(INTERRUPT_RETRY_MS);
              continue;
            }
          }
          throw e;
        }
      }
    })();
    turn.interrupting = p;
    p.catch(() => {
      if (turn.interrupting === p) turn.interrupting = undefined; // allow a retry
    });
    return p;
  }

  // -------------------------------------------------------------------------------

  private adoptThread(res: ThreadOpenResponse): void {
    if (!res?.thread?.id) throw new Error('codex: thread response carried no thread.id');
    this.threadIdValue = res.thread.id;
  }

  private markStarted(turn: OpenTurn, turnId: string): void {
    if (!turn.turnId) turn.turnId = turnId;
    if (!turn.startedEmitted) {
      turn.startedEmitted = true;
      this.emit({ type: 'turn.started', messageId: turn.messageId });
    }
    // Replay what arrived before we knew our turn id (in arrival order, so an early
    // turn/completed lands last and closes the turn exactly once).
    const early = turn.early.splice(0);
    for (const e of early) {
      if (e.turnId === turn.turnId) {
        if (this.turn === turn) this.onNotification(e.method, e.params);
      } else if (e.method === NOTIFY.turnStarted) {
        this.interruptOrphan(e.turnId);
      }
    }
  }

  /**
   * Buffer a turn-scoped notification while the open turn's id is still unknown (the
   * turn/start response is in flight). Returns true when buffered.
   */
  private bufferIfEarly(method: string, params: unknown, turnId: unknown): boolean {
    const t = this.turn;
    if (!t || t.turnId !== null || typeof turnId !== 'string' || turnId.length === 0) return false;
    if (t.early.length < EARLY_BUFFER_MAX) t.early.push({ method, params, turnId });
    return true;
  }

  /** Best-effort interrupt of a codex turn orc does not own. */
  private interruptOrphan(turnId: string): void {
    const threadId = this.threadIdValue;
    if (!threadId || this.closedReason) return;
    this.note(`interrupting orphan codex turn ${turnId}`);
    const params: TurnInterruptParams = { threadId, turnId };
    this.rpc.request<TurnInterruptResponse>('turn/interrupt', params, { timeoutMs: this.requestTimeoutMs }).catch(() => {});
  }

  /** Emit the single outcome for `t` from codex's final turn object and close it. */
  private finishTurn(t: OpenTurn, turn: Turn): void {
    this.turn = null;
    t.resolveActive();
    if (turn.status === 'completed') {
      const result = t.finalAnswerText ?? t.lastText ?? lastAgentText(turn.items);
      const ev: ProviderEvent = { type: 'turn.completed', messageId: t.messageId };
      if (result !== undefined) ev.result = result;
      if (t.sawUsage) ev.usage = { ...t.usage };
      this.emit(ev);
    } else if (turn.status === 'failed') {
      const error = turn.error?.message ?? t.lastError ?? 'codex turn failed';
      this.emit({ type: 'turn.failed', messageId: t.messageId, error });
    } else {
      this.emit({ type: 'turn.interrupted', messageId: t.messageId });
    }
  }

  private markActive(turn: OpenTurn): void {
    turn.activeSeen = true;
    turn.resolveActive();
  }

  private currentTurnFor(turnId: unknown): OpenTurn | null {
    const t = this.turn;
    return t && t.turnId !== null && t.turnId === turnId ? t : null;
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case NOTIFY.turnStarted: {
        const n = p as unknown as TurnNotification;
        const id = n.turn?.id;
        if (!id || (this.threadIdValue && n.threadId !== this.threadIdValue)) return;
        const t = this.turn;
        if (t && t.turnId === id) {
          this.markActive(t);
          return;
        }
        if (this.bufferIfEarly(method, params, id)) return; // ours if the in-flight ack names it
        // A turn orc does not own (e.g. a turn/start whose response timed out) must not
        // keep running behind the kernel's back.
        this.interruptOrphan(id);
        return;
      }
      case NOTIFY.itemStarted:
      case NOTIFY.itemCompleted: {
        const n = p as unknown as ItemNotification;
        const item = n.item;
        if (!item) return;
        if (item.type === 'userMessage') {
          // clientId echoes our messageId: the turn is active (the item follows turn/started);
          // also adopt the turn id should the ack ever arrive late.
          const t = this.turn;
          const um = item as UserMessageItem;
          if (!t || um.clientId !== t.messageId || !n.turnId) return;
          if (t.turnId === null) this.markStarted(t, n.turnId);
          if (t.turnId === n.turnId) this.markActive(t);
          return;
        }
        if (method !== NOTIFY.itemCompleted || item.type !== 'agentMessage') return;
        if (this.bufferIfEarly(method, params, n.turnId)) return;
        const t = this.currentTurnFor(n.turnId);
        if (!t) return;
        const am = item as AgentMessageItem;
        if (typeof am.text !== 'string' || am.text.length === 0) return;
        t.lastText = am.text;
        if (am.phase === 'final_answer') t.finalAnswerText = am.text;
        this.emit({ type: 'assistant.text', messageId: t.messageId, text: am.text });
        return;
      }
      case NOTIFY.tokenUsageUpdated: {
        const n = p as unknown as ThreadTokenUsageUpdatedNotification;
        if (this.bufferIfEarly(method, params, n.turnId)) return;
        const t = this.currentTurnFor(n.turnId);
        const last = n.tokenUsage?.last;
        if (!t || !last) return;
        // Summed `last` (one update per model call). NOTE: unlike claude, codex/OpenAI
        // `inputTokens` INCLUDES the cached input tokens (`cachedInputTokens` is a subset of
        // it, reported again here as cacheReadTokens); do not add the two together.
        t.sawUsage = true;
        t.usage.inputTokens += num(last.inputTokens);
        t.usage.outputTokens += num(last.outputTokens);
        t.usage.cacheReadTokens += num(last.cachedInputTokens);
        t.usage.cacheWriteTokens += num(last.cacheWriteInputTokens);
        return;
      }
      case NOTIFY.error: {
        const n = p as unknown as ErrorNotification;
        if (this.bufferIfEarly(method, params, n.turnId)) return;
        const t = this.currentTurnFor(n.turnId);
        if (t && !n.willRetry && typeof n.error?.message === 'string') t.lastError = n.error.message;
        return;
      }
      case NOTIFY.turnCompleted: {
        const n = p as unknown as TurnNotification;
        const turn = n.turn;
        if (!turn) return;
        if (this.bufferIfEarly(method, params, turn.id)) return;
        const t = this.currentTurnFor(turn.id);
        if (!t || turn.status === 'inProgress') return;
        this.finishTurn(t, turn);
        return;
      }
      default:
        return; // warning, configWarning, thread/status/changed, deltas, … → raw log only
    }
  }

  private onServerRequest(req: RpcRequest): void {
    const messageId = this.turn?.messageId;
    const permission = (): void => {
      const ev: ProviderEvent = { type: 'permission.requested', detail: { method: req.method, params: req.params } };
      if (messageId !== undefined) ev.messageId = messageId;
      this.emit(ev);
    };
    switch (req.method) {
      case SERVER_REQUEST.commandApproval:
      case SERVER_REQUEST.fileChangeApproval:
        permission();
        this.rpc.respond(req.id, { decision: 'decline' } satisfies ApprovalDecisionResponse);
        return;
      case SERVER_REQUEST.permissionsApproval:
        permission();
        this.rpc.respond(req.id, { permissions: {}, scope: 'turn' } satisfies PermissionsApprovalResponse);
        return;
      case SERVER_REQUEST.legacyApplyPatchApproval:
      case SERVER_REQUEST.legacyExecCommandApproval:
        permission();
        this.rpc.respond(req.id, {
          decision: { denied: { rejection: DECLINE_REASON } },
        } satisfies LegacyReviewDecisionResponse);
        return;
      case SERVER_REQUEST.toolUserInput:
        permission();
        this.rpc.respond(req.id, { answers: {} });
        return;
      case SERVER_REQUEST.mcpElicitation:
        permission();
        this.rpc.respond(req.id, { action: 'decline', content: null, _meta: null });
        return;
      case SERVER_REQUEST.dynamicToolCall:
        this.rpc.respond(req.id, { contentItems: [], success: false });
        return;
      default:
        this.note(`unhandled server request ${req.method} (id ${String(req.id)}) → -32601`);
        this.rpc.respondError(req.id, RPC_METHOD_NOT_FOUND, `orc does not handle server request '${req.method}'`);
    }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function lastAgentText(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  let text: string | undefined;
  for (const it of items as AgentMessageItem[]) {
    if (it?.type === 'agentMessage' && typeof it.text === 'string' && it.text.length > 0) text = it.text;
  }
  return text;
}

// ---------------------------------------------------------------------------------
// Event queue: buffers everything until the single consumer iterates; ends after `exited`.
// ---------------------------------------------------------------------------------

class EventQueue {
  private readonly items: ProviderEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private consumed = false;

  push(ev: ProviderEvent): void {
    if (this.ended) return;
    this.items.push(ev);
    if (ev.type === 'exited') this.ended = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  iterable(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('codex runtime: events() is single-consumer');
    this.consumed = true;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const ev = self.items.shift();
          if (ev) {
            yield ev;
            if (ev.type === 'exited') return;
            continue;
          }
          await new Promise<void>((r) => (self.wake = r));
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------------
// Process runtime
// ---------------------------------------------------------------------------------

export interface CodexRuntimeOptions {
  /** codex executable. Default: launch.env.ORC_CODEX_BIN ?? process.env.ORC_CODEX_BIN ?? 'codex'. */
  bin?: string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  exitDrainMs?: number;
}

type CodexProc = Bun.Subprocess<'pipe', 'pipe', number>;

/** Absolute path of the provider stderr log for a raw log path. */
export function codexStderrLogPath(rawLogPath: string): string {
  return path.join(path.dirname(rawLogPath), 'provider.stderr.log');
}

class CodexProcessRuntime implements ProviderRuntime {
  readonly provider = 'codex' as const;
  readonly pid: number;
  readonly proto: CodexProtocol;
  private readonly queue = new EventQueue();
  private readonly identity: ProcessIdentity;
  private rawFd: number | null;
  private stdinClosed = false;
  private closing: Promise<void> | null = null;
  private readonly exitedEmitted: Promise<void>;

  constructor(
    private readonly proc: CodexProc,
    rawFd: number | null,
    opts: Required<Pick<CodexRuntimeOptions, 'handshakeTimeoutMs' | 'requestTimeoutMs' | 'exitDrainMs'>>,
  ) {
    this.pid = proc.pid;
    this.identity = { pid: proc.pid, startTime: processStartTime(proc.pid) };
    this.rawFd = rawFd;
    this.proto = new CodexProtocol({
      write: (line) => this.writeLine(line),
      emit: (ev) => this.queue.push(ev),
      note: (msg) => this.raw('info', msg),
      handshakeTimeoutMs: opts.handshakeTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
    const stdoutDone = this.readStdout();
    this.exitedEmitted = proc.exited.then(async () => {
      // codex leaves helpers in its group (e.g. `git ls-remote …/openai/plugins.git` at
      // startup) that outlive the app-server; the group is the provider's, so reap it all,
      // and only report `exited` once nothing in it can still hold the thread's writer lock.
      sweepGroup(this.pid);
      await Promise.all([
        Promise.race([stdoutDone, Bun.sleep(opts.exitDrainMs)]),
        waitGroupGone(this.pid, GROUP_GONE_WAIT_MS),
      ]);
      const code = proc.exitCode;
      const signal = proc.signalCode ?? null;
      this.proto.connectionClosed(
        new RpcClosedError(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`),
      );
      this.queue.push({ type: 'exited', code, signal });
      this.closeRaw();
    });
  }

  emit(ev: ProviderEvent): void {
    this.queue.push(ev);
  }

  events(): AsyncIterable<ProviderEvent> {
    return this.queue.iterable();
  }

  send(messageId: string, text: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('codex runtime: closing; send() refused'));
    return this.proto.send(messageId, text);
  }

  interrupt(): Promise<void> {
    return this.proto.interrupt();
  }

  /** End stdin, wait graceMs for exit, then terminate the process group; resolves after `exited`. */
  close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closing) return this.closing;
    const graceMs = opts.graceMs ?? CODEX_DEFAULT_CLOSE_GRACE_MS;
    this.closing = (async () => {
      this.endStdin();
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(graceMs).then(() => false),
      ]);
      if (!exited) await terminateProcessGroup(this.identity, graceMs);
      // The leader can be gone while group members linger: sweep the group.
      sweepGroup(this.pid);
      await this.exitedEmitted;
    })();
    return this.closing;
  }

  private endStdin(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    try {
      const r = this.proc.stdin.end();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* already closed */
    }
  }

  private writeLine(line: string): void {
    if (this.stdinClosed) throw new Error('stdin closed');
    this.raw('send', line);
    this.proc.stdin.write(`${line}\n`);
    const r = this.proc.stdin.flush();
    if (r instanceof Promise) r.catch(() => {});
  }

  private async readStdout(): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    const onLine = (line: string): void => {
      if (line.trim().length === 0) return;
      this.raw('recv', line);
      try {
        this.proto.handleLine(line);
      } catch {
        /* never let a mapping bug kill the reader */
      }
    };
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      buf += dec.decode();
    } catch {
      /* stream error → EOF */
    }
    if (buf.length > 0) onLine(buf);
  }

  private raw(dir: 'send' | 'recv' | 'info', line: string): void {
    if (this.rawFd === null) return;
    try {
      fs.writeSync(this.rawFd, `${JSON.stringify({ ts: new Date().toISOString(), dir, line })}\n`);
    } catch {
      /* debug stream only */
    }
  }

  private closeRaw(): void {
    if (this.rawFd === null) return;
    try {
      fs.closeSync(this.rawFd);
    } catch {
      /* ignore */
    }
    this.rawFd = null;
  }
}

/** SIGKILL whatever is left in process group `pgid` (missing group is fine). */
function sweepGroup(pgid: number): void {
  try {
    signalProcessGroup(pgid, 'SIGKILL');
  } catch {
    /* EPERM etc.: nothing we can do */
  }
}

/** Poll interval while waiting for SIGKILLed group members to disappear. */
const GROUP_POLL_MS = 50;

/**
 * Live (non-zombie) members of process group `pgid`; null when unknown. A zombie only
 * waits for its parent/init to reap it and holds no locks or files. Fast path: ESRCH from
 * kill(-pgid, 0) means the group is empty. Linux reads /proc/<pid>/stat (no subprocess);
 * elsewhere (macOS) one `ps` call.
 */
function liveGroupMemberCount(pgid: number): number | null {
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    if ((e as { code?: string }).code === 'ESRCH') return 0;
  }
  return procGroupMemberCount(pgid) ?? psGroupMemberCount(pgid);
}

function procGroupMemberCount(pgid: number): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null; // no procfs
  }
  const want = String(pgid);
  let n = 0;
  let readAny = false;
  for (const e of entries) {
    if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue; // not a pid dir
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
    } catch {
      continue; // exited meanwhile
    }
    readAny = true;
    // comm (field 2) may contain spaces/parens: parse after the LAST ')'.
    // rest[0] = state (field 3), rest[2] = pgrp (field 5).
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (rest[2] === want && rest[0] !== 'Z' && rest[0] !== 'X') n++;
  }
  return readAny ? n : null;
}

function psGroupMemberCount(pgid: number): number | null {
  try {
    const r = Bun.spawnSync(['ps', '-A', '-o', 'pgid=,stat='], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, LC_ALL: 'C' } as Record<string, string>,
    });
    if (r.exitCode !== 0) return null;
    let n = 0;
    for (const line of r.stdout.toString().split('\n')) {
      const [g, stat] = line.trim().split(/\s+/);
      if (g === String(pgid) && stat && !stat.startsWith('Z')) n++;
    }
    return n;
  } catch {
    return null;
  }
}

/** Wait (bounded) until SIGKILLed group members are actually gone. */
async function waitGroupGone(pgid: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const n = liveGroupMemberCount(pgid);
    if (n === null || n === 0 || Date.now() >= end) return;
    await Bun.sleep(GROUP_POLL_MS);
  }
}

function readSystemPrompt(spec: SpawnSpec): { mode: 'append' | 'replace'; text: string } | null {
  if (!spec.systemPrompt) return null;
  let text: string;
  try {
    text = fs.readFileSync(spec.systemPrompt.path, 'utf8');
  } catch (e) {
    throw new CodexStartError(
      `codex runtime: cannot read system prompt file ${spec.systemPrompt.path}: ${(e as Error).message}`,
      'config',
      e,
    );
  }
  if (text.trim().length === 0) return null;
  return { mode: spec.systemPrompt.mode, text };
}

/** Map a startup failure to a CodexStartError (exported for tests). */
export function mapCodexStartError(e: unknown, ctx: { resume: boolean; threadId?: string; stderrPath: string }): CodexStartError {
  if (e instanceof CodexStartError) return e;
  if (e instanceof RpcError) {
    if (ctx.resume && /no rollout found/i.test(e.message)) {
      return new CodexStartError(
        `codex: cannot resume thread ${ctx.threadId}: no rollout found — the thread never started a turn ` +
          '(codex persists a thread only once its first turn/start is issued)',
        'no-rollout',
        e,
      );
    }
    if (ctx.resume && /already has an active writer/i.test(e.message)) {
      return new CodexStartError(
        `codex: cannot resume thread ${ctx.threadId}: another codex app-server still holds it (active writer); ` +
          'kill the stale provider process group first',
        'active-writer',
        e,
      );
    }
    return new CodexStartError(`codex ${e.method} failed: ${e.message} (code ${e.code})`, 'rpc', e);
  }
  if (e instanceof RpcTimeoutError) {
    return new CodexStartError(`${e.message} during startup (stderr: ${ctx.stderrPath})`, 'timeout', e);
  }
  if (e instanceof RpcClosedError) {
    return new CodexStartError(`codex app-server exited during startup: ${e.message} (stderr: ${ctx.stderrPath})`, 'exited', e);
  }
  return new CodexStartError(`codex runtime start failed: ${(e as Error)?.message ?? String(e)}`, 'rpc', e);
}

export function createCodexRuntime(options: CodexRuntimeOptions = {}): ProviderRuntimeFactory {
  return {
    provider: 'codex',
    async start(launch: ProviderLaunch): Promise<ProviderRuntime> {
      const { spec } = launch;
      if (launch.resume && !spec.providerSessionId) {
        throw new CodexStartError('codex runtime: resume requires spec.providerSessionId (the codex thread id)', 'config');
      }
      const prompt = launch.resume ? null : readSystemPrompt(spec);
      const bin = options.bin ?? launch.env.ORC_CODEX_BIN ?? process.env.ORC_CODEX_BIN ?? 'codex';
      const stderrPath = codexStderrLogPath(launch.rawLogPath);

      fs.mkdirSync(path.dirname(launch.rawLogPath), { recursive: true });
      const rawFd = fs.openSync(launch.rawLogPath, 'a', 0o600);
      const errFd = fs.openSync(stderrPath, 'a', 0o600);
      let proc: CodexProc;
      try {
        proc = Bun.spawn([bin, 'app-server'], {
          cwd: spec.cwd,
          env: launch.env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: errFd,
          detached: true,
        });
      } catch (e) {
        fs.closeSync(rawFd);
        throw new CodexStartError(
          `codex runtime: cannot spawn '${bin} app-server' (set ORC_CODEX_BIN or put codex on PATH): ${(e as Error).message}`,
          'spawn',
          e,
        );
      } finally {
        fs.closeSync(errFd);
      }
      launch.onSpawn?.({ pid: proc.pid, startTime: processStartTime(proc.pid) });

      const rt = new CodexProcessRuntime(proc, rawFd, {
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? CODEX_HANDSHAKE_TIMEOUT_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS,
        exitDrainMs: options.exitDrainMs ?? CODEX_EXIT_DRAIN_MS,
      });
      try {
        const init = await rt.proto.initialize({ name: 'orc', title: 'orc', version: String(pkg.version) });
        let opened: ThreadOpenResponse;
        if (launch.resume) {
          const params: ThreadResumeParams = {
            threadId: spec.providerSessionId!,
            cwd: spec.cwd,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            excludeTurns: true,
          };
          if (spec.model) params.model = spec.model;
          opened = await rt.proto.resumeThread(params);
        } else {
          const params: ThreadStartParams = {
            cwd: spec.cwd,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
          };
          if (spec.model) params.model = spec.model;
          if (prompt?.mode === 'replace') params.baseInstructions = prompt.text;
          else if (prompt) params.developerInstructions = prompt.text;
          opened = await rt.proto.startThread(params);
        }
        const thread = opened.thread;
        const ready: ProviderEvent = {
          type: 'ready',
          providerSessionId: thread.id,
          info: {
            mode: launch.resume ? 'resume' : 'fresh',
            cliVersion: thread.cliVersion,
            userAgent: init.userAgent,
            codexHome: init.codexHome,
            platformOs: init.platformOs,
            model: opened.model,
            modelProvider: opened.modelProvider,
            reasoningEffort: opened.reasoningEffort ?? null,
            cwd: opened.cwd,
            approvalPolicy: opened.approvalPolicy,
            sandbox: opened.sandbox?.type ?? null,
          },
        };
        if (thread.path) ready.transcriptPath = thread.path;
        rt.emit(ready);
        return rt;
      } catch (e) {
        await rt.close({ graceMs: 1_000 }).catch(() => {});
        throw mapCodexStartError(e, { resume: launch.resume, threadId: spec.providerSessionId, stderrPath });
      }
    },
  };
}

/** The codex ProviderRuntimeFactory (provider 'codex'). */
export const codexRuntime: ProviderRuntimeFactory = createCodexRuntime();
