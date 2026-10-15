import { describe, test, expect } from 'bun:test';
import { assertValidMessageId } from '../src/paths.ts';

// Delivery idempotency now lives in the actor kernel (messageId dedupe per session); see
// test/session-actor.test.ts and test/runtime-actor.test.ts.
describe('assertValidMessageId', () => {
  test('accepts safe ids', () => {
    expect(() => assertValidMessageId('abc')).not.toThrow();
    expect(() => assertValidMessageId('a1_b.2-c')).not.toThrow();
    expect(() => assertValidMessageId('01JC0000000000000000000000')).not.toThrow();
  });

  test('rejects traversal and unsafe ids', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'a\0b', '-lead']) {
      expect(() => assertValidMessageId(bad)).toThrow(/invalid messageId/);
    }
  });
});
