/**
 * claude provider runtime: `claude -p` over the stream-json stdio protocol (no PTY, no
 * tmux). Verified against Claude Code 2.1.299 and 2.1.300 (see ./claude-protocol.ts and the
 * contract test test/claude-runtime.live.test.ts). Never refuses other CLI versions.
 *
 * Process: spawned detached (own process group, pgid === pid) with stdin/stdout pipes and
 * stderr → `provider.stderr.log` next to `launch.rawLogPath`. Every protocol line, both
 * directions, is appended (tagged) to `launch.rawLogPath`.
 *
 * Lifecycle:
 *   start()  spawn → `control_request initialize` → `ready` from its control_response.
 *            Rejects (and kills the group) if claude exits / errors / times out first —
 *            e.g. `--resume` of a session with no completed turn.
 *   send()   one `user` line, `uuid` = orc messageId, content = the exact text (JSON-encoded).
 *   events   turn.started   ← command_lifecycle{started} (fallback: the isReplay echo)
 *            assistant.text ← main-thread assistant text blocks
 *            outcome        ← `result` ONLY: aborted_* → interrupted; success∧!is_error →
 *                             completed; else failed. An outstanding interrupt never
 *                             changes the outcome. An interrupt written right behind a send
 *                             races the CLI's dequeue: ack still_queued:[id] → the turn runs
 *                             and completes; still_queued:[] → it had started and is aborted
 *                             (verified live, 2.1.299 — either can happen in a warm process).
 *            interrupt.acked ← the interrupt's control_response
 *            exited          ← always last
 *   close()  end stdin (claude finishes the current turn, then exits), wait graceMs, then
 *            SIGTERM→SIGKILL the process group.
 *
 * The line→event mapping lives in the pure {@link ClaudeStreamMapper} (unit-tested over
 * captured CLI output); {@link ClaudeRuntime} only does I/O.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  parseClaudeLine,
  type ClaudeAssistant,
  type ClaudeCommandLifecycle,
  type ClaudeContentBlock,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
  type ClaudeInitializeResponse,
  type ClaudeInterruptResponse,
  type ClaudeResult,
  type ClaudeStdoutMessage,
  type ClaudeSystemInit,
  type ClaudeUserInput,
  type ClaudeUserOutput,
} from './claude-protocol.ts';

// ---------------------------------------------------------------------------------
// argv + env
// ---------------------------------------------------------------------------------

/**
 * argv for a fresh session or a resume. Never `--bare` (skills/agents must load), never
 * `--session-id` together with `--resume` (claude exits 1), system prompt only via file.
 */
export function buildClaudeArgv(spec: SpawnSpec, resume: boolean, bin = 'claude'): string[] {
  const argv = [
    bin,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'user,project,local',
  ];
  if (resume) argv.push('--resume', spec.providerSessionId ?? spec.sessionId);
  else argv.push('--session-id', spec.sessionId);
  if (spec.model) argv.push('--model', spec.model);
  if (spec.agentName) argv.push('--agent', spec.agentName);
  if (spec.systemPrompt) {
    argv.push(
      spec.systemPrompt.mode === 'replace' ? '--system-prompt-file' : '--append-system-prompt-file',
      spec.systemPrompt.path,
    );
  }
  return argv;
}

/**
 * Inherited `CLAUDE_CODE_*` variables that survive stripping: auth/backend selection
 * (Bedrock/Vertex, OAuth, API key, SKIP_*_AUTH), proxy + client cert, request limits and
 * timeouts, and the user's privacy opt-outs. Everything else under `CLAUDE_CODE_*` is
 * removed — a parent claude session's identity/output vars (ENTRYPOINT, SESSION_ID,
 * INCLUDE_PARTIAL_MESSAGES, REMOTE, …) and host feature toggles (DISABLE_BACKGROUND_TASKS,
 * DISABLE_WORKFLOWS, USE_CCR_V2, MAX_SUBAGENT_SPAWN_DEPTH, …) — so the child behaves like
 * a standalone CLI. Escape hatch: ORC_CLAUDE_KEEP_ENV.
 */
