/**
 * Shared contracts for the tmux-free runtime (docs/DESIGN-runtime.md).
 *
 * This file is the seam between the actor kernel (src/runtime/*.ts) and the provider
 * runtimes (src/runtime/providers/*.ts). Changing a type here is a cross-slice change:
 * keep it additive.
 *
 * On-disk layout per session (under sessionStateDir(sessionId) = ~/.orc/sessions/<sid>/):
 *   spawn.json      SpawnSpec            written at create, updated with providerSessionId
 *   state.json      ActorStateFile       actor-owned snapshot (lease, provider pid, seq)
 *   journal.jsonl   JournalEntry[]       append-only facts, monotonic seq (source of truth)
 *   provider.jsonl  raw provider stream  verbatim provider protocol lines (debug only)
 *   inbox/          InboxItem files      <ULID>.json, written as .tmp-* then renamed
 *   actor.log       actor stdout/stderr
 */
import type { Provider, SystemPromptMode } from '../types.ts';

/** Bump only with a migration. */
export const RUNTIME_SCHEMA_VERSION = 1 as const;

/** Provider names a runtime can be started for. `fake` is the scripted test provider. */
export type RuntimeProvider = Provider | 'fake';

// ---------------------------------------------------------------------------------
// Spawn spec — everything needed to (re)start a session's actor from cold, including
// after a host reboot or from a different client process.
// ---------------------------------------------------------------------------------

export interface SystemPromptFile {
  mode: SystemPromptMode;
  /** Absolute path to an orc-owned file holding the prompt text (never on argv). */
  path: string;
}

export interface SpawnSpec {
  version: typeof RUNTIME_SCHEMA_VERSION;
  /** orc session uuid (claude/pi: also the provider session id). */
  sessionId: string;
  provider: RuntimeProvider;
  /** realpath of the agent cwd (worktree path when a worktree is used). */
  cwd: string;
  /**
   * Env ADDITIONS for the provider child (ORC_* lineage, ORC_RESULT_PATH, ORC_ATTEMPT_ID,
   * extraEnv). The actor merges these over its own process.env when spawning.
   */
  env: Record<string, string>;
  model?: string;
  /** claude native `--agent <name>`; codex/pi resolve agent bodies into systemPrompt. */
  agentName?: string;
  systemPrompt?: SystemPromptFile;
  /** Provider-specific per-session dir (pi --session-dir). */
  sessionDir?: string;
  /**
   * Provider-side session id once known (codex: server-assigned thread id; claude/pi:
   * equals sessionId). Persisted so resume works from any client.
   */
  providerSessionId?: string;
  /** Provider-side transcript path once known (codex: thread.path). */
  transcriptPath?: string;
  /** For `fake` only: the scripted behaviour (see src/runtime/providers/fake.ts). */
  fakeScript?: unknown;
  createdAt: string;
}

// ---------------------------------------------------------------------------------
// Provider runtime contract — implemented once per provider.
// ---------------------------------------------------------------------------------

