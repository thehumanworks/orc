/**
 * `orc __actor <sessionId>` — the per-session actor (design §4.2–4.3).
 *
 * Lifecycle:
 *  1. Acquire the lease in state.json under the `actor-<sid>` lock (a lease pre-registered
 *     for this pid by the launcher is adopted; another live lease → exit 0; stopped → exit 0).
 *  2. Kill a recorded stale provider group; repair the journal tail; close any intent
 *     without outcome with turn.interrupted{recovered} (never re-sent).
 *  3. Decide fresh vs resume, journal actor.started, start the provider runtime and record
 *     its identity; on `ready` persist providerSessionId and go `running`.
 *  4. Heartbeat the lease; consume the inbox strictly in ULID order, one turn at a time
 *     (interrupt/stop are handled immediately); journal every provider event.
 *  5. Every exit path kills the provider group and releases the lease:
 *     stop item → stopped (sticky); provider exit / SIGTERM / error → suspended (resumable);
 *     lease lost → exit without touching state.json.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { processStartTime, signalProcessGroup } from './process.ts';
import { INBOX_POLL_MS, LEASE_HEARTBEAT_MS, LEASE_TTL_MS } from './types.ts';
import type {
  ActorStateFile,
  InboxItem,
  JournalEntry,
  JournalEvent,
  ProcessIdentity,
  ProviderEvent,
  ProviderRuntime,
  SpawnSpec,
  TurnInterruptReason,
} from './types.ts';
import { ensureSessionDirs, sessionPaths } from './layout.ts';
import type { SessionPaths } from './layout.ts';
import { assertValidSessionId } from './fsutil.ts';
import { readSpawnSpec, writeSpawnSpec } from './spec.ts';
import { JournalWriter, readJournalFile } from './journal.ts';
import {
  listPending,
  listPendingDetailed,
  quarantineInboxItem,
  removeInboxItem,
  sweepStaleInboxTmp,
} from './inbox.ts';
import {
  DEFAULT_STOP_GRACE_MS,
  initialActorState,
  isLiveProcess,
  leaseLive,
  readActorState,
  terminateGroup,
  withActorLock,
  writeActorState,
} from './actor-state.ts';
import { TurnLedger, staleProviders } from './derive.ts';
import { abandonedStopReason, finalizeStopLocked, isAbandonedStop } from './stop.ts';
import { getRuntimeFactory } from './providers/index.ts';
import { ulidTime } from './ulid.ts';

/** Provider must emit `ready` within this long (override: ORC_ACTOR_READY_TIMEOUT_MS). */
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** Upper bound on waiting for an interrupted turn's outcome before closing the provider. */
const INTERRUPT_BEFORE_CLOSE_MAX_MS = 2_000;

