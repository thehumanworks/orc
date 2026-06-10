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

/** Path to the trusted-peer file (`orc remote` list + the daemon's allowlist). */
export function peersPath(): string {
  return path.join(orcHome(), 'peers.json');
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

/** Base workflow-runs dir (~/.orc/runs). One <runId>.json per run + a <runId>/ instr dir. */
export function runsDir(): string {
  return path.join(orcHome(), 'runs');
}

/** Path to a single run record: ~/.orc/runs/<runId>.json. */
export function runPath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

/**
 * Per-run instruction-drop dir: ~/.orc/runs/<runId>/. Step specs (taskFile copies,
 * large prompts) are written here — OUTSIDE any worktree/repo — so the agent reads them
 * by absolute path and can never accidentally commit them (the send() large-paste bug
 * workaround). A directory (not a .json), so it never collides with run records.
 */
export function runInstructionsDir(runId: string): string {
  return path.join(runsDir(), runId);
}
