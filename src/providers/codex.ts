/**
 * codex adapter. No --session-id; system prompt via AGENTS.md in cwd; transcript
 * discovered by cwd + mtime>createdAt across ~/.codex/sessions/Y/M/D/.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';
import { literalPasteLanded, normalizePane } from '../paste.ts';

/**
 * codex collapses a large bracketed paste into a chip like `› [Pasted Content 12295 chars]`
 * (the literal text is NOT rendered). Verified live (codex-cli 0.138.0). The chip is the
 * "landed" signal for multi-KB prompts.
 */
const PASTE_CHIP_RE = /\[Pasted Content \d+ chars?\]/;

/**
 * codex's bottom status line: a model token, then ' · ' (U+00B7 with surrounding
 * spaces), then the cwd path (possibly with a truncating '…', and possibly followed
 * by ' · <branch>'). Present only when the composer is live; absent from the trust
 * dialog and update interstitial. The path is ABSOLUTE for dirs outside $HOME
 * (`gpt-5.5 high · /private/var/.../repo`) but HOME-RELATIVE with a leading '~' for
 * dirs under $HOME (`gpt-5.5 xhigh · ~/projects/orc · Main [default]`), so accept
 * either '/' or '~' after the dot (verified live, codex-cli 0.138.0).
 */
const STATUS_LINE_RE = /\S[ \t]·[ \t][~/]/;

export class CodexAdapter implements ProviderAdapter {
  readonly name = 'codex' as const;

  async prepare(ctx: BuildCtx): Promise<void> {
    // Inject persona/system prompt as AGENTS.md (auto-loaded, also user-visible).
    if (ctx.systemPrompt && ctx.systemPrompt.trim().length > 0) {
      const target = path.join(ctx.cwd, 'AGENTS.md');
      try {
        await fs.access(target);
        throw new Error(
          `refusing to overwrite existing AGENTS.md in ${ctx.cwd}; orc injects a Codex persona there on spawn — remove the file or use a different cwd`,
        );
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('refusing to overwrite')) throw e;
        /* ENOENT — safe to write */
      }
      await Bun.write(target, `${ctx.systemPrompt.trim()}\n`);
    }
  }

  buildArgv(ctx: BuildCtx): string[] {
    const argv = ['codex', '--dangerously-bypass-approvals-and-sandbox'];
    if (ctx.model) argv.push('-m', ctx.model);
    return argv;
  }

  readyMatch(pane: string): boolean {
    // A bare '›' is NOT a reliable ready marker: it's also the selection cursor on
    // the trust dialog ('› 1. Yes, continue') and would appear on the "Update
    // available" interstitial too, so the old check reported ready prematurely (BUG 2).
    //
    // The stable ready signal is codex's bottom STATUS LINE, which only renders once
    // the composer is live and survives the top welcome box scrolling away:
    //     gpt-5.5 high · /private/.../repo
    // i.e. a model token, then ' · ' (U+00B7 surrounded by spaces), then an absolute
    // path. The placeholder composer hint ('Find and fix a bug in @filename') ROTATES
    // across a set of tips, so we must NOT key off it. Guard against the dialogs/
    // interstitials explicitly so none of them is ever mistaken for ready.
    if (this.trustDialogMatch(pane) || this.interstitialMatch(pane)) return false;
    return STATUS_LINE_RE.test(pane);
  }

  busyMatch(pane: string): boolean {
    // While a turn is in progress, codex shows a working line like
    //   `• Working (3s • esc to interrupt)`
    // — the literal `esc to interrupt` is the working indicator. When done that line
    // is gone, leaving only the status line (`gpt-5.5 xhigh · /path`), which
    // `readyMatch` keys off. The status line is present in BOTH states, so the
    // classifier checks busy before ready. (Verified live, codex-cli 0.138.0.)
    return pane.includes('esc to interrupt');
  }

  trustDialogMatch(pane: string): boolean {
    // Match the QUESTION, not the option label: "Yes, continue" is a substring of the
    // full-access dialog's "Yes, continue anyway", so keying off the label would
    // over-match. The directory-trust question text is specific and stable.
    return pane.includes('Do you trust the contents of this directory');
  }

  /**
   * codex's "Update available!" interstitial. Its DEFAULT option is "Update now",
   * so the boot loop must NEVER send Enter here — that would trigger a real
   * self-update. The boot loop dismisses it with Escape and only auto-confirms the
   * trust dialog; even if Escape fails, boot times out rather than auto-updating.
   */
  interstitialMatch(pane: string): boolean {
    return pane.includes('Update available') || pane.includes('Update now (runs');
  }

  pasteLanded(pane: string, text: string): boolean {
    // Small paste → literal end-probe; large paste → the collapsed chip.
    return literalPasteLanded(pane, text) || PASTE_CHIP_RE.test(normalizePane(pane));
  }

  clearInputKeys(): string[] {
    // Ctrl-U clears the whole composer (even a collapsed paste chip) and never exits.
    // Verified live: chip gone (placeholder hint returns), session alive.
    return ['C-u'];
  }

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    const base = path.join(os.homedir(), '.codex', 'sessions');
    const createdAtMs = Date.parse(rec.createdAt);
    const targetCwd = rec.cwd;

    const glob = new Bun.Glob('*/*/*/rollout-*.jsonl');
    const candidates: { file: string; sortMs: number; priority: number }[] = [];
    for await (const file of glob.scan({ cwd: base, absolute: true })) {
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      const meta = await readSessionMeta(file);
      if (!meta) continue;
      if (meta.cwd !== targetCwd) continue;

      if (rec.transcriptSessionId && meta.id === rec.transcriptSessionId) {
        return file;
      }

      const startedAtMs = Date.parse(meta.timestamp ?? '');
      if (Number.isFinite(createdAtMs) && Number.isFinite(startedAtMs)) {
        // Multiple codex sessions can share a cwd; mtime then points at whichever
        // session wrote most recently. The session_meta timestamp is the stable launch
        // time, so prefer the transcript whose launch is nearest this orc spawn.
        if (startedAtMs < createdAtMs - 5000) continue;
        candidates.push({ file, sortMs: startedAtMs, priority: 0 });
        continue;
      }

      // Older rollout shapes may not have a timestamp; keep the historical mtime guard
      // as a fallback, but rank it behind timestamped candidates.
      if (Number.isFinite(createdAtMs) && st.mtimeMs <= createdAtMs - 2000) continue;
      candidates.push({ file, sortMs: st.mtimeMs, priority: 1 });
    }

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (Number.isFinite(createdAtMs)) {
        return Math.abs(a.sortMs - createdAtMs) - Math.abs(b.sortMs - createdAtMs);
      }
      return b.sortMs - a.sortMs;
    });

    if (candidates[0]) {
      return candidates[0].file;
    }
    return null;
  }
}

/** Read the first JSONL line of a codex rollout and extract session_meta payload. */
async function readSessionMeta(
  file: string,
): Promise<{ id?: string; cwd?: string; timestamp?: string } | null> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    return null;
  }
  const firstLine = text.split('\n', 1)[0];
  if (!firstLine) return null;
  try {
    const obj = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string; cwd?: string; timestamp?: string };
    };
    if (obj.type === 'session_meta' && obj.payload) {
      return { id: obj.payload.id, cwd: obj.payload.cwd, timestamp: obj.payload.timestamp };
    }
  } catch {
    return null;
  }
  return null;
}
