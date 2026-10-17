/**
 * The MCP layer's bounds, in one dependency-free module (the CLI imports it without loading
 * the MCP SDK or zod).
 */

/** `wait`'s default bound (seconds): under the ~60 s tool-call timeouts of common MCP clients. */
export const DEFAULT_WAIT_TIMEOUT_SEC = 45;
/** `wait`'s upper bound on timeout_seconds (the CLI's own default). */
export const MAX_WAIT_TIMEOUT_SEC = 600;
/** `wait` accepts this many ids per call (each is one `orc wait` child process). */
export const MAX_WAIT_IDS = 16;
/** `read` / `workflow_logs` output bounds (characters). */
export const DEFAULT_MAX_CHARS = 16_000;
export const MAX_MAX_CHARS = 100_000;
/** A system prompt travels in argv (`--system-prompt=`): stay far below the per-argument limit. */
export const MAX_SYSTEM_PROMPT_CHARS = 32_000;
/**
 * CLI children the MCP layer runs at once, per process (each is a ~35-45 MB Bun process);
 * more calls queue. Shared by every caller, so no client can exhaust memory or pids.
 */
export const MAX_CLI_CHILDREN = 32;
