/**
 * Kernel client API — what the rest of orc calls (S5 builds Session on it).
 *
 * Clients never talk to the actor directly: they write spawn.json/state.json under the
 * `actor-<sid>` lock, drop items into the durable inbox, spawn (wake) the detached actor,
 * and read the journal. Every call is safe from any process and survives the caller's
 * exit; the actor outlives its launcher.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertValidMessageId } from '../paths.ts';
import { selfArgv, spawnDetached } from './process.ts';
import { LEASE_HEARTBEAT_MS, LEASE_TTL_MS, MAX_CONSECUTIVE_START_FAILURES } from './types.ts';
import type { ActorStateFile, ProcessIdentity, SpawnSpec } from './types.ts';
import { ensureSessionDirs, sessionPaths } from './layout.ts';
import { assertValidSessionId, readFileTail } from './fsutil.ts';
import { assertExecutableSpec, readSpawnSpec, validateSpawnSpec, writeSpawnSpec } from './spec.ts';
import { JournalCursor, JournalWriter, readJournal } from './journal.ts';
import { enqueue, listPending, removeInboxItem } from './inbox.ts';
import {
  DEFAULT_STOP_GRACE_MS,
  initialActorState,
  isLiveProcess,
  leaseLive,
  readActorState,
  terminateGroup,
  withActorLock,
  withSessionLock,
  writeActorState,
} from './actor-state.ts';
import { TurnLedger, staleProviders, summarizeLedger, verdictFor } from './derive.ts';
import { abandonedStopReason, finalizeStopLocked, isAbandonedStop } from './stop.ts';
import { withoutInheritedLineage } from './env.ts';
import type { DeliveryVerdict, SessionView } from './derive.ts';

export { readJournal, followJournal, JournalCursor } from './journal.ts';
export type { FollowJournalOptions, ReadJournalOptions } from './journal.ts';
export { deriveState, summarizeJournal, verdictFor } from './derive.ts';
export type {
  DeliveryVerdict,
  DerivedState,
  JournalSummary,
  PermissionRecord,
  SessionView,
  TurnOutcome,
  TurnRecord,
} from './derive.ts';
export { sessionPaths } from './layout.ts';
export { leaseLive, isLiveProcess, DEFAULT_STOP_GRACE_MS } from './actor-state.ts';

export const DEFAULT_START_TIMEOUT_MS = 15_000;
export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

export class SessionStoppedError extends Error {
  readonly code = 'ORC_SESSION_STOPPED';
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is stopped (stop is sticky; it never wakes)`);
    this.name = 'SessionStoppedError';
  }
}

/**
 * The session's actor could not get its provider to `ready` — on create, or for
 * MAX_CONSECUTIVE_START_FAILURES wakes in a row (auto-wake is then refused until an
 * explicit `ensureAwake(sid, { force: true })`). Never retried as a fresh session.
 */
export class SessionStartError extends Error {
  readonly code = 'ORC_SESSION_START_FAILED';
  constructor(
    readonly sessionId: string,
    message: string,
    readonly failures: number,
    readonly lastError?: string,
  ) {
    super(message);
    this.name = 'SessionStartError';
  }
}

export class UnknownSessionError extends Error {
  readonly code = 'ORC_SESSION_UNKNOWN';
  constructor(readonly sessionId: string) {
    super(`unknown session ${sessionId} (no spawn.json)`);
    this.name = 'UnknownSessionError';
  }
}

function logTail(sessionId: string): string {
  const t = readFileTail(sessionPaths(sessionId).actorLog, 2_000).trim();
  return t ? `\n--- actor.log (tail) ---\n${t}` : '';
}

function requireSpec(sessionId: string): SpawnSpec {
  const spec = readSpawnSpec(sessionId);
  if (!spec) throw new UnknownSessionError(sessionId);
  return spec;
}

// ---------------------------------------------------------------------------------
// Spawning the actor
// ---------------------------------------------------------------------------------

