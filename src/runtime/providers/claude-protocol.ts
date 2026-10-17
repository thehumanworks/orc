/**
 * Vendored, trimmed wire types for claude's structured stdio protocol:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
 *
 * Verified against Claude Code CLI **2.1.299** (live probes, 2026-10-14) and re-verified,
 * shapes identical, against **2.1.300** (2026-10-15). Shapes mirrored
 * from `@anthropic-ai/claude-agent-sdk@0.3.299` `sdk.d.ts` (no runtime dependency — orc speaks
 * the wire protocol directly). Only the messages and fields orc reads or writes are listed;
 * every other field or message type the CLI sends is ignored (forward compatibility), so
 * all stdout shapes are deliberately loose (`[k: string]: unknown`).
 */

/**
 * CLI version this file (and the live contract test) was last verified against. Purely
 * informational: the runtime never refuses another version (it only reports the running
 * one in `ready.info.claude_code_version`); the live suite flags drift in ONE dedicated test.
 */
export const CLAUDE_PROTOCOL_VERIFIED_VERSION = '2.1.300';

// ---------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

/** Content blocks orc looks at; `thinking`, `tool_use`, `tool_result`… are skipped. */
export type ClaudeContentBlock = ClaudeTextBlock | { type: string; [k: string]: unknown };

/** Per-turn token usage as reported on `result.usage` (snake_case on the wire). */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

/** SDK `TerminalReason` (subset observed + the ones orc reasons about). Open union. */
export type ClaudeTerminalReason =
  | 'completed'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'max_turns'
  | 'budget_exhausted'
  | 'api_error'
  | 'model_error'
  | 'prompt_too_long'
  | (string & {});

// ---------------------------------------------------------------------------------
// stdin: orc → claude
// ---------------------------------------------------------------------------------

/** SDKUserMessage as written on stdin. `uuid` = orc messageId (any string; ULIDs accepted). */
export interface ClaudeUserInput {
  type: 'user';
  message: { role: 'user'; content: string | ClaudeContentBlock[] };
  parent_tool_use_id: null;
  session_id?: string;
  uuid: string;
}

export type ClaudeControlRequestInner =
  | { subtype: 'initialize' }
  | { subtype: 'interrupt'; cancel_queued?: boolean }
  | {
      subtype: 'can_use_tool';
      tool_name?: string;
      display_name?: string;
      input?: Record<string, unknown>;
      description?: string;
      [k: string]: unknown;
    }
  | { subtype: string; [k: string]: unknown };

/** Envelope for a control request (either direction). `request_id` is the sender's. */
export interface ClaudeControlRequest {
  type: 'control_request';
  request_id: string;
  request: ClaudeControlRequestInner;
}

export interface ClaudeControlSuccess {
  subtype: 'success';
  request_id: string;
  response?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ClaudeControlError {
  subtype: 'error';
  request_id: string;
  error?: string;
  [k: string]: unknown;
}

/** Envelope for the single reply to a control_request. Payload is nested under `response`. */
export interface ClaudeControlResponse {
  type: 'control_response';
  response: ClaudeControlSuccess | ClaudeControlError;
}

/** Answer to an inbound `can_use_tool` request (orc only ever denies; see decision 6). */
export interface ClaudePermissionDecision {
  behavior: 'deny';
  message: string;
  interrupt: boolean;
}

/** Interesting fields of the `initialize` success payload. `account` is never stored. */
export interface ClaudeInitializeResponse {
  pid?: number;
  claude_code_version?: string;
  session_state?: string;
  current_permission_mode?: string;
  capabilities?: string[];
  account?: unknown;
  [k: string]: unknown;
}

/** Interrupt success payload: commands that survived the interrupt (they still run). */
export interface ClaudeInterruptResponse {
  still_queued?: string[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------------
// stdout: claude → orc
// ---------------------------------------------------------------------------------

/** `system/init` — emitted per TURN (not per process), first after the first user line. */
export interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  claude_code_version?: string;
  agents?: string[];
  skills?: string[];
  tools?: string[];
  capabilities?: string[];
  uuid?: string;
  [k: string]: unknown;
}

export interface ClaudeSystemOther {
  type: 'system';
  subtype: string;
  [k: string]: unknown;
}

/** Only emitted with `--replay-user-messages`. `command_uuid` = our wire uuid. */
export interface ClaudeCommandLifecycle {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | (string & {});
  uuid?: string;
  session_id?: string;
}

/**
 * `user` on stdout: either our replayed line (`isReplay: true`, same uuid) or a live
 * user-role line (tool results, `[Request interrupted by user]` marker) — never an ack.
 */
export interface ClaudeUserOutput {
  type: 'user';
  message?: { role?: string; content?: string | ClaudeContentBlock[] };
  parent_tool_use_id?: string | null;
  uuid?: string;
  isReplay?: boolean;
  [k: string]: unknown;
}

export interface ClaudeAssistant {
  type: 'assistant';
  message?: { content?: ClaudeContentBlock[]; [k: string]: unknown };
  /** non-null → a subagent line. */
  parent_tool_use_id?: string | null;
  user_message_uuid?: string;
  user_message_uuids?: string[];
  error?: unknown;
  [k: string]: unknown;
}

/** Exactly one per turn: the turn-complete signal. */
export interface ClaudeResult {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | (string & {});
  is_error?: boolean;
  terminal_reason?: ClaudeTerminalReason;
  /** Final text; absent on error results. */
  result?: string;
  /** Diagnostics on error results — not parsed, only reported. */
  errors?: string[];
  /** CUMULATIVE per process (a resumed process includes the transcript's saved spend). */
  total_cost_usd?: number;
  /** Per turn. */
  usage?: ClaudeUsage;
  user_message_uuid?: string;
  user_message_uuids?: string[];
  session_id?: string;
  [k: string]: unknown;
}

export interface ClaudeControlCancelRequest {
  type: 'control_cancel_request';
  request_id: string;
}

export type ClaudeStdoutMessage =
  | ClaudeControlResponse
  | ClaudeControlRequest
  | ClaudeControlCancelRequest
  | ClaudeCommandLifecycle
  | ClaudeUserOutput
  | ClaudeAssistant
  | ClaudeResult
  | ClaudeSystemInit
  | ClaudeSystemOther
  /** stream_event, rate_limit_event, keep_alive, active_goal, … and future types. */
  | { type: string; [k: string]: unknown };

/** Parse one stdout line. Non-JSON / non-object / typeless lines → null (skipped). */
export function parseClaudeLine(line: string): ClaudeStdoutMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  if (typeof (v as { type?: unknown }).type !== 'string') return null;
  return v as ClaudeStdoutMessage;
}
