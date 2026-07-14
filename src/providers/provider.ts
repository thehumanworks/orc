/**
 * ProviderAdapter interface + factory. Each provider knows its yolo argv, its
 * boot/trust matchers, and how to resolve its on-disk transcript.
 */
import type { Provider, SessionRecord, SystemPromptMode } from '../types.ts';

export interface BuildCtx {
  model?: string;
  /** The uuid we generate at spawn. claude/pi pass it as --session-id. */
  sessionId: string;
  /** Resolved system prompt text (already merged from agentName body if needed). */
  systemPrompt?: string;
  systemPromptMode: SystemPromptMode;
  /** Bare agent name (claude native --agent). */
  agentName?: string;
  /** realpath of the launch cwd. */
  cwd: string;
  /** Per-session dir for providers that need one (pi). */
  sessionDir: string;
  /**
   * Absolute path under orc-owned state for Codex persona injection
   * (`experimental_instructions_file`). Outside the repo/worktree.
   */
  instructionsPath?: string;
}

export interface ProviderAdapter {
  name: Provider;
  /**
   * Provider prep before spawn (e.g. codex writes an orc-owned instructions file
   * outside the cwd — never mutates the user's AGENTS.md).
   */
  prepare(ctx: BuildCtx): Promise<void>;
  /** yolo interactive argv (NO positional prompt — it's injected post-boot). */
  buildArgv(ctx: BuildCtx): string[];
  /** True when the input box has rendered (boot complete). Matches VISIBLE pane. */
  readyMatch(pane: string): boolean;
  /**
   * True when the provider's "actively working" indicator is present (a turn is in
   * progress). Matches the VISIBLE pane. Used by `Session.state()` to distinguish
   * `running` from `done`. NOTE: claude/codex render BOTH this and `readyMatch`'s
   * footer mid-turn, so the classifier checks `busyMatch` before `readyMatch`.
   */
  busyMatch(pane: string): boolean;
  /** True when a first-run trust dialog is showing and needs an Enter to confirm. */
  trustDialogMatch(pane: string): boolean;
  /**
   * True when a non-trust interstitial is showing that the boot loop must DISMISS
   * (Escape) rather than confirm — e.g. codex's "Update available" banner, whose
   * default action is a self-update. Optional; providers without one omit it.
   */
  interstitialMatch?(pane: string): boolean;
  /**
   * Confirm our pasted prompt actually landed in the composer, given a fresh pane
   * capture and the exact text we pasted. Matches EITHER regime (see `src/paste.ts`):
   * the literal end-probe (small paste shown verbatim) OR this provider's collapsed
   * paste chip (large/multi-line paste — the literal text is NOT rendered). Used by
   * `Session.send()`'s verify-before-submit loop.
   */
  pasteLanded(pane: string, text: string): boolean;
  /**
   * Safe key sequence (tmux key names) to CLEAR a non-empty composer before a re-paste,
   * so a failed send attempt can't stack the prompt 2–3×. MUST be safe — NEVER a key
   * that interrupts/exits the TUI (e.g. NEVER Ctrl-C on pi: it quits). Optional; omit
   * when no safe clear exists (send() then leans on the end-probe to make retries rare).
   */
  clearInputKeys?(): string[];
  /** Resolve the on-disk transcript path for a launched session. */
  resolveTranscript(rec: SessionRecord): Promise<string | null>;
}

import { ClaudeAdapter } from './claude.ts';
import { CodexAdapter } from './codex.ts';
import { PiAdapter } from './pi.ts';

const adapters: Record<Provider, () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  pi: () => new PiAdapter(),
};

export function getProvider(name: Provider): ProviderAdapter {
  const make = adapters[name];
  if (!make) {
    throw new Error(`unknown provider '${name}' (expected claude|codex|pi)`);
  }
  return make();
}

export const PROVIDERS: Provider[] = ['claude', 'codex', 'pi'];
