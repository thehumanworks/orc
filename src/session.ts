/**
 * Session handle. Wraps a SessionRecord with live operations against the driver
 * and provider adapter.
 */
import type { Driver } from './drivers/driver.ts';
import type { ProviderAdapter } from './providers/provider.ts';
import { getDriver } from './drivers/driver.ts';
import { getProvider } from './providers/provider.ts';
import { upsertRecord, removeRecord } from './registry.ts';
import { removeWorktree } from './worktree.ts';
import { parseTranscript } from './transcript.ts';
import type { Turn } from './transcript.ts';
import type { Provider, SessionRecord, SessionStatus } from './types.ts';

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const PASTE_SETTLE_MS = 200;
const SEND_MAX_ATTEMPTS = 3;

/**
 * A short prefix of the prompt's first non-empty line, used to verify the paste
 * actually landed in the input box before we submit. Whitespace is collapsed so
 * tmux's line-wrapping/indent doesn't cause a false negative; capped so long lines
 * (which the TUI may wrap) still match on their leading chunk.
 */
function pasteProbe(text: string): string | null {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.slice(0, 24);
}

/** Collapse whitespace in a pane capture so it can be matched against a probe. */
function normalizePane(pane: string): string {
  return pane.replace(/\s+/g, ' ');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Session {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: Provider;
  readonly tmuxName: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly workspace: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly createdAt: string;

  private record: SessionRecord;
  private readonly driver: Driver;
  private readonly adapter: ProviderAdapter;

  constructor(record: SessionRecord, driverName = 'tmux') {
    this.record = record;
    this.id = record.id;
    this.sessionId = record.sessionId;
    this.provider = record.provider;
    this.tmuxName = record.tmuxName;
    this.cwd = record.cwd;
    this.worktreePath = record.worktreePath;
    this.branch = record.branch;
    this.workspace = record.workspace;
    this.model = record.model;
    this.agentName = record.agentName;
    this.createdAt = record.createdAt;
    this.driver = getDriver(driverName);
    this.adapter = getProvider(record.provider);
  }

  async status(): Promise<SessionStatus> {
    return (await this.driver.isAlive(this.tmuxName)) ? 'running' : 'dead';
  }

  /** Whether the input box is rendered (boot complete). */
  private async isReady(): Promise<boolean> {
    const pane = await this.driver.capture(this.tmuxName);
    return this.adapter.readyMatch(pane);
  }

  /**
   * Boot loop: poll the visible pane; auto-confirm trust dialogs; wait for ready.
   * Returns true if ready within the timeout.
   */
  async waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let pane: string;
      try {
        pane = await this.driver.capture(this.tmuxName);
      } catch {
        // pane may not exist yet right after spawn.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (this.adapter.readyMatch(pane)) return true;
      // Auto-confirm ONLY the trust dialog. Never send Enter on any other interstitial:
      // codex's "Update available" banner defaults to "Update now", so an Enter there
      // would trigger a real self-update (BUG 2). Dismiss such interstitials with Escape;
      // if that fails, boot simply times out rather than ever accepting an update.
      if (this.adapter.trustDialogMatch(pane)) {
        await this.driver.sendKeys(this.tmuxName, 'Enter');
      } else if (this.adapter.interstitialMatch?.(pane)) {
        await this.driver.sendKeys(this.tmuxName, 'Escape');
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return this.isReady();
  }

  /**
   * Send a prompt. Multi-line safe: paste-buffer (bracketed) → settle → VERIFY the
   * text landed in the pane → Enter. The verify-before-submit loop (RESEARCH D.13)
   * is self-correcting: if the pane wasn't interactive yet (e.g. boot hooks still
   * running) and the paste was dropped, we re-paste rather than submit an empty box.
   * Ready-guarded so we never paste into an un-booted pane.
   */
  async send(prompt: string): Promise<void> {
    if (!(await this.isReady())) {
      const ok = await this.waitForReady();
      if (!ok) {
        throw new Error(`session ${this.id} is not ready to receive input`);
      }
    }
    // Strip a single trailing newline to avoid an accidental extra submit.
    const text = prompt.replace(/\n$/, '');
    const probe = pasteProbe(text);

    let landed = false;
    for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
      await this.driver.paste(this.tmuxName, text);
      await sleep(PASTE_SETTLE_MS);
      if (probe === null) {
        // Empty/whitespace prompt — nothing to verify; treat as landed.
        landed = true;
        break;
      }
      const pane = await this.driver.capture(this.tmuxName);
      if (normalizePane(pane).includes(probe)) {
        landed = true;
        break;
      }
      // Not visible yet — give the TUI a moment, then re-paste.
      await sleep(POLL_INTERVAL_MS);
    }

    if (!landed) {
      throw new Error(
        `session ${this.id}: prompt did not appear in the input box after ${SEND_MAX_ATTEMPTS} attempts`,
      );
    }
    await this.driver.sendKeys(this.tmuxName, 'Enter');
  }

  async capture(opts?: { scrollback?: boolean }): Promise<string> {
    return this.driver.capture(this.tmuxName, opts);
  }

  /** Resolve the on-disk transcript path. Caches the discovered codex id. */
  async transcript(): Promise<string | null> {
    // Prefer a path persisted at kill time: after kill the tmux session and (for a
    // worktree) the cwd may be gone, so live re-discovery would fail — but the
    // ~/.codex / ~/.claude file persists, and we recorded its path (BUG 3).
    if (this.record.transcriptPath) {
      if (await Bun.file(this.record.transcriptPath).exists()) {
        return this.record.transcriptPath;
      }
    }
    const file = await this.adapter.resolveTranscript(this.record);
    if (file && this.provider === 'codex' && !this.record.transcriptSessionId) {
      // Best-effort: derive the codex session id from the filename for the record.
      const m = file.match(/rollout-[^_]*-([0-9a-fA-F-]{36})\.jsonl$/);
      if (m && m[1]) {
        this.record.transcriptSessionId = m[1];
        await upsertRecord(this.record).catch(() => {});
      }
    }
    return file;
  }

  async readTranscript(): Promise<string | null> {
    const file = await this.transcript();
    if (!file) return null;
    const f = Bun.file(file);
    if (!(await f.exists())) return null;
    return f.text();
  }

  /**
   * Parse the on-disk transcript into token-efficient turns (conversation text plus
   * one-line tool-call summaries; no raw tool output, reasoning, or UI chrome). This
   * is the SDK mirror of the default `agi read`. Returns `[]` when no transcript is
   * on disk yet (e.g. just booted) — callers wanting a live view should `capture()`.
   */
  async readParsed(): Promise<Turn[]> {
    const jsonl = await this.readTranscript();
    if (!jsonl) return [];
    return parseTranscript(this.provider, jsonl);
  }

  attachCommand(opts?: { readOnly?: boolean }): string {
    return this.driver.attachCommand(this.tmuxName, opts);
  }

  /**
   * Kill the session. By default the registry record is KEPT and marked dead so
   * transcript + metadata reads still resolve afterwards (BUG 3). Pass `purge: true`
   * to remove the record entirely. `removeWorktree` removes the git worktree.
   */
  async kill(opts?: { removeWorktree?: boolean; purge?: boolean }): Promise<void> {
    // Resolve + persist the transcript path BEFORE we tear anything down. For codex
    // the rollout file is matched by cwd+mtime, so we must capture it while the cwd
    // (and any worktree) still exists; for a worktree the cwd disappears below.
    if (!this.record.transcriptPath) {
      const file = await this.transcript().catch(() => null);
      if (file) this.record.transcriptPath = file;
    }

    await this.driver.kill(this.tmuxName);
    if (opts?.removeWorktree && this.record.worktreePath) {
      await removeWorktree(this.record.workspace, this.record.worktreePath).catch(() => {});
    }

    if (opts?.purge) {
      await removeRecord(this.id);
      return;
    }
    // Mark dead but keep the record (transcript reads stay resolvable).
    this.record.status = 'dead';
    this.record.killedAt = new Date().toISOString();
    await upsertRecord(this.record);
  }

  toJSON(): SessionRecord {
    return { ...this.record };
  }
}
