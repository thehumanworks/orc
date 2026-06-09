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

export interface AgentOptions {
  provider: Provider;
  model?: string;
  /** Name of an existing agent definition (claude/codex, project- or user-scoped). */
  agentName?: string;
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
}

/**
 * Persisted record for a launched session. Stored as an array in ~/.orc/registry.json.
 */
export interface SessionRecord {
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
  tmuxName: string;
  /** realpath of the launch cwd (== worktree path if worktree). */
  cwd: string;
  worktreePath?: string;
  branch?: string;
  workspace: string;
  systemPromptMode?: SystemPromptMode;
  /** For pi: the session-dir passed at launch, used to glob the transcript. */
  sessionDir?: string;
  createdAt: string;
  /**
   * Lifecycle status. Absent (undefined) means alive/active. 'dead' marks a record
   * that was explicitly killed: it is KEPT in the registry (not deleted) so transcript
   * and metadata reads still resolve after kill (ARCHITECTURE: keep dead records for
   * transcript reads). Hidden from `agi list` by default; shown with --all/--dead.
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
}

export interface PaneInfo {
  name: string;
  pid: number;
  cwd: string;
  command: string;
  attached: boolean;
}
