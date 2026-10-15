/**
 * Session handle: a SessionRecord plus live operations against the actor kernel
 * (src/runtime/client.ts). Every operation is safe from any process: messages go through
 * the session's durable inbox, state is derived from its journal, and a suspended session
 * is woken on send (agents-first; design §4.3–4.5).
 */
import { upsertRecord, removeRecord, updateRegistry } from './registry.ts';
import { removeSessionDir, removeSystemPromptFile } from './session-files.ts';
import { removeWorktree } from './worktree.ts';
import { parseTranscript } from './transcript.ts';
import type { Turn } from './transcript.ts';
import type { SendOptions, SendResult } from './messages.ts';
import { assertValidMessageId } from './paths.ts';
import type { AgentState, Provider, SessionRecord, SessionStatus } from './types.ts';
import { releaseSessionPolicy, wakePolicyHook } from './lineage.ts';
import { sessionStatusOf } from './session-status.ts';
import { renderJournalEntry } from './journal-render.ts';
import { nativeResumeCommand, nativeResumeNote, resolveTranscriptPath } from './provider-cli.ts';
import {
  SessionStoppedError,
  deriveState,
  ensureAwake,
  inspect,
  interrupt as kernelInterrupt,
  messageText,
  readJournal,
  reopen,
  send as kernelSend,
  sessionPaths,
  stop as kernelStop,
  JournalCursor,
  isLiveProcess,
  leaseLive,
} from './runtime/client.ts';
import type { DerivedState } from './runtime/client.ts';
import { TurnLedger, summarizeLedger } from './runtime/derive.ts';
import type { SessionView } from './runtime/derive.ts';
import { listPending } from './runtime/inbox.ts';
import { readSpawnSpec } from './runtime/spec.ts';
import { readActorState } from './runtime/actor-state.ts';
import { readFileTail } from './runtime/fsutil.ts';
import { ulid } from './runtime/ulid.ts';
import type { JournalEntry, ProcessIdentity, SpawnSpec } from './runtime/types.ts';

export type { SendOptions, SendResult } from './messages.ts';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_UNTIL: AgentState[] = ['done', 'waiting', 'failed'];
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_WAIT_POLL_MS = 250;
const ATTACH_POLL_MS = 150;

export interface WaitForOptions {
  /** States that count as "settled enough to return". Default done/waiting/failed. */
  until?: AgentState[];
  /** Give up after this long and return the last observed state. Default 600000. */
  timeoutMs?: number;
  /** Interval between journal polls. Default 250. */
  pollMs?: number;
}

export interface WaitForResult {
  /** The state that settled, or the last observed state on timeout. */
  state: AgentState;
  /** True when a requested state was observed before the deadline. */
  settled: boolean;
}

/** `state()` plus the kernel facts behind it (`orc state --json`). */
export interface SessionStateDetail {
  id: string;
  state: AgentState;
  status: SessionStatus;
  /** Explicitly stopped (kill/takeover): sticky until `orc resume`. */
  stopped: boolean;
  /** Not live, not stopped: woken by the next send / `orc resume`. */
  suspended: boolean;
  live: boolean;
  pendingMessages: number;
  openTurn?: DerivedState['openTurn'];
  lastTurn?: DerivedState['lastTurn'];
  stopReason?: string;
  /** Legacy (pre-actor tmux) record: readable, never controlled. */
  legacy?: boolean;
}

export interface TakeoverResult {
  id: string;
  cwd: string;
  /** The provider's own resume command (`cd <cwd> && …`). Handback: `orc resume <id>`. */
  command: string;
  /** Extra guidance for running `command` (codex: continued in pi, which needs its own login). */
  note?: string;
  providerSessionId?: string;
  transcriptPath?: string;
}

