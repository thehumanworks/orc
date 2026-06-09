/**
 * codex adapter. No --session-id; system prompt via AGENTS.md in cwd; transcript
 * discovered by cwd + mtime>createdAt across ~/.codex/sessions/Y/M/D/.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';

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

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    const base = path.join(os.homedir(), '.codex', 'sessions');
    const createdAtMs = Date.parse(rec.createdAt);
    const targetCwd = rec.cwd;

    const glob = new Bun.Glob('*/*/*/rollout-*.jsonl');
    const candidates: { file: string; mtimeMs: number }[] = [];
    for await (const file of glob.scan({ cwd: base, absolute: true })) {
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      if (Number.isFinite(createdAtMs) && st.mtimeMs <= createdAtMs - 2000) continue;
      candidates.push({ file, mtimeMs: st.mtimeMs });
    }
    // Newest first.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file } of candidates) {
      const meta = await readSessionMeta(file);
      if (!meta) continue;
      if (meta.cwd === targetCwd) {
        return file;
      }
    }
    return null;
  }
}

/** Read the first JSONL line of a codex rollout and extract session_meta payload. */
async function readSessionMeta(file: string): Promise<{ id?: string; cwd?: string } | null> {
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
      payload?: { id?: string; cwd?: string };
    };
    if (obj.type === 'session_meta' && obj.payload) {
      return { id: obj.payload.id, cwd: obj.payload.cwd };
    }
  } catch {
    return null;
  }
  return null;
}
