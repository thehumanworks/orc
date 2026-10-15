/**
 * On-disk layout of one session's runtime state (see the header of ./types.ts).
 * The session dir may also hold unrelated orc sidecars (e.g. codex instructions.md).
 */
import path from 'node:path';
import { sessionStateDir } from '../paths.ts';
import { assertValidSessionId, ensurePrivateDir } from './fsutil.ts';

export interface SessionPaths {
  dir: string;
  spawn: string;
  state: string;
  journal: string;
  /** Verbatim provider protocol stream (debug only) — ProviderLaunch.rawLogPath. */
  providerRaw: string;
  inbox: string;
  actorLog: string;
}

export function sessionPaths(sessionId: string): SessionPaths {
  const dir = sessionStateDir(assertValidSessionId(sessionId));
  return {
    dir,
    spawn: path.join(dir, 'spawn.json'),
    state: path.join(dir, 'state.json'),
    journal: path.join(dir, 'journal.jsonl'),
    providerRaw: path.join(dir, 'provider.jsonl'),
    inbox: path.join(dir, 'inbox'),
    actorLog: path.join(dir, 'actor.log'),
  };
}

/** Create the session dir and inbox (both 0700). Idempotent. */
export function ensureSessionDirs(sessionId: string): SessionPaths {
  const p = sessionPaths(sessionId);
  ensurePrivateDir(p.dir);
  ensurePrivateDir(p.inbox);
  return p;
}