export interface ProviderLaunch {
  spec: SpawnSpec;
  /** true → resume spec.providerSessionId; false → fresh session. */
  resume: boolean;
  /** Full env for the provider child (process.env merged with spec.env by the kernel). */
  env: Record<string, string>;
  /** Where the runtime must append verbatim provider protocol lines (debug stream). */
  rawLogPath: string;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Normalized events a provider runtime emits. The kernel journals them (adding seq/ts)
 * and drives turn bookkeeping from them. A runtime only ever has ONE open turn: the
 * kernel never calls send() again until the previous turn's outcome event arrived.
 */
export type ProviderEvent =
  /** Provider initialised and can accept a turn. */
  | {
      type: 'ready';
      providerSessionId: string;
      transcriptPath?: string;
      /** Provider-advertised capability flags (e.g. claude `interrupt_receipt_v1`). */
      capabilities?: string[];
      /** Free-form provider info worth journaling (version, model, apiKeySource…). */
      info?: Record<string, unknown>;
    }
  /** The provider accepted the user message for `messageId` (the delivery ack). */
  | { type: 'turn.started'; messageId: string }
  | { type: 'assistant.text'; messageId: string; text: string }
  | {
      type: 'turn.completed';
      messageId: string;
      /** Final assistant text for the turn, when the provider reports one. */
      result?: string;
      usage?: TurnUsage;
      /** Cost for THIS turn in USD when derivable (claude reports a cumulative total). */
      costUsd?: number;
    }
  | { type: 'turn.failed'; messageId: string; error: string }
  | { type: 'turn.interrupted'; messageId: string }
  /** Provider acknowledged an interrupt request (may arrive after the turn outcome). */
  | { type: 'interrupt.acked' }
  /** Provider asked for permission/input (should not happen in yolo). */
  | { type: 'permission.requested'; messageId?: string; detail: unknown }
  /** Provider process exited. Always the final event of the iterator. */
  | { type: 'exited'; code: number | null; signal: string | null };

export interface ProviderRuntime {
  readonly provider: RuntimeProvider;
  /** Provider child pid. The child runs in its own process group (pgid === pid). */
  readonly pid: number;
  /** Single-consumer stream of normalized events; ends after `exited`. */
  events(): AsyncIterable<ProviderEvent>;
  /** Start a turn. Precondition (kernel-guaranteed): no turn is open. */
  send(messageId: string, text: string): Promise<void>;
  /** Interrupt the open turn. No-op when no turn is open. */
  interrupt(): Promise<void>;
  /** Graceful shutdown (close stdin / protocol shutdown), then SIGKILL the group after graceMs. */
  close(opts?: { graceMs?: number }): Promise<void>;
}

export interface ProviderRuntimeFactory {
  readonly provider: RuntimeProvider;
  /** Spawn the provider child (detached, own process group, pipes — never a PTY). */
  start(launch: ProviderLaunch): Promise<ProviderRuntime>;
}

// ---------------------------------------------------------------------------------
// Inbox — the durable mailbox. Any process may drop an item; only the actor consumes.
// ---------------------------------------------------------------------------------

export type InboxItem =
  | { kind: 'message'; ulid: string; messageId: string; text: string; createdAt: string }
  | { kind: 'interrupt'; ulid: string; createdAt: string }
  | { kind: 'stop'; ulid: string; reason?: string; createdAt: string };

/** Valid inbox file name: a Crockford-base32 ULID + .json. Anything else is ignored. */
export const INBOX_FILE_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

// ---------------------------------------------------------------------------------
// Journal — append-only facts. One JSON object per line.
// ---------------------------------------------------------------------------------

export type TurnInterruptReason = 'interrupt' | 'recovered' | 'provider-exit';

export type JournalEvent =
  | { type: 'actor.started'; pid: number; mode: 'fresh' | 'resume' }
  | {
      type: 'provider.ready';
      providerSessionId: string;
      providerPid: number;
      transcriptPath?: string;
      capabilities?: string[];
      info?: Record<string, unknown>;
    }
  | { type: 'inbox.accepted'; ulid: string; kind: InboxItem['kind']; messageId?: string }
  /** Effect-sandwich intent: committed (fsync) BEFORE the message is written to the provider. */
  | { type: 'turn.intent'; messageId: string; ulid: string; text: string }
  | { type: 'turn.started'; messageId: string }
  | { type: 'assistant.text'; messageId: string; text: string }
  | { type: 'interrupt.requested'; messageId?: string }
  | { type: 'interrupt.acked' }
  | { type: 'turn.completed'; messageId: string; result?: string; usage?: TurnUsage; costUsd?: number }
  | { type: 'turn.failed'; messageId: string; error: string }
  | { type: 'turn.interrupted'; messageId: string; reason: TurnInterruptReason }
  | { type: 'permission.requested'; messageId?: string; detail: unknown }
  | { type: 'provider.exited'; code: number | null; signal: string | null }
  | {
      type: 'actor.stopped';
      reason: 'stop' | 'provider-exit' | 'error' | 'lease-lost';
      error?: string;
    };

export type JournalEntry = JournalEvent & { seq: number; ts: string };

/** Journal event types whose append is fsync'd (intent/outcome boundaries). */
export const DURABLE_EVENT_TYPES: ReadonlySet<JournalEvent['type']> = new Set([
  'turn.intent',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'actor.stopped',
]);

// ---------------------------------------------------------------------------------
// Actor state — the actor's snapshot. Written tmp+rename under the actor-<sid> lock.
// ---------------------------------------------------------------------------------

/**
 * running   — actor live (lease fresh).
 * stopped   — explicitly stopped (`orc kill` / stop item). Sticky: never auto-wakes.
 * suspended — actor gone without a stop (crash, provider exit, reboot). Resumable.
 */
export type ActorPhase = 'starting' | 'running' | 'stopping' | 'stopped' | 'suspended';

export interface ProcessIdentity {
  pid: number;
  /** Opaque process start-time token (pid-reuse guard); null when unknown. */
  startTime: string | null;
}

export interface ActorLease extends ProcessIdentity {
  /** Random per-actor-incarnation token. */
  token: string;
  /** ISO timestamp; the lease is dead after this unless renewed. */
  expiresAt: string;
}

export interface ActorStateFile {
  version: typeof RUNTIME_SCHEMA_VERSION;
  sessionId: string;
  phase: ActorPhase;
  lease?: ActorLease;
  /** Provider child identity; its process group id equals pid. */
  provider?: ProcessIdentity;
  providerSessionId?: string;
  /** Highest journal seq the actor has written. */
  lastSeq: number;
  /** Number of turns that reached turn.completed (resume needs >= 1 for codex). */
  completedTurns: number;
  stopReason?: string;
  updatedAt: string;
}

/** Lease timing (design §4.2). */
export const LEASE_HEARTBEAT_MS = 5_000;
export const LEASE_TTL_MS = 30_000;
/** Inbox poll interval — the correctness path; fs.watch is only a latency hint. */
export const INBOX_POLL_MS = 250;