/**
 * Spawn the actor and pre-register its lease (caller holds the actor lock). Recording the
 * lease for the child's pid here makes the session live immediately, so a concurrent
 * waker sees it and never spawns a second actor; the actor adopts it on start.
 */
function spawnActorLocked(sessionId: string, state: ActorStateFile): ProcessIdentity {
  const spec = requireSpec(sessionId);
  const actor = spawnDetached([...selfArgv(), '__actor', sessionId], {
    cwd: spec.cwd,
    // Never hand the WAKER's lineage (ORC_RESULT_PATH, ORC_ATTEMPT_ID, …) to the session.
    env: withoutInheritedLineage(process.env),
    logPath: sessionPaths(sessionId).actorLog,
  });
  const next: ActorStateFile = {
    ...state,
    phase: 'starting',
    lease: {
      pid: actor.pid,
      startTime: actor.startTime,
      token: `launch-${randomUUID()}`,
      expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  delete next.stopReason;
  writeActorState(next, { fsync: true });
  return actor;
}

/**
 * Host sleep (laptops): an actor whose process is alive but whose lease expired is most
 * likely healthy and renews on its next heartbeat. Give it one heartbeat (+1 s) before
 * anyone treats it as wedged and kills it. Returns true when the lease is live (again).
 * Called WITHOUT the actor lock (the actor needs it to renew).
 */
async function awaitLeaseRenewal(sessionId: string): Promise<boolean> {
  const st = readActorState(sessionId);
  if (leaseLive(st)) return true;
  const active = st?.phase === 'starting' || st?.phase === 'running' || st?.phase === 'stopping';
  if (!st?.lease || !active || !isLiveProcess(st.lease)) return false;
  const deadline = Date.now() + LEASE_HEARTBEAT_MS + 1_000;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    const cur = readActorState(sessionId);
    if (leaseLive(cur)) return true;
    if (!cur?.lease || !isLiveProcess(cur.lease)) return false;
  }
  return false;
}

/**
 * Kill every provider that may outlive a dead actor (caller holds the actor lock and no
 * actor is live): state.provider plus journaled provider.spawned with no provider.exited.
 */
async function terminateStaleProviders(sessionId: string, st: ActorStateFile): Promise<void> {
  for (const id of staleProviders(st, TurnLedger.from(readJournal(sessionId)))) {
    await terminateGroup(id, 1_000);
  }
  if (st.provider && !isLiveProcess(st.provider)) delete st.provider;
}

/** The launched actor died before journaling actor.started: release its lease. */
async function markStartFailed(sessionId: string, actor: ProcessIdentity): Promise<void> {
  await withActorLock(sessionId, async () => {
    const st = readActorState(sessionId);
    if (!st || st.phase === 'stopped' || st.lease?.pid !== actor.pid || isLiveProcess(actor)) return;
    st.phase = 'suspended';
    st.stopReason = 'start-failed';
    st.startFailures = (st.startFailures ?? 0) + 1;
    st.lastStartError = 'actor exited before starting';
    delete st.lease;
    st.updatedAt = new Date().toISOString();
    writeActorState(st, { fsync: true });
  });
}

/** Wait until `actor` journals actor.started; fail fast (with the log tail) if it dies. */
/**
 * Wait for a freshly spawned actor: first its actor.started (throws — with the actor.log
 * tail — if it dies or times out before that), then the start outcome: provider.ready →
 * ok; actor.stopped (error / provider exit) or the actor dying → `sessionError` (fail
 * fast, never a silent `queued`). Still starting at the deadline → ok (the actor is up).
 */
async function waitForActorStart(
  sessionId: string,
  actor: ProcessIdentity,
  timeoutMs: number,
): Promise<{ sessionError?: string }> {
  const cursor = JournalCursor.forSession(sessionId);
  const deadline = Date.now() + timeoutMs;
  let started = false;
  const scan = (): { sessionError?: string } | undefined => {
    for (const e of cursor.readNew()) {
      if (!started) {
        started = e.type === 'actor.started' && e.pid === actor.pid;
        continue;
      }
      if (e.type === 'provider.ready') return {};
      if (e.type === 'actor.stopped') {
        if (e.reason === 'stop') return {};
        return {
          sessionError: `actor stopped during start (${e.reason}${e.error ? `: ${e.error}` : ''})${logTail(sessionId)}`,
        };
      }
    }
    return undefined;
  };
  // A failed start is journaled just before the actor's final state write (startFailures,
  // lease release): return only once that is visible, so callers act on settled state.
  const settled = async (o: { sessionError?: string }) => {
    if (o.sessionError) {
      const until = Date.now() + 5_000;
      while (Date.now() < until && isLiveProcess(actor) && leaseLive(readActorState(sessionId))) await Bun.sleep(20);
    }
    return o;
  };
  while (true) {
    const outcome = scan();
    if (outcome) return settled(outcome);
    if (!isLiveProcess(actor)) {
      const last = scan();
      if (last) return settled(last);
      if (started) return { sessionError: `actor ${actor.pid} exited during start${logTail(sessionId)}` };
      await markStartFailed(sessionId, actor);
      throw new Error(`actor ${actor.pid} for session ${sessionId} exited before starting${logTail(sessionId)}`);
    }
    if (Date.now() >= deadline) {
      if (started) return {};
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for actor ${actor.pid} of session ${sessionId}${logTail(sessionId)}`,
      );
    }
    await Bun.sleep(20);
  }
}

// ---------------------------------------------------------------------------------
// createSession / ensureAwake
// ---------------------------------------------------------------------------------

export interface CreateSessionOptions {
  /** Bounded wait for actor.started. Default 15 s. */
  startTimeoutMs?: number;
  /** Policy hook (e.g. maxConcurrentSessions) run under the actor lock before anything is written. */
  beforeSpawn?: () => Promise<void>;
}

/**
 * Create a session: validate the spec, write spawn.json (fsync) + initial state.json,
 * spawn the detached actor and wait for actor.started. Throws if the session exists or
 * the actor dies before starting (the error carries the actor.log tail).
 */
export async function createSession(
  spec: SpawnSpec,
  opts: CreateSessionOptions = {},
): Promise<{ actor: ProcessIdentity }> {
  validateSpawnSpec(spec);
  if (!fs.existsSync(spec.cwd)) throw new Error(`spawn spec cwd does not exist: ${spec.cwd}`);
  const sid = spec.sessionId;
  const actor = await withActorLock(sid, async () => {
    if (fs.existsSync(sessionPaths(sid).spawn)) throw new Error(`session ${sid} already exists`);
    await opts.beforeSpawn?.();
    ensureSessionDirs(sid);
    writeSpawnSpec(spec);
    return spawnActorLocked(sid, initialActorState(sid));
  });
  const { sessionError } = await waitForActorStart(sid, actor, opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  if (sessionError) {
    throw new SessionStartError(sid, `session ${sid} failed to start: ${sessionError}`, 1, sessionError);
  }
  return { actor };
}

export interface EnsureAwakeOptions {
  /**
   * Wake even after MAX_CONSECUTIVE_START_FAILURES failed starts (an explicit resume).
   * Without it such a session throws SessionStartError instead of being woken again.
   */
  force?: boolean;
  /** Policy hook run under the actor lock just before a spawn (never when already live). */
  beforeSpawn?: () => Promise<void>;
  startTimeoutMs?: number;
}

export type EnsureAwakeResult =
  | { status: 'live'; actor: ProcessIdentity }
  /** `sessionError`: the actor started but its provider failed before `ready` (it has exited). */
  | { status: 'started'; actor: ProcessIdentity; sessionError?: string }
  | { status: 'stopped' };

/**
 * Make sure a live actor owns the session. Under the actor lock: live lease → no-op;
 * stopped → 'stopped' (never wakes); otherwise run `beforeSpawn`, terminate a wedged
 * actor and any recorded stale provider group, spawn the actor (it decides fresh vs
 * resume) and wait for actor.started. Concurrent callers yield exactly one actor.
 */
export async function ensureAwake(sessionId: string, opts: EnsureAwakeOptions = {}): Promise<EnsureAwakeResult> {
  assertValidSessionId(sessionId);
  await awaitLeaseRenewal(sessionId);
  const r = await withActorLock(sessionId, async (): Promise<EnsureAwakeResult> => {
    assertExecutableSpec(requireSpec(sessionId));
    const st = readActorState(sessionId) ?? initialActorState(sessionId, 'suspended');
    if (leaseLive(st) && st.lease) {
      return { status: 'live', actor: { pid: st.lease.pid, startTime: st.lease.startTime } };
    }
    if (st.phase === 'stopped') return { status: 'stopped' };
    if (isAbandonedStop(st)) {
      // The actor died mid-stop (phase `stopping`, lease dead): finish that stop — it is
      // sticky — instead of waking the session.
      await finalizeStopLocked(sessionId, st, abandonedStopReason(sessionId, st));
      return { status: 'stopped' };
    }
    const failures = st.startFailures ?? 0;
    if (failures >= MAX_CONSECUTIVE_START_FAILURES && !opts.force) {
      throw new SessionStartError(
        sessionId,
        `session ${sessionId} failed to start ${failures} times in a row (last: ${st.lastStartError ?? 'unknown'}); ` +
          'not auto-waking — resume explicitly with ensureAwake(sid, { force: true })',
        failures,
        st.lastStartError,
      );
    }
    await opts.beforeSpawn?.();
    // Alive but lease expired = wedged actor: it must not keep writing.
    if (st.lease && isLiveProcess(st.lease)) await terminateGroup(st.lease, 1_000);
    // Orphaned providers from crashed actors (state.json + unexited provider.spawned):
    // kill before a new one can start.
    await terminateStaleProviders(sessionId, st);
    return { status: 'started', actor: spawnActorLocked(sessionId, st) };
  });
  if (r.status === 'started') {
    const { sessionError } = await waitForActorStart(
      sessionId,
      r.actor,
      opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
    if (sessionError) return { ...r, sessionError };
  }
  return r;
}

// ---------------------------------------------------------------------------------
// send / interrupt / stop
// ---------------------------------------------------------------------------------

export interface SendOptions {
  /** Wake a suspended session (default true). false → enqueue only (still waits for an ack if live). */
  wake?: boolean;
  /** Policy hook run before a wake spawns the actor (e.g. enforceSpawnPolicy). */
  beforeWake?: () => Promise<void>;
  /** Bounded wait for turn.started. Default 10 s; 0 → do not wait. */
  ackTimeoutMs?: number;
  startTimeoutMs?: number;
}

/**
 * Delivery status (what the provider got), not the turn's outcome — see `delivery` for that.
 * acknowledged — turn.started journaled: the provider accepted it (whatever the turn's
 *                outcome since: completed, failed, interrupted, or cut by a crash)
 * queued       — durably in the inbox / in flight, not yet acknowledged (ack timeout,
 *                `wake: false`, actor down)
 * failed       — the turn failed BEFORE any ack (e.g. the write to the provider failed)
 * unknown      — intent written but the turn was cut before any ack (never auto-resent)
 */
export type SendVerdict = 'acknowledged' | 'queued' | 'failed' | 'unknown';

export interface SendResult {
  ulid: string;
  verdict: SendVerdict;
  /** Fine-grained status incl. the turn outcome when already known (see DeliveryVerdict). */
  delivery: DeliveryVerdict;
  /** An item or intent for this messageId already existed: nothing new was enqueued. */
  duplicate: boolean;
  /** This call spawned the actor. */
  woke: boolean;
  /**
   * The wake failed: the provider did not start (or auto-wake is refused after repeated
   * failed starts). The message stays durably queued for an explicit resume.
   */
  sessionError?: string;
}

/** Coarse send verdict; `acked` = a turn.started exists for the message. */
export function coarseVerdict(v: DeliveryVerdict, acked = false): SendVerdict {
  if (acked) return 'acknowledged';
  switch (v) {
    case 'acknowledged':
    case 'completed':
    case 'interrupted':
      return 'acknowledged';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      return 'queued';
  }
}

async function waitForDelivery(
  sessionId: string,
  messageId: string,
  timeoutMs: number,
): Promise<{ delivery: DeliveryVerdict; acked: boolean; dropped: boolean }> {
  const cursor = JournalCursor.forSession(sessionId);
  const ledger = new TurnLedger();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let live = leaseLive(readActorState(sessionId));
  let liveCheckedAt = Date.now();
  while (true) {
    for (const e of cursor.readNew()) ledger.apply(e);
    const turn = ledger.byMessageId.get(messageId);
    const acked = turn?.startedSeq !== undefined;
    const dropped = !turn && ledger.dropped.has(messageId);
    if (dropped) return { delivery: 'failed', acked: false, dropped: true };
    const v = verdictFor(turn, true, live);
    if (v !== 'queued') return { delivery: v, acked, dropped: false };
    if (!live || Date.now() >= deadline) {
      if (turn) return { delivery: v, acked, dropped: false };
      const inInbox = listPending(sessionId).some((i) => i.kind === 'message' && i.messageId === messageId);
      return { delivery: inInbox ? 'queued' : verdictFor(undefined, false, live), acked: false, dropped: false };
    }
    await Bun.sleep(25);
    if (Date.now() - liveCheckedAt >= 200) {
      live = leaseLive(readActorState(sessionId));
      liveCheckedAt = Date.now();
    }
  }
}

/**
 * Durably enqueue a message, wake the session (unless `wake: false`) and wait (bounded)
 * for its turn.started. Idempotent per messageId: if an inbox item or a journal intent
 * for it already exists nothing is enqueued and its current status is returned.
 * A wake rejected by `beforeWake` (policy) drops the message (inbox.dropped{policy}) and
 * rethrows: a later wake must never deliver it behind the caller's back.
 * Throws SessionStoppedError for a stopped or stopping session — also when the stop lands
 * while the message waits (it is then dropped with an inbox.dropped fact, never left
 * queued in a session that will not wake).
 */
export async function send(
  sessionId: string,
  msg: { messageId: string; text: string },
  opts: SendOptions = {},
): Promise<SendResult> {
  assertValidSessionId(sessionId);
  assertValidMessageId(msg.messageId);
  if (typeof msg.text !== 'string') throw new Error('message text must be a string');
  assertExecutableSpec(requireSpec(sessionId));

  let ulid = '';
  let duplicate = false;
  let known: DeliveryVerdict | undefined;
  let knownAcked = false;
  await withSessionLock(`send-${sessionId}`, async () => {
    // Inbox before journal: an item is unlinked only after its intent is journaled.
    const pending = listPending(sessionId).find((i) => i.kind === 'message' && i.messageId === msg.messageId);
    if (pending) {
      ulid = pending.ulid;
      duplicate = true;
      return;
    }
    const turn = TurnLedger.from(readJournal(sessionId)).byMessageId.get(msg.messageId);
    if (turn) {
      ulid = turn.ulid;
      duplicate = true;
      known = verdictFor(turn, false, leaseLive(readActorState(sessionId)));
      knownAcked = turn.startedSeq !== undefined;
      return;
    }
    if (isStopPhase(readActorState(sessionId)?.phase)) throw new SessionStoppedError(sessionId);
    ulid = enqueue(sessionId, { kind: 'message', messageId: msg.messageId, text: msg.text }).ulid;
  });
  if (known !== undefined && known !== 'queued') {
    return { ulid, verdict: coarseVerdict(known, knownAcked), delivery: known, duplicate, woke: false };
  }

  let woke = false;
  let sessionError: string | undefined;
  if (opts.wake !== false) {
    const beforeWake = opts.beforeWake;
    // Runs under the actor lock with no live actor (ensureAwake only calls it before a
    // spawn). A rejected wake (policy) must not leave this message queued for a LATER wake
    // to deliver behind the caller's back: drop it atomically, then rethrow.
    const beforeSpawn = beforeWake
      ? async () => {
          try {
            await beforeWake();
          } catch (e) {
            dropPendingLocked(sessionId, ulid, 'policy');
            throw e;
          }
        }
      : undefined;
    let r: EnsureAwakeResult;
    try {
      r = await ensureAwake(sessionId, {
        ...(beforeSpawn ? { beforeSpawn } : {}),
        ...(opts.startTimeoutMs !== undefined ? { startTimeoutMs: opts.startTimeoutMs } : {}),
      });
    } catch (e) {
      if (!(e instanceof SessionStartError)) throw e;
      return { ulid, verdict: 'queued', delivery: 'queued', duplicate, woke: false, sessionError: e.message };
    }
    if (r.status === 'started' && r.sessionError) sessionError = r.sessionError;
    if (r.status === 'stopped') {
      // stop() landed between our phase check and the wake: never leave it queued.
      await dropIfUndelivered(sessionId, ulid);
      throw new SessionStoppedError(sessionId);
    }
    woke = r.status === 'started';
  }
  const { delivery, acked, dropped } = await waitForDelivery(
    sessionId,
    msg.messageId,
    opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
  );
  if (!acked && (delivery === 'queued' || dropped) && isStopPhase(readActorState(sessionId)?.phase)) {
    // Stopped (or stopping) while we waited: the message can never be delivered.
    await dropIfUndelivered(sessionId, ulid);
    throw new SessionStoppedError(sessionId);
  }
  return {
    ulid,
    verdict: coarseVerdict(delivery, acked),
    delivery,
    duplicate,
    woke,
    ...(sessionError ? { sessionError } : {}),
  };
}

function isStopPhase(phase: ActorStateFile['phase'] | undefined): boolean {
  return phase === 'stopped' || phase === 'stopping';
}

/**
 * A message queued into a session that is (being) stopped: once no actor is live, remove
 * it with an inbox.dropped fact (unless it already became an intent or was dropped). A
 * live stopping actor drops queued messages itself, so wait for it first.
 */
async function dropIfUndelivered(sessionId: string, ulid: string): Promise<void> {
  const deadline = Date.now() + DEFAULT_STOP_GRACE_MS + 10_000;
  while (leaseLive(readActorState(sessionId)) && Date.now() < deadline) await Bun.sleep(25);
  await withActorLock(sessionId, async () => {
    if (leaseLive(readActorState(sessionId))) return;
    dropPendingLocked(sessionId, ulid, 'stopped');
  });
}

/**
 * Remove a still-queued message with an inbox.dropped fact (unless it already became an
 * intent). Caller holds the actor lock and no actor is live (sole journal writer).
 */
function dropPendingLocked(sessionId: string, ulid: string, reason: 'stopped' | 'policy'): void {
  const item = listPending(sessionId).find((i) => i.ulid === ulid);
  if (!item || item.kind !== 'message') return;
  if (TurnLedger.from(readJournal(sessionId)).intentUlids.has(ulid)) return;
  const j = JournalWriter.forSession(sessionId);
  try {
    j.append({ type: 'inbox.dropped', ulid, messageId: item.messageId, reason });
  } finally {
    j.close();
  }
  removeInboxItem(sessionId, ulid);
}

/**
 * Interrupt the open turn. Only enqueued when the actor is live (a suspended session has
 * no open turn, and a stale interrupt must not hit a future turn). The actor treats an
 * interrupt with no open turn as a no-op.
 */
export async function interrupt(
  sessionId: string,
): Promise<{ status: 'requested'; ulid: string } | { status: 'not-live' }> {
  assertValidSessionId(sessionId);
  if (!leaseLive(readActorState(sessionId))) return { status: 'not-live' };
  return { status: 'requested', ulid: enqueue(sessionId, { kind: 'interrupt' }).ulid };
}

export interface StopOptions {
  /** Provider close grace before its group is killed. Default 5 s. */
  graceMs?: number;
  /** Recorded as stopReason. */
  reason?: string;
  /** Extra wait (beyond graceMs) for a live actor to stop before forcing. Default 10 s. */
  timeoutMs?: number;
}

/**
 * Stop the session (sticky: it never wakes again). A live actor gets a stop item and is
 * waited for; if no actor is live (or it does not stop in time) the session is stopped
 * directly under the lock: the actor and any recorded provider group are terminated, open
 * intents closed as recovered, actor.stopped journaled and the phase set to `stopped`.
 */
export async function stop(
  sessionId: string,
  opts: StopOptions = {},
): Promise<{ status: 'stopped' | 'already-stopped' }> {
  assertValidSessionId(sessionId);
  requireSpec(sessionId);
  const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
  if (readActorState(sessionId)?.phase === 'stopped') return { status: 'already-stopped' };

  let asked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let st = readActorState(sessionId);
    if (st?.phase === 'stopped') return { status: 'stopped' };
    if (!leaseLive(st) && (await awaitLeaseRenewal(sessionId))) st = readActorState(sessionId);
    if (leaseLive(st) && !asked) {
      asked = true;
      const item = enqueue(sessionId, { kind: 'stop', graceMs, ...(opts.reason ? { reason: opts.reason } : {}) });
      const deadline = Date.now() + graceMs + (opts.timeoutMs ?? 10_000);
      while (Date.now() < deadline) {
        const cur = readActorState(sessionId);
        if (cur?.phase === 'stopped') {
          // The actor unlinks the stop item right after its final state write.
          const until = Date.now() + 3_000;
          while (Date.now() < until && listPending(sessionId).some((i) => i.ulid === item.ulid)) await Bun.sleep(10);
          removeInboxItem(sessionId, item.ulid);
          return { status: 'stopped' };
        }
        if (!leaseLive(cur)) break;
        await Bun.sleep(25);
      }
    }
    const r = await withActorLock(sessionId, async (): Promise<'retry' | 'stopped'> => {
      const cur = readActorState(sessionId) ?? initialActorState(sessionId, 'suspended');
      if (cur.phase === 'stopped') return 'stopped';
      // Someone woke it meanwhile: ask it to stop first (once).
      if (leaseLive(cur) && !asked) return 'retry';
      // An actor that died mid-stop keeps the reason it persisted with `stopping`.
      const reason =
        cur.phase === 'stopping' ? abandonedStopReason(sessionId, cur, opts.reason) : (opts.reason ?? 'stop');
      await finalizeStopLocked(sessionId, cur, reason);
      return 'stopped';
    });
    if (r === 'stopped') return { status: 'stopped' };
  }
  throw new Error(`could not stop session ${sessionId}`);
}

// ---------------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------------

/** Gather everything deriveState needs (inbox, then journal, then state). Read-only. */
export function inspect(sessionId: string, opts: { tail?: number } = {}): SessionView {
  assertValidSessionId(sessionId);
  const pending = listPending(sessionId);
  const spec = readSpawnSpec(sessionId);
  const entries = readJournal(sessionId);
  const ledger = TurnLedger.from(entries);
  const actor = readActorState(sessionId);
  const msgs = pending.filter(
    (i): i is Extract<typeof i, { kind: 'message' }> =>
      i.kind === 'message' && !ledger.intentUlids.has(i.ulid) && !ledger.byMessageId.has(i.messageId),
  );
  return {
    sessionId,
    exists: !!spec,
    ...(spec ? { spec } : {}),
    ...(actor ? { actor } : {}),
    live: leaseLive(actor),
    pending: {
      messages: msgs.length,
      interrupts: pending.filter((i) => i.kind === 'interrupt').length,
      stops: pending.filter((i) => i.kind === 'stop').length,
      messageIds: msgs.map((m) => m.messageId),
    },
    summary: summarizeLedger(ledger),
    tail: entries.slice(-(opts.tail ?? 20)),
    observedAt: new Date().toISOString(),
  };
}

/** Delivery verdict for one messageId (brief decision 1). Read-only. */
export function deliveryVerdict(sessionId: string, messageId: string): DeliveryVerdict {
  assertValidSessionId(sessionId);
  const inInbox = listPending(sessionId).some((i) => i.kind === 'message' && i.messageId === messageId);
  const ledger = TurnLedger.from(readJournal(sessionId));
  return verdictFor(
    ledger.byMessageId.get(messageId),
    inInbox,
    leaseLive(readActorState(sessionId)),
    ledger.dropped.has(messageId),
  );
}

/** spawn.json exists for this session. */
export function sessionExists(sessionId: string): boolean {
  return readSpawnSpec(assertValidSessionId(sessionId)) !== undefined;
}

// ---------------------------------------------------------------------------------
// S5 additions (cutover): reopen a stopped session; look up a message's recorded text.
// ---------------------------------------------------------------------------------

/**
 * Clear a sticky stop so the session can be woken again (`orc resume` after kill or
 * takeover). Under the actor lock: phase `stopped` → `suspended`, journaling
 * `actor.reopened` (no actor is live while stopped, so the lock holder is the only
 * journal writer). Any other phase is left alone (`not-stopped`). Never spawns.
 */
export async function reopen(
  sessionId: string,
  opts: { reason?: string } = {},
): Promise<{ status: 'reopened' | 'not-stopped' }> {
  assertValidSessionId(sessionId);
  return withActorLock(sessionId, async () => {
    assertExecutableSpec(requireSpec(sessionId));
    const st = readActorState(sessionId);
    // A stop interrupted by an actor crash is finished first, then reopened like any stop.
    if (st && !leaseLive(st) && isAbandonedStop(st)) {
      await finalizeStopLocked(sessionId, st, abandonedStopReason(sessionId, st));
    }
    if (!st || st.phase !== 'stopped' || leaseLive(st)) return { status: 'not-stopped' as const };
    const j = JournalWriter.forSession(sessionId);
    try {
      j.append({ type: 'actor.reopened', ...(opts.reason ? { reason: opts.reason } : {}) });
      st.lastSeq = Math.max(st.lastSeq, j.lastSeq);
    } finally {
      j.close();
    }
    st.phase = 'suspended';
    delete st.stopReason;
    delete st.lease;
    st.updatedAt = new Date().toISOString();
    writeActorState(st, { fsync: true });
    return { status: 'reopened' as const };
  });
}

/**
 * The text recorded for `messageId`: its pending inbox item, else its `turn.intent`.
 * Undefined when the message was never seen. Used to refuse reusing an idempotency key
 * with a different payload.
 */
export function messageText(sessionId: string, messageId: string): string | undefined {
  assertValidSessionId(sessionId);
  const pending = listPending(sessionId).find((i) => i.kind === 'message' && i.messageId === messageId);
  if (pending && pending.kind === 'message') return pending.text;
  for (const e of readJournal(sessionId)) {
    if (e.type === 'turn.intent' && e.messageId === messageId) return e.text;
  }
  return undefined;
}
