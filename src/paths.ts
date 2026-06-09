/**
 * Filesystem locations for orc state. All under ~/.orc (override with ORC_HOME).
 */
import os from 'node:os';
import path from 'node:path';

/** The orc home dir: $ORC_HOME or ~/.orc. */
export function orcHome(): string {
  const override = process.env.ORC_HOME;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.orc');
}

/** Path to the registry JSON file (array of SessionRecord). */
export function registryPath(): string {
  return path.join(orcHome(), 'registry.json');
}

/** Base sessions dir (~/.orc/sessions). */
export function sessionsDir(): string {
  return path.join(orcHome(), 'sessions');
}

/** Base transcripts dir (~/.orc/transcripts). */
export function transcriptsDir(): string {
  return path.join(orcHome(), 'transcripts');
}

/**
 * Per-session pi transcript dir: ~/.orc/transcripts/pi/<sid>/.
 * pi writes <session-dir>/<ISO>_<sid>.jsonl.
 */
export function piSessionDir(sessionId: string): string {
  return path.join(transcriptsDir(), 'pi', sessionId);
}
