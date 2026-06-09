/**
 * pi adapter. -a trust flag (no trust dialog); --session-id + --session-dir;
 * system prompt via --append-system-prompt; transcript glob <dir>/*_<sid>.jsonl.
 */
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';
import { literalPasteLanded, normalizePane } from '../paste.ts';

/**
 * pi collapses a large bracketed paste into a chip like `[paste #1 +93 lines]` (the
 * literal text is NOT rendered). Verified live (pi 0.79.0). The chip is the "landed"
 * signal for multi-KB prompts.
 */
const PASTE_CHIP_RE = /\[paste #\d+ \+\d+ lines?\]/;

/**
 * pi's ready composer renders two `────` horizontal borders with an empty input line
 * between, and a bottom BUDGET-METER line like
 *   `$0.000 (sub) 0.0%/200k (auto) … grok-composer-2.5-fast`
 * The stable, composer-only marker in that line is the percent-of-budget token
 * (`0.0%/200k`): a number, then `%/`, then a `<n>k` cap. It is ABSENT during early boot
 * and PRESENT once the composer is live (verified live, pi 0.79.0).
 */
const BUDGET_METER_RE = /\d+(?:\.\d+)?%\/\d+k/;

/**
 * pi's working indicator: a Braille spinner frame (U+2800–U+28FF) followed by
 * ` Working...` (e.g. `⠋ Working...`), shown at the bottom while a turn is in progress
 * and ABSENT on the idle composer. Captured live (pi 0.79.0) from the VISIBLE pane —
 * note pi has NO `esc to interrupt` working hint (its `escape interrupt` text lives only
 * in the boot banner, which scrolls out of the visible pane), so that is NOT usable. The
 * spinner-anchored form avoids matching a stray "Working" in assistant prose.
 */
const WORKING_RE = /[⠀-⣿] Working/;

export class PiAdapter implements ProviderAdapter {
  readonly name = 'pi' as const;

  async prepare(_ctx: BuildCtx): Promise<void> {
    // pi needs no cwd prep; session-dir is created by the caller.
  }

  buildArgv(ctx: BuildCtx): string[] {
    const argv = ['pi', '-a'];
    if (ctx.model) argv.push('--model', ctx.model);
    if (ctx.systemPrompt) {
      if (ctx.systemPromptMode === 'replace') {
        argv.push('--system-prompt', ctx.systemPrompt);
      } else {
        argv.push('--append-system-prompt', ctx.systemPrompt);
      }
    }
    argv.push('--session-id', ctx.sessionId);
    argv.push('--session-dir', ctx.sessionDir);
    return argv;
  }

  readyMatch(pane: string): boolean {
    // BUG: the old check (`pane.includes('│') || '❯' || '>'`) did NOT match pi's
    // composer — it has none of those chars — so `agi send` threw "not ready" and
    // prompts were lost. The reliable marker is the bottom budget-meter line.
    return BUDGET_METER_RE.test(pane);
  }

  busyMatch(pane: string): boolean {
    // pi's working indicator is the spinner-prefixed `Working...` line (see WORKING_RE).
    // It is present throughout a turn and absent on the idle composer (captured live,
    // pi 0.79.0). The budget meter (readyMatch) is present in BOTH states, so the
    // classifier checks busy before ready.
    return WORKING_RE.test(pane);
  }

  trustDialogMatch(_pane: string): boolean {
    // pi -a has no trust dialog.
    return false;
  }

  pasteLanded(pane: string, text: string): boolean {
    // Small paste → literal end-probe; large paste → the collapsed chip.
    return literalPasteLanded(pane, text) || PASTE_CHIP_RE.test(normalizePane(pane));
  }

  clearInputKeys(): string[] {
    // Ctrl-U clears the whole composer (even a collapsed paste chip) and is SAFE — unlike
    // Ctrl-C, which QUITS pi. Verified live: chip gone, session alive.
    return ['C-u'];
  }

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    const dir = rec.sessionDir;
    if (!dir) return null;
    const glob = new Bun.Glob(`*_${rec.sessionId}.jsonl`);
    for await (const match of glob.scan({ cwd: dir, absolute: true })) {
      return match;
    }
    return null;
  }
}
