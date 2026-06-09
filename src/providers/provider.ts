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
}

export interface ProviderAdapter {
  name: Provider;
  /** Prepare cwd before spawn (e.g. codex writes AGENTS.md). */
  prepare(ctx: BuildCtx): Promise<void>;
  /** yolo interactive argv (NO positional prompt — it's injected post-boot). */
  buildArgv(ctx: BuildCtx): string[];
  /** True when the input box has rendered (boot complete). Matches VISIBLE pane. */
  readyMatch(pane: string): boolean;
  /** True when a first-run trust dialog is showing and needs an Enter to confirm. */
  trustDialogMatch(pane: string): boolean;
  /**
   * True when a non-trust interstitial is showing that the boot loop must DISMISS
   * (Escape) rather than confirm — e.g. codex's "Update available" banner, whose
   * default action is a self-update. Optional; providers without one omit it.
   */
  interstitialMatch?(pane: string): boolean;
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
