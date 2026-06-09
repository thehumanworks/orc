/**
 * claude adapter. Native --agent, --session-id; transcript by globbing the sid.
 */
import os from 'node:os';
import path from 'node:path';
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';
import { literalPasteLanded, normalizePane } from '../paste.ts';

/**
 * claude collapses a large bracketed paste into a chip like `❯ [Pasted text #1 +92 lines]`
 * (the literal text is NOT rendered). Verified live (claude 2.1.x). The chip is the
 * "landed" signal for multi-KB prompts.
 */
const PASTE_CHIP_RE = /\[Pasted text #\d+ \+\d+ lines?\]/;

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;

  async prepare(_ctx: BuildCtx): Promise<void> {
    // claude needs no cwd prep.
  }

  buildArgv(ctx: BuildCtx): string[] {
    const argv = ['claude', '--dangerously-skip-permissions'];
    if (ctx.model) argv.push('--model', ctx.model);
    if (ctx.agentName) {
      // Native named agent.
      argv.push('--agent', ctx.agentName);
    } else if (ctx.systemPrompt) {
      if (ctx.systemPromptMode === 'replace') {
        argv.push('--system-prompt', ctx.systemPrompt);
      } else {
        argv.push('--append-system-prompt', ctx.systemPrompt);
      }
    }
    argv.push('--session-id', ctx.sessionId);
    return argv;
  }

  readyMatch(pane: string): boolean {
    // Require the bypass-permissions footer. Do NOT fall back to a bare '❯' — the
    // trust dialog's selection cursor ('❯ 1. Yes, I trust this folder') contains
    // '❯', and the boot loop checks readyMatch before trustDialogMatch.
    return pane.includes('bypass permissions on');
  }

  busyMatch(pane: string): boolean {
    // While a turn is in progress, claude's bottom bar reads
    //   `⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`
    // — the literal `esc to interrupt` is the working indicator. When idle/done it is
    // ABSENT (the bar reads `… · ← for agents`). Note the ready footer
    // (`bypass permissions on`) is present in BOTH states, so the classifier checks
    // busy before ready. (Verified live, claude 2.1.170.)
    return pane.includes('esc to interrupt');
  }

  trustDialogMatch(pane: string): boolean {
    return (
      pane.includes('trust this folder') ||
      pane.includes('Is this a project you created') ||
      pane.includes('Do you trust the files in this folder')
    );
  }

  pasteLanded(pane: string, text: string): boolean {
    // Small paste → literal end-probe; large paste → the collapsed chip.
    return literalPasteLanded(pane, text) || PASTE_CHIP_RE.test(normalizePane(pane));
  }

  clearInputKeys(): string[] {
    // Ctrl-U clears the whole composer (even a collapsed paste chip) and never exits.
    // Verified live: chip gone, session alive, "Ctrl+Y to paste deleted text" hint shown.
    return ['C-u'];
  }

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    // glob ~/.claude/projects/*/<sid>.jsonl — do NOT recompute the slug. claude DOES
    // honor our --session-id (the file IS named <sid>.jsonl), so the glob is correct.
    //
    // Verified live (claude 2.1.170): for an orc-launched INTERACTIVE session this file
    // DOES contain the real `user`/`assistant` turns, appended as the conversation
    // progresses (alongside `ai-title`/bookkeeping events). An earlier comment here
    // claimed the file was title-only and that turns were never on disk for interactive
    // sessions — that was WRONG. The default parsed `agi read` parses these turns; the
    // raw pane (`agi read --raw`) remains available as the escape hatch.
    const base = path.join(os.homedir(), '.claude', 'projects');
    const glob = new Bun.Glob(`*/${rec.sessionId}.jsonl`);
    for await (const match of glob.scan({ cwd: base, absolute: true })) {
      return match;
    }
    return null;
  }
}
