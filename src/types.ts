/**
 * Core types for the orc SDK.
 */

export type Provider = 'claude' | 'codex' | 'pi';

export type SystemPromptMode = 'append' | 'replace';

/**
 * Session lifecycle status (derived from the actor kernel, never stored except `dead`):
 * - `running`   — the session's actor holds a live lease.
 * - `suspended` — not live and not stopped, spawn.json present: resumable (an `orc send`
 *   or `orc resume` wakes it).
 * - `spawning`  — reserved by agent()/`orc spawn` moments ago, kernel session not created
 *   yet (no spawn.json, record younger than SPAWN_PENDING_GRACE_MS). Never pruned.
 * - `dead`      — stopped (killed / taken over), a legacy tmux record, or no spawn.json
 *   (past the spawn grace).
 */
export type SessionStatus = 'running' | 'suspended' | 'spawning' | 'dead';

/**
 * State of an agent session, derived from its durable journal (design §4.4). This is the
 * foundation for orchestration, so the definitions are load-bearing:
 *
 * - `starting` — the actor is up but the provider has not finished initialising.
 * - `running`  — a turn is open, or messages are queued in the inbox.
 * - `done`     — no open turn and nothing queued: the last turn YIELDED. This means
 *   "ready for YOUR input," NOT "succeeded." It covers both "finished the task" and
 *   "asked a clarifying question" (both end a turn normally).
 * - `waiting`  — the provider asked for a permission/approval decision (should not happen
 *   in the yolo modes orc launches; orc denies it so the turn ends).
 * - `failed`   — the last turn failed, or the session is not live (stopped, crashed,
 *   host rebooted, legacy). `orc state --json` adds `suspended: true` when it is
 *   resumable and `stopped: true` when it was explicitly stopped.
 */
export type AgentState = 'starting' | 'running' | 'done' | 'waiting' | 'failed';

/**
 * Enforceable bounds for recursive delegation. Token/cost budgets are NOT measurable
 * today and are intentionally omitted — do not invent enforcement for them.
 */
export interface ExecutionPolicy {
  /** Max nesting depth of workflow/agent delegation (root = 0). */
  maxDepth?: number;
  /** Max total sessions ever spawned under this root (lifetime count). */
  maxSessions?: number;
  /** Max concurrently live sessions under this root. */
  maxConcurrentSessions?: number;
  /** Wall-clock deadline from root start (ms). */
  deadlineMs?: number;
  /** When false, child spawns that would deepen delegation fail closed. Default true. */
  canDelegate?: boolean;
}

/** Optional execution lineage attached to a session or agent spawn. */
export interface ExecutionLineage {
  /** Root workflow run id for the whole tree (equals parentRunId when depth=0). */
  rootRunId?: string;
  /** Immediate parent workflow run id. */
  parentRunId?: string;
  /** Immediate parent session short id / sessionId. */
  parentSessionId?: string;
  /** Step id within the parent run that spawned this session. */
  stepId?: string;
  /** Nesting depth (root workflow sessions = 0 or 1 depending on spawn site). */
  depth?: number;
  /** Owner / principal label for audit (e.g. run owner id). */
  owner?: string;
}

export interface AgentOptions extends ExecutionLineage {
  provider: Provider;
  model?: string;
  /** Name of an existing agent definition (claude/codex, project- or user-scoped). */
  agentName?: string;
  /**
   * Orchestrator-local handle for this session. Distinct from agentName/systemPrompt:
   * it only affects how orc resolves the session later (`@alias` / `@workspace:alias`).
   */
  alias?: string;
  /** System prompt text. INVALID to pass together with agentName (validation error). */
  systemPrompt?: string;
  /** 'append' (default) augments the CLI's built-in prompt; 'replace' overrides it. */
  systemPromptMode?: SystemPromptMode;
  /** Initial prompt sent after the session boots (multi-line safe). */
  prompt?: string;
  /** Base working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Logical workspace key; defaults to git toplevel of cwd, else cwd. */
  workspace?: string;
  /** Create a fresh git worktree for this agent and use it as cwd. */
  worktree?: boolean | { branch?: string; path?: string };
  /**
   * Wait (bounded by `readyTimeoutMs`) for the provider to report ready before resolving
   * and before sending `prompt` (default true). false → return as soon as the actor has
   * started; an initial `prompt` is still durably queued (delivered once ready).
   */
  waitForReady?: boolean;
  /** Bound for the readiness wait (default 60000 ms). */
  readyTimeoutMs?: number;
  /** Optional execution policy (merged with inherited root policy when lineage is set). */
  policy?: ExecutionPolicy;
  /**
   * Extra environment variables threaded into the provider process
   * (e.g. ORC_RESULT_PATH). Merged after lineage env; does not override empty keys.
   */
  extraEnv?: Record<string, string>;
}

