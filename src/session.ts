/**
 * Session handle. Wraps a SessionRecord with live operations against the driver
 * and provider adapter.
 */
import type { Driver } from './drivers/driver.ts';
import type { ProviderAdapter } from './providers/provider.ts';
import { getDriver } from './drivers/driver.ts';
import { getProvider } from './providers/provider.ts';
import { upsertRecord, removeRecord } from './registry.ts';
import { removeSessionInstructions } from './session-files.ts';
import { removeWorktree } from './worktree.ts';
import { parseTranscript } from './transcript.ts';
import type { Turn } from './transcript.ts';
import { classifyState, reduceWait, INITIAL_TRACKING } from './state.ts';
import type { WaitTracking } from './state.ts';
import { pasteProbe } from './paste.ts';
import { withLock } from './lock.ts';
import {
  evaluateDeliveryReplay,
  hashPayload,
  persistDelivery,
  readDelivery,
  toSendResult,
} from './messages.ts';
import type { DeliveryRecord, SendOptions, SendResult } from './messages.ts';
import { assertValidMessageId } from './paths.ts';
import type { AgentState, Provider, SessionRecord, SessionStatus } from './types.ts';
import { releaseSessionPolicy } from './lineage.ts';

export type { SendOptions, SendResult } from './messages.ts';

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const PASTE_SETTLE_MS = 200;
const SEND_MAX_ATTEMPTS = 3;
/** Bounded ack wait — provider-neutral evidence only; never spin forever. */
const ACK_TIMEOUT_MS = 2_000;
const ACK_POLL_MS = 100;

const DEFAULT_WAIT_UNTIL: AgentState[] = ['done', 'waiting', 'failed'];
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_POLL_MS = 1000;

export interface WaitForOptions {
  /** States that count as "settled enough to return". Default done/waiting/failed. */
  until?: AgentState[];
  /** Give up after this long and return the last observed state. Default 600000. */
  timeoutMs?: number;
  /** Interval between polls. Default 1000. */
  pollMs?: number;
}