export const CLAUDE_ENV_KEEP_RE =
  /^CLAUDE_CODE_(USE_(BEDROCK|VERTEX)|OAUTH|API_KEY|SKIP_[A-Z_]*AUTH|MAX_OUTPUT_TOKENS|MAX_RETRIES|DISABLE_(NONESSENTIAL_TRAFFIC|TELEMETRY|AUTOUPDATER|ERROR_REPORTING)|EXTRA_|PROXY|CLIENT_CERT|[A-Z_]*TIMEOUT[A-Z_]*)/;

/**
 * Child env: `base` (the kernel's full env) minus stripped `CLAUDE_CODE_*` (except
 * {@link CLAUDE_ENV_KEEP_RE} and names listed comma-separated in `ORC_CLAUDE_KEEP_ENV`),
 * then `additions` (spec.env: ORC_* lineage…) applied on top. `CLAUDE_CODE_ENTRYPOINT`
 * is left unset. All `ANTHROPIC_*`, proxy and system variables pass through untouched.
 */
export function buildClaudeEnv(
  base: Record<string, string | undefined>,
  additions: Record<string, string> = {},
): Record<string, string> {
  const keep = new Set(
    (base.ORC_CLAUDE_KEEP_ENV ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE_CODE_') && !CLAUDE_ENV_KEEP_RE.test(k) && !keep.has(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(additions)) out[k] = v;
  return out;
}

/**
 * `~/.claude/projects/<any>/<sid>.jsonl` (honours CLAUDE_CONFIG_DIR). Globs instead of
 * recomputing claude's cwd slug. Absent for a fresh session until its first turn.
 */
export function resolveClaudeTranscript(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const root = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(env.HOME || os.homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------
// Pure mapper: raw stdout line → ProviderEvent(s)
// ---------------------------------------------------------------------------------

/** Summary of the first per-turn `system/init` (protocol capabilities live only there). */
export interface ClaudeInitInfo {
  capabilities: string[];
  skillsCount: number;
  agents: string[];
  apiKeySource?: string;
  model?: string;
  claudeCodeVersion?: string;
  permissionMode?: string;
}

export interface ClaudeMapResult {
  events: ProviderEvent[];
  /** Lines orc must write back to claude's stdin (e.g. a permission deny). */
  replies: Record<string, unknown>[];
  /** Annotations for the raw log (not protocol lines). */
  notes: Record<string, unknown>[];
  /** Fatal start failure (initialize rejected). */
  fatal?: string;
}

type ControlKind = 'initialize' | 'interrupt' | 'other';

export const CLAUDE_PERMISSION_DENY_MESSAGE =
  'orc: interactive permission prompts are not supported (yolo session); request denied';

/**
 * Stateful but I/O-free translation of claude stdout lines into {@link ProviderEvent}s.
 * The runtime tells it what it wrote ({@link beginTurn}, {@link noteControlRequest}); it
 * guarantees per turn: at most one `turn.started` (always before the outcome) and exactly
 * one outcome event.
 */
export class ClaudeStreamMapper {
  private open: { messageId: string; started: boolean } | undefined;
  private readonly pending = new Map<string, ControlKind>();
  private ready = false;
  private costBase: number | undefined;
  private _initInfo: ClaudeInitInfo | undefined;
  /** `errors[]` of results that arrived before `ready` (e.g. "No conversation found"). */
  readonly startupErrors: string[] = [];

  constructor(private readonly opts: { providerSessionId: string; resume: boolean }) {
    // Fresh process: the first result's cumulative total IS its cost. Resumed process:
    // the first total includes the transcript's saved spend → unknown base.
    this.costBase = opts.resume ? undefined : 0;
  }

  get openMessageId(): string | undefined {
    return this.open?.messageId;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get initInfo(): ClaudeInitInfo | undefined {
    return this._initInfo;
  }

  /** A user line for `messageId` is about to be written. Throws if a turn is open. */
  beginTurn(messageId: string): void {
    if (this.open) throw new Error(`claude runtime: a turn is already open (${this.open.messageId})`);
    this.open = { messageId, started: false };
  }

  /** Writing the user line failed: forget the turn (no outcome will follow). */
  abortTurn(messageId: string): void {
    if (this.open?.messageId === messageId) this.open = undefined;
  }

  noteControlRequest(requestId: string, subtype: string): void {
    this.pending.set(requestId, subtype === 'initialize' || subtype === 'interrupt' ? subtype : 'other');
  }

  handleLine(line: string): ClaudeMapResult {
    return this.handleMessage(parseClaudeLine(line));
  }

  handleMessage(msg: ClaudeStdoutMessage | null): ClaudeMapResult {
    const out: ClaudeMapResult = { events: [], replies: [], notes: [] };
    if (!msg) return out;
    switch (msg.type) {
      case 'control_response':
        this.onControlResponse(msg as ClaudeControlResponse, out);
        break;
      case 'command_lifecycle': {
        const m = msg as ClaudeCommandLifecycle;
        if (m.state === 'started' && this.open && m.command_uuid === this.open.messageId) this.markStarted(out);
        break;
      }
      case 'user': {
        const m = msg as ClaudeUserOutput;
        // Only OUR replayed line is an ack; live user lines (tool results, the interrupt
        // marker) never are.
        if (m.isReplay === true && this.open && m.uuid === this.open.messageId) this.markStarted(out);
        break;
      }
      case 'system':
        if ((msg as { subtype?: unknown }).subtype === 'init' && !this._initInfo) {
          this._initInfo = initInfoOf(msg as ClaudeSystemInit);
          out.notes.push({ initInfo: this._initInfo });
        }
        break;
      case 'assistant':
        this.onAssistant(msg as ClaudeAssistant, out);
        break;
      case 'result':
        this.onResult(msg as ClaudeResult, out);
        break;
      case 'control_request':
        this.onControlRequest(msg as ClaudeControlRequest, out);
        break;
      default:
        // stream_event, rate_limit_event, keep_alive, active_goal, autocompact_state,
        // control_cancel_request, future types: raw log only.
        break;
    }
    return out;
  }

  private markStarted(out: ClaudeMapResult): void {
    if (!this.open || this.open.started) return;
    this.open.started = true;
    out.events.push({ type: 'turn.started', messageId: this.open.messageId });
  }

  /** Does a line correlated by user_message_uuid(s) belong to the open turn? */
  private isForOpen(uuid: unknown, uuids: unknown): boolean {
    if (!this.open) return false;
    const id = this.open.messageId;
    if (Array.isArray(uuids) && uuids.length > 0) return uuids.includes(id);
    if (typeof uuid === 'string') return uuid === id;
    return true; // uncorrelated (no uuid sent) → the open turn
  }

  private onControlResponse(msg: ClaudeControlResponse, out: ClaudeMapResult): void {
    const r = msg.response;
    const id = r && typeof r.request_id === 'string' ? r.request_id : undefined;
    if (!id) return;
    const kind = this.pending.get(id);
    if (!kind) return; // not ours (e.g. the CLI echoing our permission answer)
    this.pending.delete(id);
    if (kind === 'initialize') {
      if (r.subtype !== 'success') {
        out.fatal = `claude initialize failed: ${String((r as { error?: unknown }).error ?? 'unknown error')}`;
        return;
      }
      if (this.ready) return;
      this.ready = true;
      const p = ((r as { response?: unknown }).response ?? {}) as ClaudeInitializeResponse;
      const info: Record<string, unknown> = {};
      if (typeof p.pid === 'number') info.pid = p.pid;
      if (typeof p.claude_code_version === 'string') info.claude_code_version = p.claude_code_version;
      if (typeof p.session_state === 'string') info.session_state = p.session_state;
      if (typeof p.current_permission_mode === 'string') info.current_permission_mode = p.current_permission_mode;
      out.events.push({
        type: 'ready',
        providerSessionId: this.opts.providerSessionId,
        capabilities: Array.isArray(p.capabilities) ? p.capabilities.filter((c) => typeof c === 'string') : [],
        info,
      });
    } else if (kind === 'interrupt') {
      if (r.subtype === 'success') {
        const p = ((r as { response?: unknown }).response ?? {}) as ClaudeInterruptResponse;
        out.notes.push({ interruptAck: { request_id: id, still_queued: p.still_queued ?? [] } });
        out.events.push({ type: 'interrupt.acked' });
      } else {
        out.notes.push({ interruptError: { request_id: id, error: (r as { error?: unknown }).error } });
      }
    }
  }

  private onAssistant(msg: ClaudeAssistant, out: ClaudeMapResult): void {
    if (msg.parent_tool_use_id != null) return; // subagent line
    if (!this.open || !this.isForOpen(msg.user_message_uuid, msg.user_message_uuids)) return;
    const blocks: ClaudeContentBlock[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (text.length === 0) return; // thinking / tool_use only
    this.markStarted(out);
    out.events.push({ type: 'assistant.text', messageId: this.open.messageId, text });
  }

  private onResult(msg: ClaudeResult, out: ClaudeMapResult): void {
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e) => typeof e === 'string') : [];
    if (!this.open || !this.isForOpen(msg.user_message_uuid, msg.user_message_uuids)) {
      // Deliberately does NOT advance the cost base: a foreign/stray result's spend is
      // still inside the cumulative total, so it lands in the next own turn's delta.
      if (!this.ready && !this.open) this.startupErrors.push(...errors);
      out.notes.push({ ignoredResult: { user_message_uuid: msg.user_message_uuid ?? null, subtype: msg.subtype } });
      return;
    }
    const messageId = this.open.messageId;
    let costUsd: number | undefined;
    if (typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd)) {
      if (this.costBase !== undefined) {
        const d = msg.total_cost_usd - this.costBase;
        costUsd = d >= 0 ? d : undefined;
      }
      this.costBase = msg.total_cost_usd;
    }
    // A result for our uuid proves delivery even if no ack line was seen.
    this.markStarted(out);
    this.open = undefined;

    const terminal = typeof msg.terminal_reason === 'string' ? msg.terminal_reason : undefined;
    if (terminal?.startsWith('aborted')) {
      out.events.push({ type: 'turn.interrupted', messageId });
    } else if (msg.subtype === 'success' && msg.is_error !== true) {
      const usage = usageOf(msg);
      out.events.push({
        type: 'turn.completed',
        messageId,
        ...(typeof msg.result === 'string' ? { result: msg.result } : {}),
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    } else {
      const error =
        errors.join('; ') ||
        (typeof msg.result === 'string' && msg.result) ||
        terminal ||
        (typeof msg.subtype === 'string' ? msg.subtype : '') ||
        'claude turn failed';
      out.events.push({ type: 'turn.failed', messageId, error });
    }
  }

  private onControlRequest(msg: ClaudeControlRequest, out: ClaudeMapResult): void {
    const id = typeof msg.request_id === 'string' ? msg.request_id : undefined;
    if (!id) return;
    const subtype = msg.request && typeof msg.request.subtype === 'string' ? msg.request.subtype : 'unknown';
    if (subtype === 'can_use_tool') {
      // Should not happen in bypassPermissions; if it does, surface it and deny so the
      // turn can end instead of hanging.
      out.events.push({
        type: 'permission.requested',
        ...(this.open ? { messageId: this.open.messageId } : {}),
        detail: msg.request,
      });
      out.replies.push({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: { behavior: 'deny', message: CLAUDE_PERMISSION_DENY_MESSAGE, interrupt: false },
        },
      });
      return;
    }
    out.replies.push({
      type: 'control_response',
      response: { subtype: 'error', request_id: id, error: `orc: unsupported control request '${subtype}'` },
    });
  }
}

function initInfoOf(m: ClaudeSystemInit): ClaudeInitInfo {
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    capabilities: strs(m.capabilities),
    skillsCount: Array.isArray(m.skills) ? m.skills.length : 0,
    agents: strs(m.agents),
    ...(typeof m.apiKeySource === 'string' ? { apiKeySource: m.apiKeySource } : {}),
    ...(typeof m.model === 'string' ? { model: m.model } : {}),
    ...(typeof m.claude_code_version === 'string' ? { claudeCodeVersion: m.claude_code_version } : {}),
    ...(typeof m.permissionMode === 'string' ? { permissionMode: m.permissionMode } : {}),
  };
}

function usageOf(msg: ClaudeResult): TurnUsage | undefined {
  const u = msg.usage;
  if (!u || typeof u !== 'object') return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const usage: TurnUsage = {};
  const i = num(u.input_tokens);
  const o = num(u.output_tokens);
  const cr = num(u.cache_read_input_tokens);
  const cw = num(u.cache_creation_input_tokens);
  if (i !== undefined) usage.inputTokens = i;
  if (o !== undefined) usage.outputTokens = o;
  if (cr !== undefined) usage.cacheReadTokens = cr;
  if (cw !== undefined) usage.cacheWriteTokens = cw;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The initialize response carries `account` (may hold email/org): never persist it. */
export function redactClaudeLine(line: string, msg: ClaudeStdoutMessage | null): string {
  if (!msg || msg.type !== 'control_response' || !line.includes('"account"')) return line;
  const payload = (msg as ClaudeControlResponse).response?.response;
  if (!payload || typeof payload !== 'object' || !('account' in payload)) return line;
  const copy = structuredClone(msg) as ClaudeControlResponse;
  (copy.response.response as Record<string, unknown>).account = '<redacted>';
  return JSON.stringify(copy);
}

// ---------------------------------------------------------------------------------
// Runtime: process + I/O
// ---------------------------------------------------------------------------------

export interface ClaudeRuntimeOptions {
  /** claude executable (name or path). Default: env ORC_CLAUDE_BIN ?? 'claude'. */
  bin?: string;
  /** Max wait for the initialize response. Default: ORC_CLAUDE_READY_TIMEOUT_MS ?? 60 s. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
/** After the leader exits, how long to let stdout drain before giving up on it. */
const DRAIN_AFTER_EXIT_MS = 2_000;

type ClaudeProc = Bun.Subprocess<'pipe', 'pipe', number>;

export class ClaudeRuntime implements ProviderRuntime {
  readonly provider = 'claude' as const;
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly providerSessionId: string;
  readonly argv: readonly string[];
  readonly stderrPath: string;

  private readonly mapper: ClaudeStreamMapper;
  private readonly queue: ProviderEvent[] = [];
  private wake: (() => void) | undefined;
  private consumed = false;
  private ended = false;
  private exited = false;
  private rawFd: number | null;
  private reader: { cancel(): Promise<void> } | undefined;
  private readonly pumpDone: Promise<void>;
  /** Resolves after `exited` was queued. */
  readonly done: Promise<void>;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private closing: Promise<void> | undefined;
  private readonly readyPromise: Promise<void>;
  private reqSeq = 0;

  constructor(
    private readonly proc: ClaudeProc,
    private readonly launch: ProviderLaunch,
    argv: string[],
    private readonly childEnv: Record<string, string>,
  ) {
    this.pid = proc.pid;
    this.identity = { pid: proc.pid, startTime: processStartTime(proc.pid) };
    this.argv = argv;
    this.providerSessionId = launch.resume
      ? (launch.spec.providerSessionId ?? launch.spec.sessionId)
      : launch.spec.sessionId;
    this.stderrPath = stderrPathFor(launch.rawLogPath);
    this.mapper = new ClaudeStreamMapper({ providerSessionId: this.providerSessionId, resume: launch.resume });
    try {
      this.rawFd = fs.openSync(launch.rawLogPath, 'a', 0o600);
    } catch {
      this.rawFd = null;
    }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    this.readyPromise.catch(() => {}); // observed via awaitReady()
    this.rawInfo({ spawn: { argv, cwd: launch.spec.cwd, resume: launch.resume, pid: proc.pid } });
    this.pumpDone = this.pump();
    this.done = this.watchExit();
  }

  /** Summary of the first per-turn `system/init` (capabilities, skills, agents…). */
  get initInfo(): ClaudeInitInfo | undefined {
    return this.mapper.initInfo;
  }

  get openMessageId(): string | undefined {
    return this.mapper.openMessageId;
  }

  events(): AsyncIterable<ProviderEvent> {
    if (this.consumed) throw new Error('claude runtime: events() is single-consumer');
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<ProviderEvent> {
    for (;;) {
      while (this.queue.length > 0) {
        const ev = this.queue.shift() as ProviderEvent;
        yield ev;
        if (ev.type === 'exited') return;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }

  private push(ev: ProviderEvent): void {
    if (this.ended) return;
    if (ev.type === 'exited') this.ended = true;
    this.queue.push(ev);
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  async send(messageId: string, text: string): Promise<void> {
    if (this.exited) throw new Error('claude runtime: provider process has exited');
    if (this.closing) throw new Error('claude runtime: closing');
    this.mapper.beginTurn(messageId); // throws when a turn is open
    const line: ClaudeUserInput = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.providerSessionId,
      uuid: messageId,
    };
    try {
      await this.writeLine(line as unknown as Record<string, unknown>);
    } catch (e) {
      this.mapper.abortTurn(messageId);
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    // Idle, closing or closed → no-op (nothing written, nothing raw-logged).
    if (!this.mapper.openMessageId || this.exited || this.closing) return;
    await this.control('interrupt');
  }

  close(opts: { graceMs?: number } = {}): Promise<void> {
    this.closing ??= this.doClose(opts.graceMs ?? DEFAULT_CLOSE_GRACE_MS);
    return this.closing;
  }

  private async doClose(graceMs: number): Promise<void> {
    if (!this.exited) {
      try {
        this.rawInfo({ close: { graceMs } });
        await this.proc.stdin.end();
      } catch {
        /* already closed */
      }
    }
    if (!(await settlesWithin(this.proc.exited, graceMs))) {
      await terminateProcessGroup(this.identity, 1_000);
    }
    await this.done;
  }

  /** Wait for `ready` (or fail). On failure the process group is killed. */
  async awaitReady(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => {
      this.readyWaiter?.reject(new Error(`claude runtime: no initialize response within ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await this.readyPromise;
    } catch (e) {
      await terminateProcessGroup(this.identity, 1_000).catch(() => false);
      await settlesWithin(this.done, 5_000);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async control(subtype: 'initialize' | 'interrupt'): Promise<void> {
    const request_id = `orc-${subtype}-${++this.reqSeq}-${randomUUID().slice(0, 8)}`;
    this.mapper.noteControlRequest(request_id, subtype);
    await this.writeLine({ type: 'control_request', request_id, request: { subtype } });
  }

  /** @internal called once by the factory right after spawn. */
  async initialize(): Promise<void> {
    await this.control('initialize');
  }

  private async writeLine(obj: Record<string, unknown>): Promise<void> {
    if (this.exited) throw new Error('claude runtime: provider process has exited');
    const line = JSON.stringify(obj);
    this.raw('send', line);
    this.proc.stdin.write(`${line}\n`);
    await this.proc.stdin.flush();
  }

  private async pump(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    this.reader = reader;
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          this.onLine(line);
        }
      }
      buf += dec.decode();
      if (buf.trim().length > 0) this.onLine(buf);
    } catch {
      /* stream error or cancelled after exit → EOF */
    }
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return;
    const msg = parseClaudeLine(line);
    this.raw('recv', redactClaudeLine(line, msg));
    let res: ClaudeMapResult;
    try {
      res = this.mapper.handleMessage(msg);
    } catch (e) {
      this.rawInfo({ mapperError: String(e) });
      return;
    }
    for (const note of res.notes) this.rawInfo(note);
    for (const reply of res.replies) {
      this.writeLine(reply).catch((e) => this.rawInfo({ replyError: String(e) }));
    }
    for (const ev of res.events) {
      if (ev.type === 'ready') {
        const transcriptPath = resolveClaudeTranscript(this.providerSessionId, this.childEnv);
        this.push(transcriptPath ? { ...ev, transcriptPath } : ev);
        this.readyWaiter?.resolve();
      } else {
        this.push(ev);
      }
    }
    if (res.fatal) this.readyWaiter?.reject(new Error(res.fatal));
  }

  private async watchExit(): Promise<void> {
    await this.proc.exited;
    this.exited = true;
    if (!(await settlesWithin(this.pumpDone, DRAIN_AFTER_EXIT_MS))) {
      // A straggler in the group may hold stdout open: stop reading.
      await this.reader?.cancel().catch(() => {});
    }
    // No orc-spawned descendant may outlive the provider (pgid === our pid; a pid stays
    // reserved while its group has members, so this only reaches stragglers).
    try {
      signalProcessGroup(this.pid, 'SIGKILL');
    } catch {
      /* gone / not ours */
    }
    const code = this.proc.exitCode;
    const signal = this.proc.signalCode ?? null;
    if (!this.mapper.isReady) {
      this.readyWaiter?.reject(new Error(this.startFailureMessage(code, signal)));
    }
    this.rawInfo({ exited: { code, signal } });
    this.push({ type: 'exited', code, signal });
    this.closeRaw();
  }

  private startFailureMessage(code: number | null, signal: string | null): string {
    const parts = [...this.mapper.startupErrors];
    const tail = readTail(this.stderrPath, 2_000).trim();
    if (tail && !parts.some((p) => tail.includes(p))) parts.push(tail);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    const mode = this.launch.resume ? `resume of ${this.providerSessionId}` : 'fresh start';
    return `claude exited before ready (${mode}, ${how})${parts.length ? `: ${parts.join(' | ')}` : ''}`;
  }

  private raw(dir: 'send' | 'recv', line: string): void {
    this.appendRaw({ ts: new Date().toISOString(), dir, line });
  }

  private rawInfo(info: Record<string, unknown>): void {
    this.appendRaw({ ts: new Date().toISOString(), dir: 'info', info });
  }

  private appendRaw(entry: Record<string, unknown>): void {
    if (this.rawFd === null) return;
    try {
      fs.writeSync(this.rawFd, `${JSON.stringify(entry)}\n`);
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

function stderrPathFor(rawLogPath: string): string {
  return path.join(path.dirname(rawLogPath), 'provider.stderr.log');
}

function readTail(file: string, bytes: number): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** true when `p` settles within `ms` (rejections count as settled). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawn claude for `launch` and wait for `ready`. Resolves with the runtime (the `ready`
 * event is buffered for the events() consumer); rejects with a descriptive error — after
 * killing the process group — when claude exits, rejects initialize, or times out first.
 */
export async function startClaudeRuntime(
  launch: ProviderLaunch,
  opts: ClaudeRuntimeOptions = {},
): Promise<ClaudeRuntime> {
  const { spec } = launch;
  if (spec.systemPrompt) {
    const p = spec.systemPrompt.path;
    if (!path.isAbsolute(p)) throw new Error(`claude runtime: system prompt path must be absolute: ${p}`);
    if (!fs.existsSync(p)) throw new Error(`claude runtime: system prompt file not found: ${p}`);
  }
  const env = buildClaudeEnv(launch.env, spec.env);
  const binName = opts.bin ?? launch.env.ORC_CLAUDE_BIN ?? process.env.ORC_CLAUDE_BIN ?? 'claude';
  const bin = Bun.which(binName, { PATH: env.PATH ?? '' }) ?? (path.isAbsolute(binName) ? binName : null);
  if (!bin) throw new Error(`claude runtime: '${binName}' not found on PATH`);
  const argv = buildClaudeArgv(spec, launch.resume, bin);

  fs.mkdirSync(path.dirname(launch.rawLogPath), { recursive: true, mode: 0o700 });
  const errFd = fs.openSync(stderrPathFor(launch.rawLogPath), 'a', 0o600);
  let proc: ClaudeProc;
  try {
    proc = Bun.spawn(argv, {
      cwd: spec.cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: errFd,
      detached: true,
    });
  } finally {
    fs.closeSync(errFd);
  }
  launch.onSpawn?.({ pid: proc.pid, startTime: processStartTime(proc.pid) });
  const rt = new ClaudeRuntime(proc, launch, argv, env);
  const envTimeout = Number(launch.env.ORC_CLAUDE_READY_TIMEOUT_MS ?? process.env.ORC_CLAUDE_READY_TIMEOUT_MS);
  const readyTimeoutMs =
    opts.readyTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_READY_TIMEOUT_MS);
  try {
    await rt.initialize();
  } catch {
    /* claude already gone: awaitReady reports why */
  }
  await rt.awaitReady(readyTimeoutMs);
  return rt;
}

export const claudeRuntime: ProviderRuntimeFactory = {
  provider: 'claude',
  start: (launch: ProviderLaunch) => startClaudeRuntime(launch),
};