export interface AttachOptions {
  /** Accepted for compatibility and ignored: following the journal is read-only. */
  readOnly?: boolean;
  signal?: AbortSignal;
  /** Output sink (default: process.stdout). */
  write?: (text: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Un-kill a record for a resume: drop status/killedAt/stoppedBy on the registry's copy of
 * EXACTLY this record (same id + sessionId), in place. Returns the updated record, or
 * undefined when it is gone (pruned meanwhile) — it is never re-inserted.
 */
export async function clearStoppedMarker(rec: SessionRecord): Promise<SessionRecord | undefined> {
  return updateRegistry((records) => {
    const i = records.findIndex((r) => r.id === rec.id && r.sessionId === rec.sessionId);
    if (i < 0) return { records, value: undefined };
    const { status: _s, killedAt: _k, stoppedBy: _b, ...rest } = records[i]!;
    const next: SessionRecord = rest;
    const out = [...records];
    out[i] = next;
    return { records: out, value: next };
  });
}

/** What `provider.ready` reported (Session.awaitReady). */
export interface ProviderReadyInfo {
  providerSessionId: string;
  transcriptPath?: string;
}

/** A stopped session refused a send; carries the `orc resume` hint. */
export class SessionNotControllableError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SessionNotControllableError';
  }
}

/**
 * Incremental derive (decision D6): a JournalCursor folds only new entries into a
 * TurnLedger each tick; inbox, spawn.json and state.json are small and re-read.
 */
class StateObserver {
  private readonly cursor: JournalCursor;
  private readonly ledger = new TurnLedger();
  private spec: SpawnSpec | undefined;

  constructor(private readonly sessionId: string) {
    this.cursor = JournalCursor.forSession(sessionId);
  }

  observe(): DerivedState {
    for (const e of this.cursor.readNew()) this.ledger.apply(e);
    this.spec ??= readSpawnSpec(this.sessionId);
    const actor = readActorState(this.sessionId);
    const pending = listPending(this.sessionId);
    const msgs = pending.filter(
      (i) =>
        i.kind === 'message' && !this.ledger.intentUlids.has(i.ulid) && !this.ledger.byMessageId.has(i.messageId),
    );
    const view: SessionView = {
      sessionId: this.sessionId,
      exists: !!this.spec,
      ...(this.spec ? { spec: this.spec } : {}),
      ...(actor ? { actor } : {}),
      live: leaseLive(actor),
      pending: {
        messages: msgs.length,
        interrupts: pending.filter((i) => i.kind === 'interrupt').length,
        stops: pending.filter((i) => i.kind === 'stop').length,
        messageIds: msgs.map((m) => (m.kind === 'message' ? m.messageId : '')),
      },
      summary: summarizeLedger(this.ledger),
      tail: [],
      observedAt: new Date().toISOString(),
    };
    return deriveState(view);
  }
}

function hasSpawnSpec(sessionId: string): boolean {
  try {
    return readSpawnSpec(sessionId) !== undefined;
  } catch {
    return false;
  }
}

function actorLogTail(sessionId: string): string {
  try {
    const t = readFileTail(sessionPaths(sessionId).actorLog, 2_000).trim();
    return t ? `\n--- actor.log (tail) ---\n${t}` : '';
  } catch {
    return '';
  }
}

export class Session {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: Provider;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly workspace: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly alias?: string;
  readonly createdAt: string;

  private record: SessionRecord;

  constructor(record: SessionRecord) {
    this.record = record;
    this.id = record.id;
    this.sessionId = record.sessionId;
    this.provider = record.provider;
    this.cwd = record.cwd;
    this.worktreePath = record.worktreePath;
    this.branch = record.branch;
    this.workspace = record.workspace;
    this.model = record.model;
    this.agentName = record.agentName;
    this.alias = record.alias;
    this.createdAt = record.createdAt;
  }

  /** True for a record written by the pre-actor (tmux) orc. */
  get legacy(): boolean {
    return this.record.legacy === 'tmux';
  }

