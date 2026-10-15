/**
 * Vendored, hand-trimmed wire types for `codex app-server` (JSON-RPC 2.0 over stdio JSONL).
 *
 * Verified against: codex-cli 0.162.1 (`codex app-server generate-ts` output, plus live
 * captures against a stub Responses API). Only the shapes orc's codex runtime actually
 * reads or writes are kept; fields orc ignores are dropped or typed loosely. When bumping
 * codex, regenerate the schema, diff the types below, and re-run the contract tests in
 * test/runtime-codex.test.ts.
 *
 * Framing notes (verified): one JSON object per `\n`-terminated line; neither requests nor
 * responses carry `"jsonrpc"`. Server→client requests use the server's own id counter.
 */

/** Codex CLI version these types were verified against. */
export const CODEX_PROTOCOL_VERIFIED_VERSION = '0.162.1';

// ---------------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------------

export type RequestId = string | number;

export interface RpcRequest<P = unknown> {
  method: string;
  id: RequestId;
  params?: P;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------------

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

/** `capabilities` is omitted by orc (experimentalApi is not needed). */
export interface InitializeParams {
  clientInfo: ClientInfo;
}

export interface InitializeResponse {
  userAgent: string;
  /** Absolute path of the server's $CODEX_HOME. */
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ---------------------------------------------------------------------------------
// thread/start, thread/resume
// ---------------------------------------------------------------------------------

/** Input spelling (kebab-case). The response uses the camelCase SandboxPolicy instead. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: Record<string, boolean> };

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  /** Replaces the built-in base prompt. */
  baseInstructions?: string | null;
  /** Appended as a developer-role message after the base prompt. */
  developerInstructions?: string | null;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  /** true → return metadata only (no full-history hydration). */
  excludeTurns?: boolean;
}

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export interface Thread {
  id: string;
  /** Absolute rollout path (`$CODEX_HOME/sessions/Y/M/D/rollout-*.jsonl`); null if ephemeral. */
  path: string | null;
  cwd: string;
  cliVersion: string;
  model: string | null;
  modelProvider: string;
  status: ThreadStatus;
}

/** Shared subset of ThreadStartResponse / ThreadResumeResponse. */
export interface ThreadOpenResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  /** camelCase SandboxPolicy, e.g. `{ type: "dangerFullAccess" }`. */
  sandbox: { type: string } & Record<string, unknown>;
  reasoningEffort?: string | null;
}

// ---------------------------------------------------------------------------------
// turn/start, turn/interrupt
// ---------------------------------------------------------------------------------

export interface TextUserInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
  /** Echoed back as `item.clientId` on the userMessage item. */
  clientUserMessageId?: string | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  /** A string ("other", "internalServerError") or an object; opaque to orc. */
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  durationMs: number | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type TurnInterruptResponse = Record<string, never>;

// ---------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------

export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer';

export interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: MessagePhase | null;
}

export interface UserMessageItem {
  type: 'userMessage';
  id: string;
  clientId: string | null;
  content: unknown[];
}

/** Every other item type (commandExecution, fileChange, reasoning, …) is opaque to orc. */
export interface OtherItem {
  type: string;
  id: string;
}

export type ThreadItem = AgentMessageItem | UserMessageItem | OtherItem;

// ---------------------------------------------------------------------------------
// Server notifications orc reads
// ---------------------------------------------------------------------------------

export interface TurnNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null };
}

export interface ErrorNotification {
  error: TurnError;
  /** true → transient (codex retries); the outcome still arrives as turn/completed. */
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

/** Notification method names orc maps (everything else is raw-log only). */
export const NOTIFY = {
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  error: 'error',
} as const;

// ---------------------------------------------------------------------------------
// Server → client requests and the safe (never-accepting) replies orc sends
// ---------------------------------------------------------------------------------

export const SERVER_REQUEST = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  toolUserInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
  dynamicToolCall: 'item/tool/call',
  /** Legacy v1 approvals (not expected on the v2 path). */
  legacyApplyPatchApproval: 'applyPatchApproval',
  legacyExecCommandApproval: 'execCommandApproval',
} as const;

/** Reply to command/fileChange approvals. `decline` lets the model continue (verified). */
export interface ApprovalDecisionResponse {
  decision: 'decline';
}

/** Reply to `item/permissions/requestApproval`: grant nothing for this turn. */
export interface PermissionsApprovalResponse {
  permissions: Record<string, never>;
  scope: 'turn';
}

/** Reply to legacy v1 approvals (`ReviewDecision`). */
export interface LegacyReviewDecisionResponse {
  decision: { denied: { rejection: string } };
}

/** JSON-RPC "method not found" — used for every server request orc does not handle. */
export const RPC_METHOD_NOT_FOUND = -32601;
