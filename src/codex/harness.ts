/**
 * The codex harness: orc's in-house coding agent for the `codex` provider, run as a
 * detached child of the session actor (`orc __codex-harness <sid>`, own process group).
 * It embeds pi-ai (OpenAI Responses API; Sign in with ChatGPT or an API key) and
 * pi-agent-core (the agent loop), talks directly to https://api.openai.com/v1/responses,
 * and speaks the JSONL protocol in ./protocol.ts on stdio.
 *
 * Boot (after the `init` line): resolve the credential (./auth.ts) → pick the model
 * (./models.ts) → load (resume) or create (fresh) the pi-format session file
 * (./session-file.ts) → build the agent with the coding tools (./tools.ts) → `ready`.
 * Any boot failure → `fatal` + exit 1 (the runtime turns it into a start error).
 *
 * Turn mapping (one open turn; exactly one outcome each):
 *   prompt            → turn.started at once (the delivery ack), then agent.prompt(text)
 *   message_end       → persisted to the session file; assistant text blocks → assistant.text
 *   agent_end         → last assistant stopReason: "aborted" → turn.interrupted;
 *                       "error" → turn.failed (turn.interrupted if an abort was requested);
 *                       else turn.completed {result: last non-empty assistant text,
 *                       usage: summed over the run, costUsd: pi-ai's catalog price when the
 *                       model is in pi-ai's catalog}
 *   abort             → agent.abort() (cancels the request and kills running bash trees)
 *                       + interrupt.acked (one per abort, also when no turn is open)
 *   stdin EOF / SIGTERM → abort the open turn, wait for it to settle (its partial reply is
 *                       persisted), kill remaining bash commands, exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.ts';
import {
  createModels,
  InMemoryCredentialStore,
  isContextOverflow,
  type AssistantMessage,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { Agent, type AgentEvent, type AgentMessage, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { SpawnSpec, TurnUsage } from '../runtime/types.ts';
import { JsonlSplitter } from '../runtime/providers/pi-protocol.ts';
import { parsePi } from '../transcript.ts';
import { CodexAuthError, OPENAI_PROVIDER_ID, resolveCodexAuth, type CodexAuth } from './auth.ts';
import { installTestEndpoint, OPENAI_API_BASE, testEndpoint } from './endpoint.ts';
import { buildModel, listLiveModels, parseModelList, resolveModelId } from './models.ts';
import { encodeLine, parseHarnessCommand, type HarnessCommand, type HarnessEvent } from './protocol.ts';
import { loadSession, SessionFileWriter, type LoadedSession } from './session-file.ts';
import { CODING_TOOL_NAMES, createCodingTools, killRunningCommands } from './tools.ts';
import { textReplySse, toolCallsSse } from './fake-responses.ts';

/** pi-ai / pi-agent-core versions this harness is pinned to (package.json: exact). */
export const PI_AI_VERSION = '1.2.0';
export const PI_AGENT_CORE_VERSION = '1.2.0';

/** Default reasoning level (clamped per model by pi-ai). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
/** Provider-request retries for 408/409/429/5xx (pi-ai's default is none). */
export const DEFAULT_MAX_RETRIES = 2;
/** How long shutdown waits for an aborted turn to settle before exiting anyway. */
const SHUTDOWN_SETTLE_MS = 5_000;

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function harnessUserAgent(): string {
  return `orc/${VERSION} (codex-harness; pi-ai ${PI_AI_VERSION}; ${os.platform()} ${os.release()}; ${os.arch()})`;
}

