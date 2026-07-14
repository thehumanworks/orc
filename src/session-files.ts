/**
 * Lifecycle helpers for orc-owned session sidecars (Codex instructions, etc.).
 * Paths always live under ~/.orc — never under the agent cwd / worktree.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { orcHome, sessionInstructionsPath, sessionsDir } from './paths.ts';
import type { SessionRecord } from './types.ts';

/**
 * Remove the codex instructions file (and its per-session state dir when empty)
 * for a record. No-op when `instructionsPath` is absent. Never throws for missing
 * paths; refuses to delete anything outside orc home / sessions dir.
 */
export async function removeSessionInstructions(
  rec: Pick<SessionRecord, 'instructionsPath' | 'sessionId'>,
): Promise<void> {
  const p = rec.instructionsPath;
  if (!p) return;
  const expected = sessionInstructionsPath(rec.sessionId);
  if (!isOrcOwnedSessionPath(p) || path.resolve(p) !== path.resolve(expected)) {
    // Bind ownership to this exact session. A corrupted record must not be able to
    // remove another session's sidecar, even when both paths are under ~/.orc/sessions.
    return;
  }
  await fs.rm(p, { force: true }).catch(() => {});
  const dir = path.dirname(p);
  if (isOrcOwnedSessionPath(dir)) {
    // Remove the per-session directory only when it is empty. Future sidecars must
    // not be swept away merely because the Codex instructions file was cleaned up.
    await fs.rmdir(dir).catch(() => {});
  }
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