class LeaseLostError extends Error {
  constructor(sessionId: string) {
    super(`lease for ${sessionId} lost`);
    this.name = 'LeaseLostError';
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function mergeEnv(base: NodeJS.ProcessEnv, add: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') out[k] = v;
  return Object.assign(out, add);
}

function readyTimeoutMs(): number {
  const n = Number(process.env.ORC_ACTOR_READY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_READY_TIMEOUT_MS;
}

interface OpenTurn {
  messageId: string;
  ulid: string;
  started: boolean;
}

interface ShutdownOptions {
  phase: 'stopped' | 'suspended';
  reason: 'stop' | 'provider-exit' | 'error' | 'lease-lost';
  error?: string;
  /** Recorded as ActorStateFile.stopReason. */
  stopReason: string;
  /** Reason journaled for a turn still open at shutdown. */
  turnReason: TurnInterruptReason;
  graceMs?: number;
  stopUlid?: string;
  code: number;
  /** false once the lease is lost: never touch state.json or recover turns. */
  ownsState?: boolean;
}

type LeaseResult = 'ok' | 'busy' | 'stopped' | 'missing';

class Actor {
  private readonly paths: SessionPaths;
  private readonly token = randomUUID();
  private readonly pid = process.pid;
  private readonly startTime = processStartTime(process.pid);
  private spec!: SpawnSpec;
  private journal?: JournalWriter;
  private ledger = new TurnLedger();
  private stateCompletedTurns = 0;
  private rt?: ProviderRuntime;
  private providerId?: ProcessIdentity;
  private starting?: Promise<unknown>;
  private providerExited = false;
  private ready = false;
  private openTurn?: OpenTurn;
  private staleProvider?: ProcessIdentity;
  private interruptCutoffMs = Date.now();
  private shuttingDown = false;
  private shutdownP?: Promise<void>;
  private readonly finished: Promise<number>;
  private resolveFinished!: (code: number) => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private watcher?: fs.FSWatcher;
  private pumpDone?: Promise<void>;
  private processing = false;
  private rekick = false;
  private lastRenewedAt = Date.now();
  private beating = false;
  private leaseLost = false;
  /**
   * What state.json should say, kept in memory and re-applied on EVERY write, so a failed
   * write (lock timeout, I/O error) is repaired by the next heartbeat instead of leaving
   * e.g. `starting` behind forever.
   */
  private phase: ActorStateFile['phase'] = 'starting';
  private providerSessionId?: string;
  private startFailures = 0;
  private lastStartError?: string;
  /** Set when a sticky stop begins, so `stopping` is never persisted without its reason. */
  private stopReason?: string;
  private readonly handlers: Array<[string, (...args: unknown[]) => void]> = [];

  constructor(private readonly sid: string) {
    this.paths = sessionPaths(sid);
    this.finished = new Promise<number>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  private log(msg: string): void {
    try {
      process.stderr.write(`${new Date().toISOString()} actor[${this.pid}] ${msg}\n`);
    } catch {
      /* log fd gone */
    }
  }

  async run(): Promise<number> {
    let acq: LeaseResult;
    try {
      acq = await this.acquireLease();
    } catch (e) {
      this.log(`lease acquisition failed: ${errMsg(e)}`);
      return 1;
    }
    if (acq === 'missing') {
      this.log(`no spawn.json for ${this.sid}`);
      return 1;
    }
    if (acq === 'stopped') {
      this.log('session is stopped; not starting');
      return 0;
    }
    if (acq === 'busy') {
      this.log('another actor holds a live lease; exiting');
      return 0;
    }
    this.log(`lease acquired (session ${this.sid})`);
    this.installProcessHandlers();
    this.boot().catch((e) => this.fatal(e));
    return this.finished;
  }

  // -------------------------------------------------------------------------------
  // Lease + state
  // -------------------------------------------------------------------------------

  private acquireLease(): Promise<LeaseResult> {
    return withActorLock(this.sid, async () => {
      const spec = readSpawnSpec(this.sid);
      if (!spec) return 'missing';
      this.spec = spec;
      const st = readActorState(this.sid) ?? initialActorState(this.sid);
      if (st.phase === 'stopped') return 'stopped';
      const mine =
        !!st.lease &&
        st.lease.pid === this.pid &&
        (st.lease.startTime === null || st.lease.startTime === this.startTime);
      if (!mine && leaseLive(st)) return 'busy';
      if (isAbandonedStop(st)) {
        // The previous actor died mid-stop: finish that stop (sticky), never start.
        await finalizeStopLocked(this.sid, st, abandonedStopReason(this.sid, st));
        return 'stopped';
      }
      // Interrupts enqueued before this incarnation was launched cannot target its turns.
      const launchedAt = mine ? Date.parse(st.updatedAt) : NaN;
      this.interruptCutoffMs = Number.isFinite(launchedAt) ? Math.min(launchedAt, Date.now()) : Date.now();
      if (st.provider) this.staleProvider = st.provider;
      this.stateCompletedTurns = st.completedTurns;
      this.startFailures = st.startFailures ?? 0;
      this.lastStartError = st.lastStartError;
      st.lease = {
        pid: this.pid,
        startTime: this.startTime,
        token: this.token,
        expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
      };
      st.phase = 'starting';
      delete st.stopReason;
      st.updatedAt = new Date().toISOString();
      writeActorState(st, { fsync: true });
      return 'ok';
    });
  }

  private completedTurns(): number {
    return Math.max(this.stateCompletedTurns, this.ledger.completedTurns);
  }

  /** Read-check-write state.json under the lock; renews the lease. Throws LeaseLostError. */
  private async updateState(mut: (s: ActorStateFile) => void, opts: { fsync?: boolean } = {}): Promise<void> {
    await withActorLock(this.sid, async () => {
      const s = readActorState(this.sid);
      if (!s || s.lease?.token !== this.token) throw new LeaseLostError(this.sid);
      s.lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      s.phase = this.phase;
      if (this.providerSessionId) s.providerSessionId = this.providerSessionId;
      if (this.providerId) s.provider = this.providerId;
      if (this.stopReason !== undefined) s.stopReason = this.stopReason;
      if (this.startFailures > 0) {
        s.startFailures = this.startFailures;
        if (this.lastStartError) s.lastStartError = this.lastStartError;
      } else {
        delete s.startFailures;
        delete s.lastStartError;
      }
      mut(s);
      if (this.journal) s.lastSeq = Math.max(s.lastSeq, this.journal.lastSeq);
      s.completedTurns = Math.max(s.completedTurns, this.completedTurns());
      s.updatedAt = new Date().toISOString();
      writeActorState(s, opts);
      this.lastRenewedAt = Date.now();
    });
  }

  /**
   * Heartbeat: renew the lease (re-applying the intended state); if renewals kept failing
   * past the TTL, assume it is lost. At most one beat in flight (a slow lock must not pile
   * up writers).
   */
  private async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      await this.persist();
      if (!this.shuttingDown && Date.now() - this.lastRenewedAt > LEASE_TTL_MS) {
        this.log(`lease not renewed for ${LEASE_TTL_MS}ms`);
        this.onLeaseLost();
      }
    } finally {
      this.beating = false;
    }
  }

  /** updateState with policy: lease loss → shut down; other errors are logged. */
  private async persist(mut: (s: ActorStateFile) => void = () => {}, opts: { fsync?: boolean } = {}): Promise<boolean> {
    try {
      await this.updateState(mut, opts);
      return true;
    } catch (e) {
      if (e instanceof LeaseLostError) this.onLeaseLost();
      else this.log(`state write failed: ${errMsg(e)}`);
      return false;
    }
  }

  private onLeaseLost(): void {
    this.leaseLost = true;
    this.log('lease lost to another actor; stopping provider and exiting');
    void this.shutdown({
      phase: 'suspended',
      reason: 'lease-lost',
      stopReason: 'lease-lost',
      turnReason: 'recovered',
      code: 1,
      ownsState: false,
    });
  }

  // -------------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------------

  private append(ev: JournalEvent, opts: { fsync?: boolean } = {}): JournalEntry | undefined {
    if (this.leaseLost) {
      // The journal belongs to the lease holder now.
      this.log(`lease lost: not journaling ${ev.type}`);
      return undefined;
    }
    if (!this.journal) throw new Error('journal not open');
    const e = this.journal.append(ev, opts);
    this.ledger.apply(e);
    return e;
  }

  private async boot(): Promise<void> {
    ensureSessionDirs(this.sid);
    const swept = sweepStaleInboxTmp(this.sid);
    if (swept > 0) this.log(`swept ${swept} stale inbox temp file(s)`);
    this.journal = JournalWriter.open(this.paths.journal);
    this.ledger = TurnLedger.from(readJournalFile(this.paths.journal));
    // Never two writers: providers left behind by crashed actors die first — the one in
    // state.json and any journaled provider.spawned that never exited (an actor killed
    // during a provider handshake, before the pid reached state.json).
    for (const id of staleProviders({ provider: this.staleProvider }, this.ledger)) {
      if (await terminateGroup(id, 1_000)) this.log(`terminated stale provider group ${id.pid}`);
    }
    for (const t of this.ledger.openTurns()) {
      // Brief decision 1: close it; delivery verdict is acknowledged iff turn.started exists.
      this.append({ type: 'turn.interrupted', messageId: t.messageId, reason: 'recovered' });
      removeInboxItem(this.sid, t.ulid);
      this.log(`recovered open turn ${t.messageId} (${t.startedSeq ? 'acknowledged' : 'unknown'})`);
    }
    const resume =
      !!this.spec.providerSessionId && (this.completedTurns() >= 1 || this.ledger.startedTurns >= 1);
    this.append({ type: 'actor.started', pid: this.pid, mode: resume ? 'resume' : 'fresh' });
    await this.updateState(() => {}, { fsync: true });
    this.heartbeat = setInterval(() => void this.beat(), LEASE_HEARTBEAT_MS);
    if (this.shuttingDown) return;

    const factory = await getRuntimeFactory(this.spec.provider);
    if (this.shuttingDown) return;
    // Assigned synchronously so a concurrent shutdown always waits for (and closes) it.
    const started = (async () => {
      const rt = await factory.start({
        spec: this.spec,
        resume,
        env: mergeEnv(process.env, this.spec.env),
        rawLogPath: this.paths.providerRaw,
        onSpawn: (id) => this.onProviderSpawned(id),
      });
      this.rt = rt;
      if (this.providerId?.pid !== rt.pid) this.providerId = { pid: rt.pid, startTime: processStartTime(rt.pid) };
      return rt;
    })();
    this.starting = started.catch(() => undefined);
    const rt = await started;
    this.log(`provider ${this.spec.provider} started pid=${rt.pid} mode=${resume ? 'resume' : 'fresh'}`);
    await this.updateState(() => {});
    if (this.shuttingDown) return;
    this.pumpDone = this.pump(rt);
    const readyMs = readyTimeoutMs();
    this.readyTimer = setTimeout(() => {
      if (!this.ready) this.fatal(new Error(`provider not ready after ${readyMs}ms`));
    }, readyMs);
    this.startInboxLoop();
  }

  /**
   * ProviderLaunch.onSpawn: runs synchronously right after the provider child exists. The
   * pid is journaled (fsync) before the factory's handshake can take seconds, so an actor
   * SIGKILLed in that window never leaves an unrecorded provider. Never throws.
   */
  private onProviderSpawned(id: ProcessIdentity): void {
    this.providerId = id;
    try {
      this.append({ type: 'provider.spawned', pid: id.pid, startTime: id.startTime }, { fsync: true });
    } catch (e) {
      this.log(`could not journal provider.spawned ${id.pid}: ${errMsg(e)}`);
    }
    this.log(`provider spawned pid=${id.pid}`);
    void this.persist();
  }

  // -------------------------------------------------------------------------------
  // Provider events
  // -------------------------------------------------------------------------------

  private async pump(rt: ProviderRuntime): Promise<void> {
    let sawExit = false;
    try {
      for await (const ev of rt.events()) {
        if (ev.type === 'exited') sawExit = true;
        await this.onEvent(ev);
      }
    } catch (e) {
      this.log(`provider event stream failed: ${errMsg(e)}`);
    }
    if (!sawExit) await this.onEvent({ type: 'exited', code: null, signal: null });
  }

  private async onEvent(ev: ProviderEvent): Promise<void> {
    switch (ev.type) {
      case 'ready': {
        if (this.ready) {
          this.log('ignoring duplicate ready');
          return;
        }
        this.ready = true;
        clearTimeout(this.readyTimer);
        // spawn.json FIRST: whoever observes provider.ready must also find the provider
        // session id (codex thread id) and transcript path on disk.
        if (
          this.spec.providerSessionId !== ev.providerSessionId ||
          (ev.transcriptPath !== undefined && this.spec.transcriptPath !== ev.transcriptPath)
        ) {
          this.spec = {
            ...this.spec,
            providerSessionId: ev.providerSessionId,
            ...(ev.transcriptPath ? { transcriptPath: ev.transcriptPath } : {}),
          };
          try {
            writeSpawnSpec(this.spec);
          } catch (e) {
            this.log(`could not persist providerSessionId to spawn.json: ${errMsg(e)}`);
          }
        }
        this.append({
          type: 'provider.ready',
          providerSessionId: ev.providerSessionId,
          providerPid: this.rt?.pid ?? 0,
          ...(ev.transcriptPath ? { transcriptPath: ev.transcriptPath } : {}),
          ...(ev.capabilities ? { capabilities: ev.capabilities } : {}),
          ...(ev.info ? { info: ev.info } : {}),
        });
        this.providerSessionId = ev.providerSessionId;
        this.startFailures = 0;
        this.lastStartError = undefined;
        if (!this.shuttingDown) {
          this.phase = 'running';
          await this.persist();
        }
        this.kick();
        return;
      }
      case 'turn.started':
        this.append({ type: 'turn.started', messageId: ev.messageId });
        if (this.openTurn?.messageId === ev.messageId) this.openTurn.started = true;
        return;
      case 'assistant.text':
        this.append({ type: 'assistant.text', messageId: ev.messageId, text: ev.text });
        return;
      case 'turn.completed':
        this.append({
          type: 'turn.completed',
          messageId: ev.messageId,
          ...(ev.result !== undefined ? { result: ev.result } : {}),
          ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
          ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
        });
        await this.closeTurn(ev.messageId);
        return;
      case 'turn.failed':
        this.append({ type: 'turn.failed', messageId: ev.messageId, error: ev.error });
        await this.closeTurn(ev.messageId);
        return;
      case 'turn.interrupted':
        this.append({ type: 'turn.interrupted', messageId: ev.messageId, reason: 'interrupt' });
        await this.closeTurn(ev.messageId);
        return;
      case 'interrupt.acked':
        this.append({ type: 'interrupt.acked' });
        return;
      case 'permission.requested':
        this.append({
          type: 'permission.requested',
          ...(ev.messageId !== undefined ? { messageId: ev.messageId } : {}),
          detail: ev.detail,
        });
        return;
      case 'exited':
        this.providerExited = true;
        this.append({ type: 'provider.exited', code: ev.code, signal: ev.signal });
        if (!this.shuttingDown) {
          // Not awaited: shutdown waits for this pump to finish.
          void this.shutdown({
            phase: 'suspended',
            reason: 'provider-exit',
            error: `provider exited${this.ready ? '' : ' before ready'} (code=${ev.code} signal=${ev.signal})`,
            stopReason: `provider-exit (code=${ev.code} signal=${ev.signal})`,
            turnReason: 'provider-exit',
            code: 0,
          });
        }
        return;
    }
  }

  /**
   * Outcome journaled → unlink the inbox item and look for the next one. No state.json
   * write here: counters (lastSeq, completedTurns) are derivable from the journal and are
   * refreshed by the heartbeat / phase changes, which keeps the actor out of the lock on
   * the hot path (a SIGKILL inside lock.ts acquire costs the next waker staleMs).
   */
  private async closeTurn(messageId: string): Promise<void> {
    const t = this.openTurn;
    if (!t || t.messageId !== messageId) return;
    this.openTurn = undefined;
    removeInboxItem(this.sid, t.ulid);
    this.kick();
  }

  // -------------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------------

  private startInboxLoop(): void {
    try {
      this.watcher = fs.watch(this.paths.inbox, () => this.kick());
      this.watcher.on('error', () => {});
    } catch (e) {
      this.log(`fs.watch unavailable (${errMsg(e)}); polling only`);
    }
    this.pollTimer = setInterval(() => this.kick(), INBOX_POLL_MS);
    this.kick();
  }

  private kick(): void {
    if (this.shuttingDown || !this.journal) return;
    this.processInbox().catch((e) => this.fatal(e));
  }

  private accept(item: InboxItem): void {
    if (this.ledger.acceptedUlids.has(item.ulid)) return;
    this.append({
      type: 'inbox.accepted',
      ulid: item.ulid,
      kind: item.kind,
      ...(item.kind === 'message' ? { messageId: item.messageId } : {}),
    });
  }

  private async processInbox(): Promise<void> {
    if (this.processing) {
      this.rekick = true;
      return;
    }
    this.processing = true;
    try {
      do {
        this.rekick = false;
        const { items, invalid } = listPendingDetailed(this.sid);
        for (const u of invalid) {
          this.log(`quarantining unreadable inbox item ${u}`);
          quarantineInboxItem(this.sid, u);
        }
        let blocked = false;
        for (const item of items) {
          if (this.shuttingDown) return;
          if (item.kind === 'stop') {
            await this.handleStop(item);
            return;
          }
          if (item.kind === 'interrupt') {
            await this.handleInterrupt(item);
            continue;
          }
          if (this.ledger.intentUlids.has(item.ulid)) {
            // Already turned into an intent (this or a previous incarnation).
            if (this.openTurn?.ulid !== item.ulid) removeInboxItem(this.sid, item.ulid);
            continue;
          }
          if (this.ledger.byMessageId.has(item.messageId)) {
            this.accept(item);
            removeInboxItem(this.sid, item.ulid);
            this.log(`dropped duplicate message ${item.messageId} (${item.ulid})`);
            continue;
          }
          // Strict ULID order, one turn at a time: later messages wait behind this one.
          if (blocked || !this.ready || this.openTurn) {
            blocked = true;
            continue;
          }
          blocked = true;
          await this.startTurn(item);
        }
      } while (this.rekick && !this.shuttingDown);
    } finally {
      this.processing = false;
    }
  }

  private async startTurn(item: Extract<InboxItem, { kind: 'message' }>): Promise<void> {
    this.accept(item);
    this.append({ type: 'turn.intent', messageId: item.messageId, ulid: item.ulid, text: item.text });
    this.openTurn = { messageId: item.messageId, ulid: item.ulid, started: false };
    try {
      if (!this.rt) throw new Error('no provider runtime');
      await this.rt.send(item.messageId, item.text);
    } catch (e) {
      if (this.openTurn?.messageId === item.messageId) {
        this.append({ type: 'turn.failed', messageId: item.messageId, error: `send failed: ${errMsg(e)}` });
        await this.closeTurn(item.messageId);
      }
    }
  }

  private async handleInterrupt(item: InboxItem): Promise<void> {
    this.accept(item);
    let created = NaN;
    try {
      created = ulidTime(item.ulid);
    } catch {
      /* treat as current */
    }
    if (created < this.interruptCutoffMs) {
      this.log(`ignoring stale interrupt ${item.ulid} (predates this actor)`);
    } else if (this.openTurn) {
      this.append({ type: 'interrupt.requested', messageId: this.openTurn.messageId });
      try {
        await this.rt?.interrupt();
      } catch (e) {
        this.log(`interrupt failed: ${errMsg(e)}`);
      }
    } else {
      this.log('interrupt with no open turn: no-op');
    }
    removeInboxItem(this.sid, item.ulid);
  }

  private async handleStop(item: Extract<InboxItem, { kind: 'stop' }>): Promise<void> {
    this.accept(item);
    await this.shutdown({
      phase: 'stopped',
      reason: 'stop',
      stopReason: item.reason ?? 'stop',
      turnReason: 'interrupt',
      graceMs: item.graceMs ?? DEFAULT_STOP_GRACE_MS,
      stopUlid: item.ulid,
      code: 0,
    });
  }

  // -------------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------------

  private fatal(e: unknown): void {
    if (e instanceof LeaseLostError) return this.onLeaseLost();
    this.log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void this.shutdown({
      phase: 'suspended',
      reason: 'error',
      error: errMsg(e),
      stopReason: `error: ${errMsg(e)}`,
      // The provider is still alive unless it already exited: the turn is cut by us.
      turnReason: this.providerExited ? 'provider-exit' : 'interrupt',
      code: 1,
    });
  }

  /**
   * Graceful turn end before the provider is closed: journal interrupt.requested, ask the
   * provider to interrupt, and wait (bounded) for it to report the outcome itself.
   */
  private async interruptOpenTurn(maxWaitMs: number): Promise<void> {
    const t = this.openTurn;
    if (!t || !this.rt || this.providerExited || !this.journal || this.journal.closed) return;
    try {
      this.append({ type: 'interrupt.requested', messageId: t.messageId });
      await withTimeout(this.rt.interrupt(), maxWaitMs);
    } catch (e) {
      this.log(`interrupt before close failed: ${errMsg(e)}`);
    }
    const deadline = Date.now() + maxWaitMs;
    while (this.openTurn === t && !this.providerExited && Date.now() < deadline) await Bun.sleep(20);
    if (this.openTurn === t) this.log(`turn ${t.messageId} still open after interrupt; closing provider`);
  }

  private shutdown(o: ShutdownOptions): Promise<void> {
    if (this.shutdownP) return this.shutdownP;
    this.shuttingDown = true;
    this.shutdownP = this.doShutdown(o)
      .catch((e) => this.log(`shutdown error: ${errMsg(e)}`))
      .finally(() => this.resolveFinished(o.code));
    return this.shutdownP;
  }

  private async doShutdown(o: ShutdownOptions): Promise<void> {
    this.log(`shutting down: ${o.reason}${o.error ? ` (${o.error})` : ''} → ${o.phase}`);
    clearInterval(this.pollTimer);
    clearTimeout(this.readyTimer);
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    const owns = o.ownsState !== false;
    const graceMs = o.graceMs ?? DEFAULT_STOP_GRACE_MS;
    try {
      if (owns && o.phase === 'stopped') {
        // Persisted with its reason: if this actor dies before `stopped`, whoever next
        // takes the lock finishes the stop (finalizeStopLocked) instead of waking it.
        this.phase = 'stopping';
        this.stopReason = o.stopReason;
        await this.persist();
      }
      if (this.starting) await withTimeout(this.starting, graceMs + 10_000);
      if (owns) await this.interruptOpenTurn(Math.min(graceMs, INTERRUPT_BEFORE_CLOSE_MAX_MS));
      if (this.rt && !this.providerExited) {
        await withTimeout(
          this.rt.close({ graceMs }).catch((e) => this.log(`provider close failed: ${errMsg(e)}`)),
          graceMs + 5_000,
        );
      }
      if (this.pumpDone) await withTimeout(this.pumpDone, 5_000);
    } catch (e) {
      this.log(`provider shutdown error: ${errMsg(e)}`);
    }
    // Always: no provider may outlive its actor.
    if (this.providerId) {
      await terminateGroup(this.providerId, 500);
      try {
        signalProcessGroup(this.providerId.pid, 'SIGKILL');
      } catch {
        /* group gone */
      }
    }
    if (!owns) {
      // Another actor owns the session (and its journal) now: never write to it.
      this.log(`not journaling actor.stopped{${o.reason}}: lease lost`);
    } else if (this.journal && !this.journal.closed) {
      try {
        const t = this.openTurn;
        if (t) {
          this.openTurn = undefined;
          this.append({ type: 'turn.interrupted', messageId: t.messageId, reason: o.turnReason });
          removeInboxItem(this.sid, t.ulid);
        }
        // Sticky stop: queued messages will never be delivered — drop them as a fact.
        if (o.phase === 'stopped') {
          for (const item of listPending(this.sid)) {
            if (item.kind !== 'message' || this.ledger.intentUlids.has(item.ulid)) continue;
            this.append({ type: 'inbox.dropped', ulid: item.ulid, messageId: item.messageId, reason: 'stopped' });
            removeInboxItem(this.sid, item.ulid);
          }
        }
        this.append({ type: 'actor.stopped', reason: o.reason, ...(o.error ? { error: o.error } : {}) });
      } catch (e) {
        this.log(`journal write failed during shutdown: ${errMsg(e)}`);
      }
    }
    clearInterval(this.heartbeat);
    let finalWritten = false;
    if (owns) {
      const providerGone = !this.providerId || !isLiveProcess(this.providerId);
      this.phase = o.phase;
      if (!this.ready && (o.reason === 'error' || o.reason === 'provider-exit')) {
        // A start that never reached `ready` (e.g. a resume the provider rejects).
        this.startFailures += 1;
        this.lastStartError = o.error ?? o.stopReason;
      }
      this.stopReason = o.stopReason;
      finalWritten = await this.persist(
        (s) => {
          delete s.lease;
          if (providerGone) delete s.provider;
          else if (this.providerId) s.provider = this.providerId;
        },
        { fsync: true },
      );
    }
    // Consume the stop item only once `stopped` is durable: until then it is the second
    // safety net (a woken actor would process it again) next to `stopping` + stopReason.
    if (o.stopUlid && finalWritten) removeInboxItem(this.sid, o.stopUlid);
    this.journal?.close();
    for (const [ev, fn] of this.handlers) process.off(ev, fn);
    this.log(`stopped (${o.phase})`);
  }

  private installProcessHandlers(): void {
    const onSignal = (sig: NodeJS.Signals) => {
      if (this.shuttingDown) {
        // Second signal while shutting down: hard stop, but never leave the provider behind.
        this.log(`${sig} during shutdown: forcing exit`);
        if (this.providerId) {
          try {
            signalProcessGroup(this.providerId.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        process.exit(1);
      }
      // Host shutdown / service stop: resumable, not sticky.
      void this.shutdown({
        phase: 'suspended',
        reason: 'stop',
        error: sig,
        stopReason: sig,
        turnReason: 'interrupt',
        code: 0,
      });
    };
    const add = (ev: string, fn: (...args: unknown[]) => void) => {
      process.on(ev as 'SIGTERM', fn as () => void);
      this.handlers.push([ev, fn]);
    };
    add('SIGTERM', () => onSignal('SIGTERM'));
    add('SIGINT', () => onSignal('SIGINT'));
    add('uncaughtException', (e) => this.fatal(e));
    add('unhandledRejection', (e) => this.fatal(e));
  }
}

/** Entry for `orc __actor <sessionId>`. Resolves with the process exit code. */
export async function runActorMain(argv: string[]): Promise<number> {
  const sid = argv[0] ?? '';
  try {
    assertValidSessionId(sid);
  } catch (e) {
    process.stderr.write(`orc __actor: ${errMsg(e)}\n`);
    return 2;
  }
  return new Actor(sid).run();
}
