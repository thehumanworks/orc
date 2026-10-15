/**
 * Lifecycle helpers for orc-owned per-session files under ~/.orc/sessions/<sessionId>/:
 * the system prompt file a provider reads at launch, and the whole session state dir
 * (kernel journal/inbox/state). Paths always live under ~/.orc — never under the agent
 * cwd / worktree — and every removal is bound to the record's own session id.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  legacySessionInstructionsPath,
  orcHome,
  sessionStateDir,
  sessionSystemPromptPath,
  sessionsDir,
} from './paths.ts';
import type { SessionRecord } from './types.ts';

/**
 * Write the system prompt for a session (0600 in a 0700 dir). Exclusive create: a stale
 * file or symlink is never overwritten. Returns the absolute path.
 */
export async function writeSystemPromptFile(sessionId: string, text: string): Promise<string> {
  const target = sessionSystemPromptPath(sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(target), 0o700).catch(() => {});
  await fs.writeFile(target, `${text.trim()}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return target;
}

/**
 * Remove the record's system prompt file. No-op when `systemPromptPath` is absent. Only
 * this session's own file (current or legacy name) is ever removed: a corrupted record
 * must not be able to delete another session's sidecar.
 */
export async function removeSystemPromptFile(
  rec: Pick<SessionRecord, 'systemPromptPath' | 'sessionId'>,
): Promise<void> {
  const p = rec.systemPromptPath;
  if (!p) return;
  let allowed: string[];
  try {
    allowed = [sessionSystemPromptPath(rec.sessionId), legacySessionInstructionsPath(rec.sessionId)];
  } catch {
    return;
  }
  if (!isOrcOwnedSessionPath(p) || !allowed.some((a) => path.resolve(a) === path.resolve(p))) return;
  await fs.rm(p, { force: true }).catch(() => {});
}

/**
 * Remove a session's whole state dir (journal, inbox, spawn/state files, system prompt).
 * Used by purge/prune and by agent() rollback. Refuses anything outside ~/.orc/sessions.
 */
export async function removeSessionDir(sessionId: string): Promise<void> {
  let dir: string;
  try {
    dir = sessionStateDir(sessionId);
  } catch {
    return;
  }
  const root = path.resolve(sessionsDir());
  if (path.resolve(dir) === root || !isOrcOwnedSessionPath(dir)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** True when `p` is under ~/.orc/sessions/ (absolute, resolved). */
export function isOrcOwnedSessionPath(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const root = path.resolve(sessionsDir()) + path.sep;
  const resolved = path.resolve(p);
  return resolved === path.resolve(sessionsDir()) || resolved.startsWith(root);
}

/** Best-effort: ensure path is under orc home (used by tests/guards). */
export function isUnderOrcHome(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const root = path.resolve(orcHome()) + path.sep;
  const resolved = path.resolve(p);
  return resolved === path.resolve(orcHome()) || resolved.startsWith(root);
}
