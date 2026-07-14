import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateDeliveryReplay,
  hashPayload,
  persistDelivery,
  readDelivery,
  redactHash,
  toSendResult,
} from '../src/messages.ts';
import type { DeliveryRecord } from '../src/messages.ts';
import { assertValidMessageId, messagePath, messagesDir } from '../src/paths.ts';

const tmpHomes: string[] = [];
async function freshHome(): Promise<void> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-msg-'));
  tmpHomes.push(d);
  process.env.ORC_HOME = path.join(d, 'orc');
  await fs.mkdir(process.env.ORC_HOME, { recursive: true });
}
afterAll(async () => {
  delete process.env.ORC_HOME;
  for (const d of tmpHomes) await fs.rm(d, { recursive: true, force: true });
});

function base(over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    messageId: 'msg-1',
    sessionId: 'sess-a',
    payloadHash: hashPayload('hello'),
    phase: 'prepared',
    attempts: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('hashPayload / redactHash', () => {
  test('SHA-256 is stable and never returns the body', () => {
    const h = hashPayload('secret prompt body');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(hashPayload('secret prompt body'));
    expect(h).not.toBe(hashPayload('other'));
    expect(h).not.toContain('secret');
  });

  test('redactHash shortens long hashes without leaking a body', () => {
    const h = hashPayload('x');
    const r = redactHash(h);
    expect(r.length).toBeLessThan(h.length);
    expect(r).toContain('…');
  });
});

describe('assertValidMessageId / messagePath', () => {
  test('accepts safe ids', () => {
    expect(() => assertValidMessageId('abc')).not.toThrow();
    expect(() => assertValidMessageId('a1_b.2-c')).not.toThrow();
    expect(messagePath('abc')).toMatch(/messages\/abc\.json$/);
  });

  test('rejects traversal and unsafe ids', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'a\0b', '-lead']) {
      expect(() => assertValidMessageId(bad)).toThrow(/invalid messageId/);
    }
  });
});

describe('evaluateDeliveryReplay', () => {
  test('same payload + submitted → replay, no re-submit', () => {
    const r = evaluateDeliveryReplay(base({ phase: 'submitted' }), 'sess-a', hashPayload('hello'));
    expect(r).toMatchObject({ phase: 'submitted', replayed: true, messageId: 'msg-1' });
  });

  test('same payload + acknowledged → replay', () => {
    const r = evaluateDeliveryReplay(
      base({ phase: 'acknowledged' }),
      'sess-a',
      hashPayload('hello'),
    );
    expect(r).toMatchObject({ phase: 'acknowledged', replayed: true });
  });

  test('same payload + unknown → replay (never auto re-submit)', () => {
    const r = evaluateDeliveryReplay(base({ phase: 'unknown' }), 'sess-a', hashPayload('hello'));
    expect(r).toMatchObject({ phase: 'unknown', replayed: true });
  });

  test('same payload + prepared|failed → allow retry (null)', () => {
    expect(evaluateDeliveryReplay(base({ phase: 'prepared' }), 'sess-a', hashPayload('hello'))).toBeNull();
    expect(evaluateDeliveryReplay(base({ phase: 'failed' }), 'sess-a', hashPayload('hello'))).toBeNull();
  });

  test('same messageId + different payload → hash mismatch error (redacted)', () => {
    expect(() =>
      evaluateDeliveryReplay(base({ phase: 'submitted' }), 'sess-a', hashPayload('other')),
    ).toThrow(/payload hash mismatch/);
    try {
      evaluateDeliveryReplay(base({ phase: 'submitted' }), 'sess-a', hashPayload('other'));
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('hello');
      expect(msg).not.toContain('other');
      expect(msg).toContain('…');
    }
  });

  test('same messageId used by another session fails', () => {
    expect(() =>
      evaluateDeliveryReplay(base({ phase: 'prepared' }), 'sess-other', hashPayload('hello')),
    ).toThrow(/already used by session/);
  });
});

describe('persistDelivery / readDelivery', () => {
  beforeEach(() => freshHome());

  test('writes JSON under ORC_HOME/messages with hash only (no body)', async () => {
    const rec = await persistDelivery({
      messageId: 'mid-1',
      sessionId: 's1',
      payloadHash: hashPayload('never store me'),
      phase: 'prepared',
    });
    expect(rec.phase).toBe('prepared');
    expect(rec.attempts).toBe(1);
    const onDisk = await Bun.file(messagePath('mid-1')).text();
    expect(onDisk).not.toContain('never store me');
    expect(onDisk).toContain(rec.payloadHash);
    expect(await readDelivery('mid-1')).toMatchObject({ messageId: 'mid-1', phase: 'prepared' });
    expect(messagesDir()).toContain(process.env.ORC_HOME!);
  });

  test('phase transitions preserve createdAt and bump attempts only on prepared', async () => {
    const first = await persistDelivery({
      messageId: 'mid-2',
      sessionId: 's1',
      payloadHash: hashPayload('p'),
      phase: 'prepared',
    });
    const submitted = await persistDelivery({
      messageId: 'mid-2',
      sessionId: 's1',
      payloadHash: hashPayload('p'),
      phase: 'submitted',
      previous: first,
    });
    expect(submitted.createdAt).toBe(first.createdAt);
    expect(submitted.attempts).toBe(1);
    expect(submitted.phase).toBe('submitted');

    const retried = await persistDelivery({
      messageId: 'mid-2',
      sessionId: 's1',
      payloadHash: hashPayload('p'),
      phase: 'prepared',
      previous: { ...submitted, phase: 'failed' },
    });
    expect(retried.attempts).toBe(2);
  });

  test('toSendResult maps record fields', () => {
    const rec = base({ phase: 'acknowledged', attempts: 3 });
    expect(toSendResult(rec, true)).toEqual({
      phase: 'acknowledged',
      attempts: 3,
      messageId: 'msg-1',
      payloadHash: rec.payloadHash,
      replayed: true,
    });
  });
});