  /** Throws unless the kernel can control this session (not legacy, spawn.json present). */
  private assertControllable(action: string): void {
    if (this.legacy) {
      throw new SessionNotControllableError(
        `session ${this.id} is a legacy tmux session${
          this.record.legacyTmuxName ? ` (${this.record.legacyTmuxName})` : ''
        }; it cannot ${action} — kill its tmux session and \`orc prune\` the record`,
        'ORC_SESSION_LEGACY',
      );
    }
    if (!hasSpawnSpec(this.sessionId)) {
      throw new SessionNotControllableError(
        `session ${this.id} has no runtime state (purged or never started); it cannot ${action}`,
        'ORC_SESSION_UNKNOWN',
      );
    }
  }

  /** running | suspended | dead (decision D1). */
  async status(): Promise<SessionStatus> {
    return sessionStatusOf(this.record);
  }

  /** Derived state plus kernel facts (stopped / suspended / turns). */
  async stateDetail(): Promise<SessionStateDetail> {
    const status = sessionStatusOf(this.record);
    if (this.legacy || !hasSpawnSpec(this.sessionId)) {
      return {
        id: this.id,
        // A reservation whose kernel session is being created right now.
        state: status === 'spawning' ? 'starting' : 'failed',
        status,
        stopped: this.record.status === 'dead',
        suspended: false,
        live: false,
        pendingMessages: 0,
        ...(this.legacy ? { legacy: true } : {}),
      };
    }
    const d = deriveState(inspect(this.sessionId, { tail: 0 }));
    return {
      id: this.id,
      state: d.state,
      status,
      stopped: d.stopped,
      suspended: d.suspended,
      live: d.live,
      pendingMessages: d.pendingMessages,
      ...(d.openTurn ? { openTurn: d.openTurn } : {}),
      ...(d.lastTurn ? { lastTurn: d.lastTurn } : {}),
      ...(d.stopReason ? { stopReason: d.stopReason } : {}),
    };
  }

  /**
   * The current state, derived from the journal (see `AgentState`): `done` means "ready
   * for your input" (NOT "succeeded"); `failed` covers a failed last turn and a session
   * that is not live (stopped or suspended — see `stateDetail()`).
   */
  async state(): Promise<AgentState> {
    return (await this.stateDetail()).state;
  }

  /**
   * Poll the journal until the state is one of `until` or the timeout elapses. Events are
   * authoritative, so there is no debounce: the first matching observation settles. On
   * timeout returns the LAST observed state with `settled: false` (does not throw).
   */
  async waitFor(opts?: WaitForOptions): Promise<AgentState> {
    return (await this.waitForResult(opts)).state;
  }