export interface WaitForResult {
  /** The state that settled, or the last observed state on timeout. */
  state: AgentState;
  /** True only when the debounce actually observed a requested state long enough. */
  settled: boolean;
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
  readonly alias?: string;
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
    this.alias = record.alias;
    this.createdAt = record.createdAt;
    this.driver = getDriver(driverName);
    this.adapter = getProvider(record.provider);
  }

  async status(): Promise<SessionStatus> {
    return (await this.driver.isAlive(this.tmuxName)) ? 'running' : 'dead';
  }

  /**
   * Classify the current agent state from driver liveness + a SINGLE pane capture.
   * Thin wrapper over the pure `classifyState` (which is unit-tested on canned panes).
   * See `AgentState` for the precise meaning of each value — in particular `done` means
   * "ready for your input" (NOT "succeeded") and `failed` means "terminated" (NOT
   * "errored").
   */
  async state(): Promise<AgentState> {
    const alive = await this.driver.isAlive(this.tmuxName);
    if (!alive) return 'failed';
    let pane: string;
    try {
      pane = await this.driver.capture(this.tmuxName);
    } catch {
      // Pane vanished between the liveness check and the capture — treat as gone.
      return 'failed';
    }
    return classifyState(this.adapter, alive, pane);
  }

  /**
   * Poll `state()` until it SETTLES into a state in `until` or the timeout elapses.
   *
   * RELIABILITY: a non-progressing state must be observed for 2 CONSECUTIVE polls
   * before it is returned (the `reduceWait` debounce). This prevents a sub-second gap
   * between tool calls — when the working indicator momentarily drops and a single poll
   * reads `done` — from being misread as end-of-turn. A `running`/`starting` reading
   * resets the debounce.
   *
   * On timeout, returns the LAST observed state (does not throw). Use `waitForResult`
   * when the caller needs to distinguish "last observed terminal-looking state" from
   * "debounced terminal state actually reached".
   */
  async waitFor(opts?: WaitForOptions): Promise<AgentState> {
    return (await this.waitForResult(opts)).state;
  }

  async waitForResult(opts?: WaitForOptions): Promise<WaitForResult> {
    const until = opts?.until ?? DEFAULT_WAIT_UNTIL;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = opts?.pollMs ?? DEFAULT_WAIT_POLL_MS;
    const deadline = Date.now() + timeoutMs;

    let tracking: WaitTracking = INITIAL_TRACKING;
    let last = await this.state();
    {
      const r = reduceWait(tracking, last, until);
      tracking = r.tracking;
      if (r.settled) return { state: r.settled, settled: true };
    }
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollMs, remainingMs));
      last = await this.state();
      if (Date.now() >= deadline) break;
      const r = reduceWait(tracking, last, until);
      tracking = r.tracking;
      if (r.settled) return { state: r.settled, settled: true };
    }
    return { state: last, settled: false };
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
   * paste landed in the composer → Enter. The verify-before-submit loop (RESEARCH D.13)
   * is self-correcting: if the pane wasn't interactive yet (e.g. boot hooks still
   * running) and the paste was dropped, we re-paste rather than submit an empty box.
   * Ready-guarded so we never paste into an un-booted pane.
   *
   * LARGE-PROMPT SAFE: the verify checks `adapter.pasteLanded` — the literal END of the
   * prompt (near the cursor, which stays on screen) OR the provider's collapsed paste
   * chip — NOT the first line (which scrolls off the top of a multi-KB paste). Before
   * any re-paste we CLEAR the composer (`adapter.clearInputKeys`) so a retry can never
   * stack the prompt 2–3× (the old compounding bug). See `src/paste.ts`.
   *
   * CONCURRENCY: the full transaction (ready → paste attempts → Enter → ack) is held
   * under a cross-process lock keyed by session id so concurrent senders cannot interleave.
   *
   * IDEMPOTENCY: optional `options.messageId` records a durable delivery under ORC_HOME
   * (payload SHA-256 only — never the prompt body). Same key + payload is not re-submitted
   * once phase is submitted|acknowledged|unknown; a different payload for the same key fails.
   * Callers that ignore the return value remain valid (source-compatible).
   */
  async send(prompt: string, options?: SendOptions): Promise<SendResult> {
    const messageId = options?.messageId;
    if (messageId !== undefined) assertValidMessageId(messageId);

    return withLock(`send-${this.sessionId}`, async () => {
      return this.sendLocked(prompt, messageId);
    });
  }

  /** Inner send body — must run under the session send lock. */
  private async sendLocked(prompt: string, messageId: string | undefined): Promise<SendResult> {
    // Strip a single trailing newline to avoid an accidental extra submit.
    const text = prompt.replace(/\n$/, '');
    const payloadHash = hashPayload(text);
    let previous: DeliveryRecord | null = null;
    /** Set true only after Enter is sent — post-Enter errors must not mark `failed` (retryable). */
    let entered = false;

    if (messageId !== undefined) {
      previous = await readDelivery(messageId);
      if (previous) {
        const replay = evaluateDeliveryReplay(previous, this.sessionId, payloadHash);
        if (replay) return replay;
      }
      previous = await persistDelivery({
        messageId,
        sessionId: this.sessionId,
        payloadHash,
        phase: 'prepared',
        previous,
      });
    }

    try {
      if (!(await this.isReady())) {
        const ok = await this.waitForReady();
        if (!ok) {
          throw new Error(`session ${this.id} is not ready to receive input`);
        }
      }

      // pasteProbe===null marks an empty/whitespace prompt: nothing to verify, treat the
      // paste as landed (preserves the existing empty-prompt behavior).
      const isEmpty = pasteProbe(text) === null;

      let landed = false;
      let pasteAttempts = 0;
      for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
        pasteAttempts = attempt + 1;
        await this.driver.paste(this.tmuxName, text);
        await sleep(PASTE_SETTLE_MS);
        if (isEmpty) {
          landed = true;
          break;
        }
        const pane = await this.driver.capture(this.tmuxName);
        if (this.adapter.pasteLanded(pane, text)) {
          landed = true;
          break;
        }
        // Not confirmed. Clear the composer BEFORE re-pasting so a failed attempt can't
        // stack the prompt; then give the TUI a moment and retry. (When the paste was
        // simply dropped, the box is already empty and the clear is a harmless no-op.)
        if (attempt < SEND_MAX_ATTEMPTS - 1) {
          for (const key of this.adapter.clearInputKeys?.() ?? []) {
            await this.driver.sendKeys(this.tmuxName, key);
          }
          await sleep(POLL_INTERVAL_MS);
        }
      }

      if (!landed) {
        throw new Error(
          `session ${this.id}: prompt did not appear in the input box after ${SEND_MAX_ATTEMPTS} attempts`,
        );
      }
      await this.driver.sendKeys(this.tmuxName, 'Enter');
      entered = true;

      if (messageId !== undefined) {
        previous = await persistDelivery({
          messageId,
          sessionId: this.sessionId,
          payloadHash,
          phase: 'submitted',
          bumpAttempts: false,
          previous,
        });
      }

      const ack = await this.tryAcknowledge(text, isEmpty);
      if (messageId !== undefined) {
        previous = await persistDelivery({
          messageId,
          sessionId: this.sessionId,
          payloadHash,
          phase: ack,
          bumpAttempts: false,
          previous,
        });
        return toSendResult(previous);
      }
      return {
        phase: ack,
        attempts: pasteAttempts,
        payloadHash,
      };
    } catch (e) {
      if (messageId !== undefined) {
        // Never allow auto re-submit after Enter reached the wire. Prefer `unknown` over
        // `failed` when Enter already ran (even if durable `submitted` write failed).
        // Never downgrade submitted|acknowledged|unknown.
        const current = await readDelivery(messageId).catch(() => null);
        const phase = current?.phase;
        if (phase === 'submitted' || phase === 'acknowledged' || phase === 'unknown') {
          // leave sticky post-Enter phases alone
        } else if (entered) {
          await persistDelivery({
            messageId,
            sessionId: this.sessionId,
            payloadHash,
            phase: 'unknown',
            bumpAttempts: false,
            previous: current ?? previous,
          }).catch(() => {});
        } else if (!phase || phase === 'prepared' || phase === 'failed') {
          await persistDelivery({
            messageId,
            sessionId: this.sessionId,
            payloadHash,
            phase: 'failed',
            bumpAttempts: false,
            previous: current ?? previous,
          }).catch(() => {});
        }
      }
      throw e;
    }
  }

  /**
   * Bounded acknowledgement using provider-neutral evidence already available via
   * state()/capture/pasteLanded. Proves submit was observed — never invents success.
   * Returns `unknown` when evidence cannot be established within ACK_TIMEOUT_MS.
   */
  private async tryAcknowledge(text: string, isEmpty: boolean): Promise<'acknowledged' | 'unknown'> {
    // Empty submit has nothing observable in the composer; treat Enter as best-effort ack.
    if (isEmpty) return 'acknowledged';

    const deadline = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let state: AgentState;
      try {
        state = await this.state();
      } catch {
        state = 'failed';
      }
      // Turn in progress or a modal — clear evidence the submit was consumed.
      if (state === 'running' || state === 'waiting') return 'acknowledged';

      try {
        const pane = await this.driver.capture(this.tmuxName);
        // Composer no longer holds the paste we verified before Enter → accepted/cleared.
        if (!this.adapter.pasteLanded(pane, text)) return 'acknowledged';
      } catch {
        // Pane capture failure is not proof of delivery.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(ACK_POLL_MS, remaining));
    }
    return 'unknown';
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
   * is the SDK mirror of `orc read --full`. Returns `[]` when no transcript is
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

  attach(opts?: { readOnly?: boolean }): Promise<number> {
    return this.driver.attach(this.tmuxName, opts);
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
    // The provider process is gone, so its external Codex instructions are no longer
    // needed. Remove them for ordinary kills as well as purge/workflow cleanup.
    await removeSessionInstructions(this.record).catch(() => {});
    if (opts?.removeWorktree && this.record.worktreePath) {
      await removeWorktree(this.record.cwd, this.record.worktreePath, {
        branch: this.record.branch,
      }).catch(() => {});
    }

    if (opts?.purge) {
      await removeRecord(this.id);
      await releaseSessionPolicy(this.record.rootRunId).catch(() => {});
      return;
    }
    // Mark dead but keep the record (transcript reads stay resolvable).
    this.record.status = 'dead';
    this.record.killedAt = new Date().toISOString();
    await upsertRecord(this.record);
    await releaseSessionPolicy(this.record.rootRunId).catch(() => {});
  }

  toJSON(): SessionRecord {
    return { ...this.record };
  }
}