/**
 * Persisted record for a launched session. Stored as an array in ~/.orc/registry.json.
 * Optional lineage fields are absent on pre-phase-2 records (still valid). Runtime state
 * (liveness, turns) lives in the kernel under ~/.orc/sessions/<sessionId>/.
 */
export interface SessionRecord extends ExecutionLineage {
  /** Short handle (first 8 chars of sessionId). Used as the CLI handle. */
  id: string;
  /** The uuid we generate at spawn (the kernel session id; claude/pi --session-id). */
  sessionId: string;
  /** `actor` for every session launched on the tmux-free runtime. */
  runtime?: 'actor';
  /**
   * Provider-side session id (claude/pi/codex harness: equals sessionId), learned from the
   * kernel once the provider is ready.
   */
  providerSessionId?: string;
  provider: Provider;
  model?: string;
  agentName?: string;
  /** Workspace-scoped, reusable active-session alias. */
  alias?: string;
  /** Transient pre-spawn reservation used to make alias creation race-resistant. */
  aliasReservedAt?: string;
  /** realpath of the launch cwd (== worktree path if worktree). */
  cwd: string;
  worktreePath?: string;
  branch?: string;
  workspace: string;
  systemPromptMode?: SystemPromptMode;
  /** For pi: the --session-dir, used to locate the transcript. */
  sessionDir?: string;
  /**
   * Absolute path of the orc-owned system prompt file (~/.orc/sessions/<sid>/
   * system-prompt.md, 0600) the provider reads at launch. Present when a system prompt or
   * a resolved (codex/pi) agent body applies. Removed with the session dir.
   */
  systemPromptPath?: string;
  createdAt: string;
  /**
   * Persisted only as `dead` (killed, taken over, or legacy). Absent means the kernel is
   * authoritative (running / suspended / dead). Dead records are KEPT so transcript and
   * journal reads still resolve; hidden from `orc list` by default.
   */
  status?: SessionStatus;
  /** ISO timestamp set when the record was killed or taken over. */
  killedAt?: string;
  /** Why the session was stopped by orc (`kill` | `takeover`). */
  stoppedBy?: 'kill' | 'takeover';
  /** The on-disk provider transcript path, persisted at kill/takeover time. */
  transcriptPath?: string;
  /** Effective policy snapshot at spawn (for audit); optional. */
  policy?: ExecutionPolicy;
  /**
   * Set on records written by the pre-actor (tmux) orc: readable and prunable, never
   * controlled. Normalised at read time (status forced to `dead`).
   */
  legacy?: 'tmux';
  /** The tmux session name of a legacy record (read-only, informational). */
  legacyTmuxName?: string;
}

/**
 * Environment variables used to propagate lineage and policy into child orc processes.
 * Explicit AgentOptions override inherited values.
 */
export const ORC_ENV = {
  ROOT_RUN_ID: 'ORC_ROOT_RUN_ID',
  PARENT_RUN_ID: 'ORC_PARENT_RUN_ID',
  PARENT_SESSION_ID: 'ORC_PARENT_SESSION_ID',
  STEP_ID: 'ORC_STEP_ID',
  DEPTH: 'ORC_DEPTH',
  OWNER: 'ORC_OWNER',
  /** Alias for parent run context (same semantics as PARENT_RUN_ID when set alone). */
  RUN_ID: 'ORC_RUN_ID',
  /** Absolute path to this attempt's result envelope JSON (agent may write testimony). */
  RESULT_PATH: 'ORC_RESULT_PATH',
  /** Current workflow attempt id (pairs with ORC_RESULT_PATH). */
  ATTEMPT_ID: 'ORC_ATTEMPT_ID',
  POLICY_MAX_DEPTH: 'ORC_POLICY_MAX_DEPTH',
  POLICY_MAX_SESSIONS: 'ORC_POLICY_MAX_SESSIONS',
  POLICY_MAX_CONCURRENT: 'ORC_POLICY_MAX_CONCURRENT',
  POLICY_DEADLINE_MS: 'ORC_POLICY_DEADLINE_MS',
  POLICY_CAN_DELEGATE: 'ORC_POLICY_CAN_DELEGATE',
  /** Absolute ISO deadline stamped when a root starts with deadlineMs. */
  POLICY_DEADLINE_AT: 'ORC_POLICY_DEADLINE_AT',
} as const;
