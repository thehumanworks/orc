/**
 * Durable idempotent delivery records for Session.send.
 *
 * Records live under ~/.orc/messages/<messageId>.json and store a SHA-256 of the
 * prompt payload — never the prompt body itself. Phases:
 *   prepared → submitted → acknowledged | unknown
 *   prepared → failed
 *
 * Replay rules (same messageId):
 *   - same payload + submitted|acknowledged → return existing (no re-submit)
 *   - same payload + unknown → return existing (never auto re-submit unknown)
 *   - same payload + prepared|failed → allow retry
 *   - different payload → fail
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { messagesDir, messagePath, assertValidMessageId } from './paths.ts';

export type DeliveryPhase = 'prepared' | 'submitted' | 'acknowledged' | 'unknown' | 'failed';

export interface DeliveryRecord {
  messageId: string;
  sessionId: string;
  /** SHA-256 hex of the exact prompt bytes sent (UTF-8). */
  payloadHash: string;
  phase: DeliveryPhase;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface SendOptions {
  /**
   * Caller-supplied idempotency key. When set, delivery is recorded under ORC_HOME
   * and same-key replays follow the durable phase rules.
   */
  messageId?: string;
}

export interface SendResult {
  phase: DeliveryPhase;
  attempts: number;
  messageId?: string;
  payloadHash?: string;
  /** True when an existing durable record was returned without re-submitting. */
  replayed?: boolean;
}

/** SHA-256 hex digest of prompt text (UTF-8). Never log/store the raw body. */
export function hashPayload(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** Short redacted form for errors (full hash is fine; body must never appear). */
export function redactHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

async function writeRecordAtomic(rec: DeliveryRecord): Promise<void> {
  assertValidMessageId(rec.messageId);
  const dir = messagesDir();
  await fs.mkdir(dir, { recursive: true });
  const target = messagePath(rec.messageId);
  const tmp = path.join(dir, `.msg.${randomUUID()}.tmp`);
  await Bun.write(tmp, JSON.stringify(rec, null, 2));
  await fs.rename(tmp, target);
}

/** Read a delivery record by messageId. Invalid id throws; missing/corrupt → null. */
export async function readDelivery(messageId: string): Promise<DeliveryRecord | null> {
  assertValidMessageId(messageId);
  const f = Bun.file(messagePath(messageId));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as DeliveryRecord;
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing record blocks a new submit. Returns a SendResult when
 * the caller must NOT re-submit; returns null when a (re)try is allowed. Throws on
 * hash/session conflicts.
 */
export function evaluateDeliveryReplay(
  existing: DeliveryRecord,
  sessionId: string,
  payloadHash: string,
): SendResult | null {
  if (existing.sessionId !== sessionId) {
    throw new Error(
      `messageId '${existing.messageId}' already used by session ${existing.sessionId} ` +
        `(this session is ${sessionId})`,
    );
  }
  if (existing.payloadHash !== payloadHash) {
    throw new Error(
      `messageId '${existing.messageId}' payload hash mismatch ` +
        `(stored ${redactHash(existing.payloadHash)}, got ${redactHash(payloadHash)})`,
    );
  }
  if (existing.phase === 'submitted' || existing.phase === 'acknowledged') {
    return {
      phase: existing.phase,
      attempts: existing.attempts,
      messageId: existing.messageId,
      payloadHash: existing.payloadHash,
      replayed: true,
    };
  }
  if (existing.phase === 'unknown') {
    // Never automatically re-submit an unproven delivery.
    return {
      phase: 'unknown',
      attempts: existing.attempts,
      messageId: existing.messageId,
      payloadHash: existing.payloadHash,
      replayed: true,
    };
  }
  // prepared | failed → allow retry
  return null;
}

/** Create or update a delivery record to `phase`. Bumps attempts when moving to prepared. */
export async function persistDelivery(args: {
  messageId: string;
  sessionId: string;
  payloadHash: string;
  phase: DeliveryPhase;
  /** When true, increment attempts (default for prepared transitions). */
  bumpAttempts?: boolean;
  previous?: DeliveryRecord | null;
}): Promise<DeliveryRecord> {
  const now = new Date().toISOString();
  const prev = args.previous ?? (await readDelivery(args.messageId));
  let attempts = prev?.attempts ?? 0;
  if (args.bumpAttempts === true || (args.bumpAttempts === undefined && args.phase === 'prepared')) {
    attempts += 1;
  } else if (prev) {
    attempts = prev.attempts;
  }

  const rec: DeliveryRecord = {
    messageId: args.messageId,
    sessionId: args.sessionId,
    payloadHash: args.payloadHash,
    phase: args.phase,
    attempts,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await writeRecordAtomic(rec);
  return rec;
}

export function toSendResult(rec: DeliveryRecord, replayed = false): SendResult {
  return {
    phase: rec.phase,
    attempts: rec.attempts,
    messageId: rec.messageId,
    payloadHash: rec.payloadHash,
    ...(replayed ? { replayed: true } : {}),
  };
}