/** The harness's built-in system prompt (used alone, or before an `append` file). */
export function defaultSystemPrompt(cwd: string, now: Date = new Date()): string {
  return [
    'You are a coding agent running inside orc, a multi-agent orchestrator. The session is non-interactive:',
    'nobody can answer questions mid-turn, so make reasonable assumptions, state them, and keep going.',
    '',
    'You work on the local machine through these tools:',
    '- read: read a file (use it instead of cat/sed for viewing files)',
    '- bash: run a shell command in the working directory (search with rg/grep, run builds, tests, git)',
    '- edit: replace exact, unique text in an existing file',
    '- write: create or overwrite a file',
    '- ls: list a directory',
    '',
    'Guidelines:',
    '- Read the relevant code before changing it; keep changes focused and consistent with the codebase.',
    '- Verify your work (run the tests or the command that proves it) before you finish.',
    '- Finish with a short summary of what you did and what remains, if anything.',
    '',
    `Working directory: ${cwd}`,
    `Current date: ${now.toISOString().slice(0, 10)}`,
  ].join('\n');
}

/** spec.systemPrompt → the harness system prompt (replace = exact; append = default + file). */
export function composeSystemPrompt(spec: SpawnSpec, now: Date = new Date()): string {
  const base = defaultSystemPrompt(spec.cwd, now);
  if (!spec.systemPrompt) return base;
  let text: string;
  try {
    text = fs.readFileSync(spec.systemPrompt.path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read system prompt file ${spec.systemPrompt.path}: ${(e as Error).message}`);
  }
  if (spec.systemPrompt.mode === 'replace') return text;
  return text.trim().length > 0 ? `${base}\n\n${text}` : base;
}

function thinkingLevelFromEnv(env: Record<string, string | undefined>): ThinkingLevel {
  const v = env.ORC_CODEX_THINKING;
  return v && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : DEFAULT_THINKING_LEVEL;
}

function maxRetriesFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.ORC_CODEX_MAX_RETRIES);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : DEFAULT_MAX_RETRIES;
}

// ---------------------------------------------------------------------------------
// stdout (protocol) — synchronous, EAGAIN-safe, never throws
// ---------------------------------------------------------------------------------

let stdoutBroken = false;

function writeOut(ev: HarnessEvent): void {
  if (stdoutBroken) return;
  const buf = Buffer.from(`${encodeLine(ev)}\n`, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'EAGAIN') {
        Bun.sleepSync(1);
        continue;
      }
      stdoutBroken = true; // EPIPE: the runtime is gone
      return;
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------

interface OpenTurn {
  messageId: string;
  interruptRequested: boolean;
  finished: boolean;
}

interface HarnessDeps {
  emit: (ev: HarnessEvent) => void;
  env: Record<string, string | undefined>;
}

export class CodexHarness {
  private agent!: Agent;
  private writer!: SessionFileWriter;
  private turn: OpenTurn | null = null;
  private chain: Promise<void> = Promise.resolve();
  private modelKnown = true;
  private contextWindow: number | undefined;
  private auth!: CodexAuth;
  private shuttingDown = false;

  constructor(private readonly deps: HarnessDeps) {}

  /** Boot from the init command; emits `ready` (or throws: the caller emits `fatal`). */
  async boot(init: Extract<HarnessCommand, { type: 'init' }>): Promise<void> {
    const { spec, resume, sessionFile } = init;
    const env = this.deps.env;
    if (spec.provider !== 'codex') throw new Error(`spec.provider is '${spec.provider}', expected 'codex'`);
    if (!fs.existsSync(spec.cwd) || !fs.statSync(spec.cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${spec.cwd}`);
    }
    registerBunOAuthFlows();
    const fetchFn = installTestEndpoint(env);
    this.auth = await resolveCodexAuth(env);
    const models = createModels({ credentials: this.auth.store });
    models.setProvider(openaiProvider());

    let loaded: LoadedSession | undefined;
    if (resume) {
      if (!fs.existsSync(sessionFile)) {
        throw new Error(
          `cannot resume: no codex harness session file at ${sessionFile} ` +
            '(sessions created by the removed codex app-server runtime cannot be resumed; start a new session)',
        );
      }
      loaded = loadSession(sessionFile);
      if (loaded.header.id !== spec.sessionId) {
        throw new Error(`cannot resume: ${sessionFile} belongs to session ${loaded.header.id}, not ${spec.sessionId}`);
      }
    }

    const pick = await resolveModelId({
      specModel: spec.model,
      sessionModel: loaded?.modelId,
      list: () => listLiveModels({ models, accountKey: this.auth.accountKey, fetch: fetchFn }),
      authLabel: this.auth.label,
    });
    const built = buildModel(models, pick.id);
    this.modelKnown = built.known;
    this.contextWindow = built.model.contextWindow;
    const thinkingLevel = (loaded?.thinkingLevel as ThinkingLevel | undefined) ?? thinkingLevelFromEnv(env);
    const tools = createCodingTools({ cwd: spec.cwd, env });
    const systemPrompt = loaded ? undefined : composeSystemPrompt(spec);
    const maxRetries = maxRetriesFromEnv(env);
    const ua = harnessUserAgent();

    this.agent = new Agent({
      initialState: {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        model: built.model,
        tools,
        thinkingLevel,
        messages: loaded?.messages ?? [],
      },
      streamFn: (m, ctx, opts) =>
        models.streamSimple(m, ctx, {
          ...opts,
          maxRetries,
          fetch: fetchFn,
          transformHeaders: (h) => ({ ...h, 'User-Agent': ua }),
        }),
      sessionId: spec.sessionId,
    });

    if (loaded) {
      this.writer = SessionFileWriter.append(sessionFile, loaded.lastEntryId);
      if (loaded.modelId !== built.model.id) this.writer.appendModelChange(built.model.id);
    } else {
      this.writer = SessionFileWriter.create(sessionFile, { id: spec.sessionId, cwd: spec.cwd });
      this.writer.appendModelChange(built.model.id);
      this.writer.appendThinkingLevel(thinkingLevel);
      const first = this.agent.state.messages[0];
      if (first?.role === 'system') this.writer.appendMessage(first);
      this.writer.sync();
    }
    this.agent.subscribe((ev) => this.onAgentEvent(ev));

    this.deps.emit({
      type: 'ready',
      providerSessionId: spec.sessionId,
      transcriptPath: sessionFile,
      info: {
        harness: 'orc-codex',
        version: VERSION,
        piAi: PI_AI_VERSION,
        mode: resume ? 'resume' : 'fresh',
        model: built.model.id,
        modelSource: pick.source,
        ...(pick.cached !== undefined ? { modelListCached: pick.cached } : {}),
        ...(built.known ? {} : { modelInCatalog: false }),
        auth: this.auth.label,
        authSource: this.auth.source,
        thinkingLevel,
        messageCount: this.agent.state.messages.length,
        tools: [...CODING_TOOL_NAMES],
        endpoint: `${OPENAI_API_BASE}/responses`,
        // Never misreport where tokens went: the offline test seam redirects every request.
        ...(testEndpoint(env) ? { testEndpoint: testEndpoint(env) } : {}),
      },
    });
  }

  /** Handle one command after boot. */
  handle(cmd: HarnessCommand): void {
    if (cmd.type === 'prompt') this.prompt(cmd.id, cmd.text);
    else if (cmd.type === 'abort') this.abort(cmd.id);
  }

  private prompt(messageId: string, text: string): void {
    if (this.shuttingDown) return;
    if (this.turn) {
      this.deps.emit({ type: 'turn.failed', messageId, error: `turn ${this.turn.messageId} is still open` });
      return;
    }
    const turn: OpenTurn = { messageId, interruptRequested: false, finished: false };
    this.turn = turn;
    this.deps.emit({ type: 'turn.started', messageId });
    this.chain = this.chain.then(() => this.runTurn(turn, text));
  }

  private async runTurn(turn: OpenTurn, text: string): Promise<void> {
    if (turn.interruptRequested) {
      this.finish(turn, { type: 'turn.interrupted', messageId: turn.messageId });
      return;
    }
    try {
      await this.agent.prompt(text);
    } catch (e) {
      this.finish(turn, { type: 'turn.failed', messageId: turn.messageId, error: errText(e) });
      return;
    }
    // agent_end normally closed it; never leave a turn without an outcome.
    if (!turn.finished) this.finish(turn, { type: 'turn.failed', messageId: turn.messageId, error: 'agent run ended without an outcome' });
  }

  private abort(id: string): void {
    const t = this.turn;
    if (t && !t.finished) {
      t.interruptRequested = true;
      this.agent.abort();
    }
    this.deps.emit({ type: 'interrupt.acked', id });
  }

  private finish(turn: OpenTurn, ev: HarnessEvent): void {
    if (turn.finished) return;
    turn.finished = true;
    if (this.turn === turn) this.turn = null;
    this.deps.emit(ev);
  }

  private onAgentEvent(ev: AgentEvent): void {
    const turn = this.turn;
    switch (ev.type) {
      case 'message_end': {
        try {
          this.writer.appendMessage(ev.message);
        } catch (e) {
          this.deps.emit({ type: 'log', event: 'persist_failed', error: errText(e) });
        }
        const m = ev.message as AgentMessage & { role?: string };
        if (turn && m.role === 'assistant') {
          for (const block of (m as AssistantMessage).content) {
            if (block.type === 'text' && block.text.trim().length > 0) {
              this.deps.emit({ type: 'assistant.text', messageId: turn.messageId, text: block.text });
            }
          }
        }
        return;
      }
      case 'tool_execution_start':
        this.deps.emit({ type: 'log', event: 'tool_start', toolCallId: ev.toolCallId, tool: ev.toolName });
        return;
      case 'tool_execution_end':
        this.deps.emit({
          type: 'log',
          event: 'tool_end',
          toolCallId: ev.toolCallId,
          tool: ev.toolName,
          isError: ev.isError,
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        });
        return;
      case 'agent_end': {
        this.writer.sync();
        if (turn) this.finish(turn, this.outcome(turn, ev.messages));
        return;
      }
      default:
        return;
    }
  }

  private outcome(turn: OpenTurn, messages: AgentMessage[]): HarnessEvent {
    const assistants = messages.filter((m): m is AssistantMessage => (m as { role?: string }).role === 'assistant');
    const last = assistants.at(-1);
    const stop = last?.stopReason;
    const messageId = turn.messageId;
    if (stop === 'aborted' || (turn.interruptRequested && stop === 'error')) return { type: 'turn.interrupted', messageId };
    if (!last || stop === 'error' || stop === 'pending' || stop === 'deferred') {
      const message = last?.errorMessage ?? `run ended with stopReason ${String(stop)}`;
      if (last && isContextOverflow(last, this.contextWindow)) {
        // No compaction yet: the only way forward is a fresh session.
        return {
          type: 'turn.failed',
          messageId,
          error: `${message} — the conversation exceeds the model's context window; start a new session`,
        };
      }
      return { type: 'turn.failed', messageId, error: this.errorWithHint(message) };
    }
    const usage: Required<TurnUsage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let cost = 0;
    for (const a of assistants) {
      usage.inputTokens += a.usage?.input ?? 0;
      usage.outputTokens += a.usage?.output ?? 0;
      usage.cacheReadTokens += a.usage?.cacheRead ?? 0;
      usage.cacheWriteTokens += a.usage?.cacheWrite ?? 0;
      cost += a.usage?.cost?.total ?? 0;
    }
    let result: string | undefined;
    for (let i = assistants.length - 1; i >= 0 && result === undefined; i--) {
      const t = assistants[i]!.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      if (t.trim().length > 0) result = t;
    }
    return {
      type: 'turn.completed',
      messageId,
      ...(result !== undefined ? { result } : {}),
      usage,
      ...(this.modelKnown ? { costUsd: cost } : {}),
    };
  }

  private errorWithHint(message: string): string {
    const authProblem = /OAuth refresh failed|invalid_token|\b401\b|token.*expired|Provider is not configured/i.test(message);
    if (!authProblem) return message;
    if (this.auth?.source === 'pi') return `${message} — pi's ChatGPT login needs renewing: log in again in pi, or run \`orc login chatgpt\``;
    if (this.auth?.source === 'orc') return `${message} — run \`orc login chatgpt\` again`;
    return `${message} — check OPENAI_API_KEY, or run \`orc login chatgpt\``;
  }

  /** Abort the open turn, let it settle (persisting the partial reply), kill bash commands. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.turn && !this.turn.finished) {
      this.turn.interruptRequested = true;
      this.agent?.abort();
    }
    await Promise.race([this.chain, Bun.sleep(SHUTDOWN_SETTLE_MS)]);
    await killRunningCommands(300);
    this.writer?.close();
  }
}

// ---------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------

/** `orc __codex-harness <sid>` (protocol mode) or `orc __codex-harness --self-test`. */
export async function runCodexHarnessMain(argv: string[]): Promise<number> {
  if (argv[0] === '--self-test') return runSelfTest();
  // stdout is the protocol channel: keep every library's console output off it.
  const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : Bun.inspect(x))).join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;

  const harness = new CodexHarness({ emit: writeOut, env: process.env });
  let booted = false;
  let exiting = false;
  const exit = async (code: number) => {
    if (exiting) return;
    exiting = true;
    await harness.shutdown().catch(() => {});
    process.exit(code);
  };
  process.on('SIGTERM', () => void exit(143));
  process.on('SIGHUP', () => void exit(129));

  const split = new JsonlSplitter();
  const dec = new TextDecoder();
  let bootPromise: Promise<void> | null = null;
  const onLine = (line: string) => {
    if (line.trim().length === 0) return;
    const cmd = parseHarnessCommand(line);
    if (!cmd) {
      writeOut({ type: 'log', event: 'bad_command', line: line.slice(0, 200) });
      return;
    }
    if (cmd.type === 'init') {
      if (bootPromise) return;
      bootPromise = harness.boot(cmd).then(
        () => {
          booted = true;
        },
        (e: unknown) => {
          const msg = e instanceof CodexAuthError ? e.message : `codex harness: ${errText(e)}`;
          writeOut({ type: 'fatal', error: msg });
          void exit(1);
        },
      );
      return;
    }
    if (!bootPromise) {
      writeOut({ type: 'log', event: 'command_before_init', command: cmd.type });
      return;
    }
    void bootPromise.then(() => {
      if (booted) harness.handle(cmd);
    });
  };
  try {
    for await (const chunk of Bun.stdin.stream()) {
      for (const line of split.push(dec.decode(chunk, { stream: true }))) onLine(line);
    }
    for (const line of split.push(dec.decode())) onLine(line);
    const rest = split.flush();
    if (rest.trim().length > 0) onLine(rest);
  } catch {
    // stdin error → treat as EOF
  }
  // EOF: the runtime closed stdin (graceful close) or the actor died.
  if (bootPromise) await (bootPromise as Promise<void>).catch(() => {});
  await exit(0);
  return 0;
}