  async waitForResult(opts?: WaitForOptions): Promise<WaitForResult> {
    const until = opts?.until ?? DEFAULT_WAIT_UNTIL;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = Math.max(1, opts?.pollMs ?? DEFAULT_WAIT_POLL_MS);
    const deadline = Date.now() + timeoutMs;
    if (this.legacy || !hasSpawnSpec(this.sessionId)) {
      return { state: 'failed', settled: until.includes('failed') };
    }
    const obs = new StateObserver(this.sessionId);
    while (true) {
      const state = obs.observe().state;
      if (until.includes(state)) return { state, settled: true };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state, settled: false };
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /**
   * Wait until the provider reported ready (`provider.ready` after the latest actor
   * start) and return what that entry says (provider session id — codex: its thread id —
   * and transcript path). Throws — with the journal error and the actor.log tail — when
   * the actor stops or dies first, or on timeout.
   */
  async awaitReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<ProviderReadyInfo> {
    this.assertControllable('start');
    const sid = this.sessionId;
    const deadline = Date.now() + timeoutMs;
    const cursor = JournalCursor.forSession(sid);
    let ready: Extract<JournalEntry, { type: 'provider.ready' }> | undefined;
    let stopped: Extract<JournalEntry, { type: 'actor.stopped' }> | undefined;
    const readyInfo = (e: Extract<JournalEntry, { type: 'provider.ready' }>): ProviderReadyInfo => ({
      providerSessionId: e.providerSessionId,
      ...(e.transcriptPath ? { transcriptPath: e.transcriptPath } : {}),
    });
    while (true) {
      for (const e of cursor.readNew()) {
        if (e.type === 'actor.started') {
          ready = undefined;
          stopped = undefined;
        } else if (e.type === 'provider.ready') {
          ready = e;
          stopped = undefined;
        } else if (e.type === 'actor.stopped') {
          stopped = e;
        }
      }
      if (stopped) {
        throw new Error(
          `session ${this.id} stopped before its provider was ready (${stopped.reason}${
            stopped.error ? `: ${stopped.error}` : ''
          })${actorLogTail(sid)}`,
        );
      }
      if (ready) return readyInfo(ready);
      if (!leaseLive(readActorState(sid))) {
        // Give the journal one more read: the actor may have journaled on its way out.
        await sleep(20);
        const late = cursor.readNew().find((e) => e.type === 'provider.ready');
        if (late?.type === 'provider.ready') return readyInfo(late);
        throw new Error(`session ${this.id}: actor exited before its provider was ready${actorLogTail(sid)}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `session ${this.id}: provider not ready after ${timeoutMs}ms${actorLogTail(sid)}`,
        );
      }
      await sleep(50);
    }
  }

  /** Boolean form of `awaitReady` (true when ready within the timeout). */
  async waitForReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<boolean> {
    try {
      await this.awaitReady(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a prompt through the session's durable inbox. Multi-line safe (the text reaches
   * the provider verbatim over its structured protocol; a single trailing newline is
   * dropped). A suspended session is woken first (unless `wake: false`), re-checking the
   * root's maxConcurrentSessions.
   *
   * Returns once the provider acknowledged the message (`acknowledged`) or the bounded
   * ack wait elapsed (`queued` — still durably delivered later). Idempotent per
   * `messageId` (default: a fresh ULID): a replay returns the recorded phase with
   * `replayed: true`; reusing a key with different text throws.
   */
  async send(prompt: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertControllable('receive messages');
    const messageId = options.messageId ?? ulid();
    assertValidMessageId(messageId);
    const text = prompt.replace(/\n$/, '');
    const conflict = () =>
      new SessionNotControllableError(
        `messageId '${messageId}' was already used with a different prompt for session ${this.id}`,
        'ORC_MESSAGE_CONFLICT',
      );
    const prior = messageText(this.sessionId, messageId);
    if (prior !== undefined && prior !== text) throw conflict();
    const beforeWake = wakePolicyHook(this.record);
    let r;
    try {
      r = await kernelSend(
        this.sessionId,
        { messageId, text },
        {
          ...(options.wake === false ? { wake: false } : {}),
          ...(options.ackTimeoutMs !== undefined ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
          ...(beforeWake ? { beforeWake } : {}),
        },
      );
    } catch (e) {
      if (e instanceof SessionStoppedError) {
        throw new SessionNotControllableError(
          `session ${this.id} is stopped (killed or taken over); \`orc resume ${this.id}\` hands it back`,
          'ORC_SESSION_STOPPED',
        );
      }
      throw e;
    }
    if (r.duplicate) {
      const stored = messageText(this.sessionId, messageId);
      if (stored !== undefined && stored !== text) throw conflict();
    }
    return { phase: r.verdict, messageId, replayed: r.duplicate };
  }

  /** Interrupt the open turn (no-op when none is open or the actor is not live). */
  async interrupt(): Promise<boolean> {
    this.assertControllable('be interrupted');
    return (await kernelInterrupt(this.sessionId)).status === 'requested';
  }

  /** The session journal (normalized provider events + lifecycle facts). */
  journal(opts: { tail?: number; fromSeq?: number } = {}): JournalEntry[] {
    if (this.legacy) return [];
    try {
      return readJournal(this.sessionId, opts);
    } catch {
      return [];
    }
  }

  /** Absolute path of the session journal (journal.jsonl). */
  journalPath(): string {
    return sessionPaths(this.sessionId).journal;
  }

  /** Resolve the on-disk provider transcript path (null when none exists yet). */
  async transcript(): Promise<string | null> {
    let spec: SpawnSpec | undefined;
    try {
      spec = this.legacy ? undefined : readSpawnSpec(this.sessionId);
    } catch {
      spec = undefined;
    }
    return resolveTranscriptPath(this.record, spec);
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
   * one-line tool-call summaries). Returns `[]` when no transcript exists yet — use
   * `journal()` for the live view.
   */
  async readParsed(): Promise<Turn[]> {
    const jsonl = await this.readTranscript();
    if (!jsonl) return [];
    return parseTranscript(this.provider, jsonl);
  }

  /** The command that follows this session live (`orc attach <id>`). */
  attachCommand(_opts?: { readOnly?: boolean }): string {
    return `orc attach ${this.id}`;
  }

  /**
   * Follow the journal rendered as text (prompts, replies, outcomes, lifecycle) until the
   * session is no longer live (stopped / suspended) or `signal` aborts. Read-only by
   * construction. Resolves with an exit code.
   */
  async attach(opts: AttachOptions = {}): Promise<number> {
    const write = opts.write ?? ((t: string) => void process.stdout.write(t));
    if (this.legacy) {
      write(`# session ${this.id} is a legacy tmux session; nothing to follow\n`);
      return 1;
    }
    if (!hasSpawnSpec(this.sessionId)) {
      write(`# session ${this.id} has no runtime state\n`);
      return 1;
    }
    const cursor = JournalCursor.forSession(this.sessionId);
    const flush = () => {
      for (const e of cursor.readNew()) {
        const line = renderJournalEntry(e);
        if (line !== null) write(`${line}\n`);
      }
    };
    while (!opts.signal?.aborted) {
      flush();
      if (!leaseLive(readActorState(this.sessionId))) {
        flush();
        const d = await this.stateDetail();
        write(`# session ${this.id} ${d.stopped ? 'stopped' : 'suspended'}\n`);
        return 0;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, ATTACH_POLL_MS);
        function done() {
          clearTimeout(t);
          opts.signal?.removeEventListener('abort', done);
          resolve();
        }
        opts.signal?.addEventListener('abort', done, { once: true });
      });
    }
    return 0;
  }

  /** Persist kernel-learned facts (provider session id, transcript) onto the record. */
  private async captureFacts(): Promise<void> {
    try {
      const spec = readSpawnSpec(this.sessionId);
      if (spec?.providerSessionId) this.record.providerSessionId = spec.providerSessionId;
    } catch {
      /* no runtime state */
    }
    if (!this.record.transcriptPath) {
      const file = await this.transcript().catch(() => null);
      if (file) this.record.transcriptPath = file;
    }
  }

  /**
   * Kill the session: stop its actor (sticky — it never wakes until `orc resume`) and
   * mark the record dead. The record and the session dir (journal, system prompt) are
   * KEPT so reads still resolve. `purge: true` removes the record and the session dir;
   * `removeWorktree` removes the git worktree. A record with no runtime state (legacy /
   * never started) skips the kernel.
   */
  async kill(opts?: { removeWorktree?: boolean; purge?: boolean }): Promise<void> {
    const controllable = !this.legacy && hasSpawnSpec(this.sessionId);
    await this.captureFacts();
    if (controllable) {
      await kernelStop(this.sessionId, { reason: 'kill' });
    } else {
      await removeSystemPromptFile(this.record).catch(() => {});
    }
    if (opts?.removeWorktree && this.record.worktreePath) {
      await removeWorktree(this.record.cwd, this.record.worktreePath, {
        branch: this.record.branch,
      }).catch(() => {});
    }
    if (opts?.purge) {
      await removeSessionDir(this.sessionId);
      await removeRecord(this.id);
      await releaseSessionPolicy(this.record.rootRunId).catch(() => {});
      return;
    }
    this.record.status = 'dead';
    this.record.killedAt = new Date().toISOString();
    this.record.stoppedBy = 'kill';
    await upsertRecord(this.record);
    await releaseSessionPolicy(this.record.rootRunId).catch(() => {});
  }

  /**
   * Escape hatch (design §4.5): stop the actor cleanly (sticky, so a wake-on-send can
   * never start a second writer), wait until the provider process group is gone, and
   * return the provider's own resume command for a human. Handback: `resume()`.
   */
  async takeover(opts: { graceMs?: number; timeoutMs?: number } = {}): Promise<TakeoverResult> {
    this.assertControllable('be taken over');
    const before = readActorState(this.sessionId)?.provider;
    await kernelStop(this.sessionId, {
      reason: 'takeover',
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
    });
    const ids = [before, readActorState(this.sessionId)?.provider].filter(
      (p): p is ProcessIdentity => !!p,
    );
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    while (ids.some((p) => isLiveProcess(p))) {
      if (Date.now() >= deadline) {
        throw new Error(`session ${this.id}: provider process still running after takeover stop`);
      }
      await sleep(50);
    }
    const spec = readSpawnSpec(this.sessionId)!;
    await this.captureFacts();
    this.record.status = 'dead';
    this.record.killedAt = new Date().toISOString();
    this.record.stoppedBy = 'takeover';
    await upsertRecord(this.record);
    return {
      id: this.id,
      cwd: spec.cwd,
      command: nativeResumeCommand(spec),
      ...(nativeResumeNote(spec) ? { note: nativeResumeNote(spec)! } : {}),
      ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {}),
      ...(this.record.transcriptPath ? { transcriptPath: this.record.transcriptPath } : {}),
    };
  }

  /**
   * Hand a stopped (killed / taken-over) or suspended session back to an actor: clear the
   * sticky stop, wake it (re-checking maxConcurrentSessions) and wait for the provider
   * to be ready. A purged or legacy session cannot be resumed.
   */
  async resume(opts: { readyTimeoutMs?: number } = {}): Promise<SessionStateDetail> {
    this.assertControllable('be resumed');
    await reopen(this.sessionId, { reason: 'resume' });
    // The kernel is resumable now: un-kill the record BEFORE waking, so a failed wake
    // leaves a consistent `suspended` session (listed, not prunable) instead of a hidden
    // `dead` record over a resumable kernel.
    if (this.record.status === 'dead' || this.record.killedAt || this.record.stoppedBy) {
      // Patched in place, never re-inserted: a concurrent `prune --suspended` may have
      // removed the session (record + dir) since reopen — then there is nothing to resume.
      const cleared = await clearStoppedMarker(this.record);
      if (!cleared) {
        throw new SessionNotControllableError(`session ${this.id} was pruned while resuming`, 'ORC_SESSION_UNKNOWN');
      }
      this.record = cleared;
    }
    const hook = wakePolicyHook(this.record);
    // An explicit resume is the "force" path: it clears the consecutive start-failure
    // counter that blocks automatic wake-on-send after repeated failed starts.
    const r = await ensureAwake(this.sessionId, { force: true, ...(hook ? { beforeSpawn: hook } : {}) });
    if (r.status === 'stopped') {
      throw new SessionNotControllableError(`session ${this.id} was stopped again while resuming`, 'ORC_SESSION_STOPPED');
    }
    if (r.status === 'started' && 'sessionError' in r && r.sessionError) {
      throw new Error(`session ${this.id} failed to resume: ${String(r.sessionError)}`);
    }
    if (r.status === 'started') await this.awaitReady(opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    return this.stateDetail();
  }

  toJSON(): SessionRecord {
    return { ...this.record };
  }
}
