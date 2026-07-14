/**
 * Core types for the orc SDK.
 */

export type Provider = 'claude' | 'codex' | 'pi';

export type SystemPromptMode = 'append' | 'replace';

export type SessionStatus = 'running' | 'dead';

/**
 * Classified state of an interactive agent session. This is the foundation for
 * orchestration, so the definitions are load-bearing — be precise:
 *
 * - `starting` — booted but not yet showing a ready composer (transient).
 * - `running`  — the assistant is actively working (a turn is in progress).
 * - `done`     — the turn has YIELDED: the composer is idle and ready for input.
 *   This means "ready for YOUR input," NOT "succeeded." It covers BOTH "finished the
 *   task" AND "asked a clarifying question and is waiting for your reply" — those two
 *   are pane-indistinguishable for claude/codex in yolo mode (both render as the idle
 *   composer with no working indicator), so a conversational question is reported as
 *   `done`, not `waiting`.
 * - `waiting`  — blocked specifically on a TUI MODAL that needs a response: a trust
 *   dialog, an approval/permission selection, or an update interstitial. (A
 *   conversational question is `done`, per above — it is not pane-distinguishable.)
 * - `failed`   — the process/pane is no longer alive. This is crash OR clean exit
 *   (e.g. `/exit`); pane-gone cannot distinguish them, so `failed` means "TERMINATED,"
 *   NOT "errored."
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
  /** Driver name; default 'tmux'. */
  driver?: string;
  /** Wait for boot before resolving (default true). */
  waitForReady?: boolean;
  /** Optional execution policy (merged with inherited root policy when lineage is set). */
  policy?: ExecutionPolicy;
  /**
   * Extra environment variables threaded into the detached TUI process
   * (e.g. ORC_RESULT_PATH). Merged after lineage env; does not override empty keys.
   */
  extraEnv?: Record<string, string>;
}

/**
 * Persisted record for a launched session. Stored as an array in ~/.orc/registry.json.
 * Optional lineage fields are absent on pre-phase-2 records (still valid).
 */
export interface SessionRecord extends ExecutionLineage {
  /** Short handle (first 8 chars of sessionId). Used as the CLI handle. */
  id: string;
  /** The uuid we generate at spawn (claude/pi --session-id; also the handle source). */
  sessionId: string;
  /**
   * Provider-side session id discovered after boot. For claude/pi this equals sessionId.
   * For codex (no --session-id at launch) this is the uuid discovered from the rollout file.
   * Undefined until resolved.
   */
  transcriptSessionId?: string;
  provider: Provider;
  model?: string;
  agentName?: string;
  /** Workspace-scoped, reusable active-session alias. */
  alias?: string;
  /** Transient pre-spawn reservation used to make alias creation race-resistant. */
  aliasReservedAt?: string;
  tmuxName: string;
  /** realpath of the launch cwd (== worktree path if worktree). */
  cwd: string;
  worktreePath?: string;
  branch?: string;
  workspace: string;
  systemPromptMode?: SystemPromptMode;
  /** For pi: the session-dir passed at launch, used to glob the transcript. */
  sessionDir?: string;
  /**
   * Absolute path to an orc-owned Codex persona instructions file (outside the
   * worktree). Present when a system/agent prompt was injected via
   * `experimental_instructions_file`. Removed on pre-spawn failure and purge/cleanup.
   */
  instructionsPath?: string;
  createdAt: string;
  /**
   * Lifecycle status. Absent (undefined) means alive/active. 'dead' marks a record
   * that was explicitly killed: it is KEPT in the registry (not deleted) so transcript
   * and metadata reads still resolve after kill (ARCHITECTURE: keep dead records for
   * transcript reads). Hidden from `orc list` by default; shown with --all/--dead.
   */
  status?: SessionStatus;
  /** ISO timestamp set when the record was killed. */
  killedAt?: string;
  /**
   * The on-disk transcript path, resolved and persisted at kill time. For codex (no
   * preset session-id) this is captured BEFORE the tmux session + cwd are gone, so the
   * transcript stays discoverable afterwards.
   */
  transcriptPath?: string;
  /** Effective policy snapshot at spawn (for audit); optional. */
  policy?: ExecutionPolicy;
}

export interface PaneInfo {
  name: string;
  pid: number;
  cwd: string;
  command: string;
  attached: boolean;
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