// ---------------------------------------------------------------------------------
// Offline self-test (compiled-binary smoke test)
// ---------------------------------------------------------------------------------

/**
 * Exercise the embedded stack without network: pi-ai's bundled OAuth loader (a SIWC-shaped
 * OAuth credential goes through `toAuth`), the Responses request path and SSE parsing (a
 * fake fetch), the agent loop with a real `bash` tool call, the session file round trip
 * and the transcript parser. Prints one JSON line; exit 0 when every check passed.
 */
export async function runSelfTest(): Promise<number> {
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ check: name, ok, ...(detail ? { detail } : {}) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-selftest-'));
  try {
    registerBunOAuthFlows();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(OPENAI_PROVIDER_ID, async () => ({
      type: 'oauth',
      access: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvcmMtc2VsZnRlc3QifQ.c2ln',
      refresh: 'rt_selftest',
      expires: Date.now() + 3_600_000,
      clientId: 'app_selftest',
      scopes: ['chatgpt.tokens.use.direct'],
    }));
    const models = createModels({ credentials });
    models.setProvider(openaiProvider());
    check('catalog', models.getModels(OPENAI_PROVIDER_ID).length > 0);
    const auth = await models.getAuth(OPENAI_PROVIDER_ID);
    check('oauth-loader', auth?.source === 'OAuth' && typeof auth.auth.apiKey === 'string');
    check(
      'model-list-parse',
      JSON.stringify(parseModelList({ models: [{ slug: 'a', visibility: 'list' }, { slug: 'b', visibility: 'hide' }] }, new Set())) === '["a"]',
    );

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const replies = [toolCallsSse([{ name: 'bash', args: { command: 'echo orc-self-test-$((40+2))' } }]), textReplySse('self-test ok')];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(replies.shift() ?? textReplySse('extra'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const sessionFile = path.join(tmp, 'codex-session.jsonl');
    const writer = SessionFileWriter.create(sessionFile, { id: 'selftest', cwd: tmp });
    const built = buildModel(models, 'gpt-5.5');
    const agent = new Agent({
      initialState: {
        systemPrompt: defaultSystemPrompt(tmp),
        model: built.model as Model<Api>,
        tools: createCodingTools({ cwd: tmp, env: process.env }),
        thinkingLevel: 'low',
      },
      streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, { ...opts, fetch: fakeFetch }),
      sessionId: 'selftest',
    });
    const first = agent.state.messages[0];
    if (first) writer.appendMessage(first);
    let toolOutput = '';
    agent.subscribe((ev) => {
      if (ev.type === 'message_end') writer.appendMessage(ev.message);
      if (ev.type === 'tool_execution_end') {
        const r = ev.result as { content?: Array<{ type: string; text?: string }> };
        toolOutput = (r.content ?? []).map((c) => c.text ?? '').join('');
      }
    });
    await agent.prompt('run the self test');
    writer.close();
    const final = agent.state.messages.at(-1) as AssistantMessage | undefined;
    check('responses-endpoint', requests[0]?.url === `${OPENAI_API_BASE}/responses`, requests[0]?.url);
    check('siwc-request-shape', !!requests[0] && requests[0].body.store === false && !('max_output_tokens' in requests[0].body));
    check('bash-tool', toolOutput.includes('orc-self-test-42'), toolOutput.slice(0, 80));
    check('agent-loop', final?.stopReason === 'stop' && final.content.some((b) => b.type === 'text' && b.text === 'self-test ok'));
    const loaded = loadSession(sessionFile);
    check('session-file', loaded.messages.length === agent.state.messages.length, `${loaded.messages.length}/${agent.state.messages.length}`);
    const turns = parsePi(fs.readFileSync(sessionFile, 'utf8'));
    check('transcript', turns.some((t) => t.role === 'user') && turns.some((t) => t.role === 'tool' && t.text.startsWith('bash')));
    // Not codex: the compiled orc must also parse settings.toml (Bun's built-in TOML parser).
    const { loadSettings } = await import('../settings.ts');
    fs.writeFileSync(path.join(tmp, 'settings.toml'), 'host = "studio:9000"\nprovider = "codex"\n[models]\ncodex = "gpt-5.5"\n');
    const settings = loadSettings({ cwd: tmp, env: { ORC_HOME: tmp } });
    check(
      'settings-toml',
      settings.host?.value === 'studio:9000' && settings.provider?.value === 'codex' && settings.models.codex?.value === 'gpt-5.5',
    );
  } catch (e) {
    check('exception', false, errText(e));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const ok = checks.every((c) => c.ok);
  process.stdout.write(`${JSON.stringify({ ok, piAi: PI_AI_VERSION, checks })}\n`);
  return ok ? 0 : 1;
}
