/**
 * S5 kernel additions: reopen() (clear a sticky stop) and messageText() (recorded text of
 * an idempotency key). Real detached actors over the scripted fake provider.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { TEARDOWN_TIMEOUT_MS } from './runtime-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  SessionStoppedError,
  createSession,
  deriveState,
  ensureAwake,
  inspect,
  messageText,
  readJournal,
  reopen,
  send,
  stop,
} from '../src/runtime/client.ts';
import { readActorState } from '../src/runtime/actor-state.ts';
import { fakeSpec, killSessionProcesses, mkTmp, waitCompleted } from './runtime-helpers.ts';

const T = 30_000;
const prevHome = process.env.ORC_HOME;
const root = mkTmp('orc-reopen-it-');
const home = path.join(root, 'orc');
const sids: string[] = [];

beforeEach(() => {
  process.env.ORC_HOME = home;
});

afterAll(async () => {
  await killSessionProcesses(sids);
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
}, TEARDOWN_TIMEOUT_MS);

describe('reopen', () => {
  test(
    'stopped → suspended (journals actor.reopened); the session wakes and keeps its history',
    async () => {
      const spec = fakeSpec(mkTmp('orc-reopen-cwd-'));
      sids.push(spec.sessionId);
      const sid = spec.sessionId;
      await createSession(spec);
      await send(sid, { messageId: 'm1', text: 'one' });
      await waitCompleted(sid, 'm1');
      await stop(sid, { reason: 'takeover' });
      expect(readActorState(sid)?.phase).toBe('stopped');
      await expect(send(sid, { messageId: 'm2', text: 'two' })).rejects.toBeInstanceOf(SessionStoppedError);

      expect((await reopen(sid, { reason: 'resume' })).status).toBe('reopened');
      const st = readActorState(sid);
      expect(st?.phase).toBe('suspended');
      expect(st?.stopReason).toBeUndefined();
      expect(readJournal(sid).some((e) => e.type === 'actor.reopened')).toBe(true);
      const d = deriveState(inspect(sid));
      expect(d.stopped).toBe(false);
      expect(d.suspended).toBe(true);

      // Second reopen is a no-op.
      expect((await reopen(sid)).status).toBe('not-stopped');

      const r = await ensureAwake(sid);
      expect(r.status).toBe('started');
      const s2 = await send(sid, { messageId: 'm2', text: 'two' });
      expect(s2.verdict).toBe('acknowledged');
      await waitCompleted(sid, 'm2');
      await stop(sid);
    },
    T,
  );

  test('reopen on a missing session throws', async () => {
    await expect(reopen('00000000-0000-0000-0000-00000000dead')).rejects.toThrow(/unknown session/);
  });
});

describe('messageText', () => {
  test(
    'returns the pending item text, then the intent text; undefined when unseen',
    async () => {
      const spec = fakeSpec(mkTmp('orc-msgtext-cwd-'));
      sids.push(spec.sessionId);
      const sid = spec.sessionId;
      await createSession(spec);
      expect(messageText(sid, 'k1')).toBeUndefined();
      // Not woken: stays in the inbox.
      await stop(sid);
      await reopen(sid);
      await send(sid, { messageId: 'k1', text: 'hello\nworld' }, { wake: false, ackTimeoutMs: 0 });
      expect(messageText(sid, 'k1')).toBe('hello\nworld');
      await ensureAwake(sid);
      await waitCompleted(sid, 'k1');
      expect(messageText(sid, 'k1')).toBe('hello\nworld');
      await stop(sid);
    },
    T,
  );
});
