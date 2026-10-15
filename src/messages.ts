/**
 * Delivery types for Session.send. Idempotency is enforced by the actor kernel: a
 * messageId is accepted once per session (inbox item or journal intent), and replays
 * return the recorded status without re-submitting (src/runtime/client.ts `send`).
 */

/**
 * Delivery phase of a message (what the provider got — not the turn's outcome).
 * - queued        durably in the session inbox, not yet acknowledged by the provider
 * - acknowledged  the provider accepted it (turn.started journaled)
 * - unknown       cut before any ack (crash/stop): may or may not have reached the
 *                 provider; never re-submitted automatically
 * - failed        the turn failed before any ack (e.g. the write to the provider failed)
 * `prepared` / `submitted` appear only on attempt records written by pre-actor orc.
 */
export type DeliveryPhase = 'queued' | 'acknowledged' | 'unknown' | 'failed' | 'prepared' | 'submitted';

export interface SendOptions {
  /**
   * Idempotency key (default: a fresh ULID). Re-sending the same key returns the recorded
   * status (`replayed: true`) without delivering again; reusing it with DIFFERENT text
   * throws.
   */
  messageId?: string;
  /** Wake a suspended session (default true). false → only queue the message. */
  wake?: boolean;
  /** Bounded wait for the provider's ack (default 10000 ms; 0 → do not wait). */
  ackTimeoutMs?: number;
}

export interface SendResult {
  phase: 'queued' | 'acknowledged' | 'unknown' | 'failed';
  messageId: string;
  /** The key had already been used: nothing new was enqueued. */
  replayed: boolean;
}
