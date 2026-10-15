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

export function registryPath(): string {
  return path.join(orcHome(), 'registry.json');
}

export function peersPath(): string {
  return path.join(orcHome(), 'peers.json');
}

export function sessionsDir(): string {
  return path.join(orcHome(), 'sessions');
}

export function transcriptsDir(): string {
  return path.join(orcHome(), 'transcripts');
}

export function piSessionDir(sessionId: string): string {
  return path.join(transcriptsDir(), 'pi', sessionId);
}

/**
 * orc-owned per-session state dir under ~/.orc/sessions/<sessionId>/ (outside any
 * worktree/repo): the actor kernel's spawn/state/journal/inbox plus orc sidecars such as
 * the system prompt file.
 */
export function sessionStateDir(sessionId: string): string {
  const id = sessionId.trim();
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`invalid sessionId for state dir '${sessionId}'`);
  }
  return path.join(sessionsDir(), id);
}

/**
 * Absolute path of the orc-owned system prompt file a provider reads at launch
 * (every provider reads its system prompt from a file; never from argv, never from the
 * agent cwd / worktree).
 */
export function sessionSystemPromptPath(sessionId: string): string {
  return path.join(sessionStateDir(sessionId), 'system-prompt.md');
}

/** Pre-actor (tmux) codex persona file name; only ever removed, never written. */
export function legacySessionInstructionsPath(sessionId: string): string {
  return path.join(sessionStateDir(sessionId), 'instructions.md');
}

export function runsDir(): string {
  return path.join(orcHome(), 'runs');
}

export function locksDir(): string {
  return path.join(orcHome(), 'locks');
}

const RUN_ID_MAX_LEN = 128;
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const MESSAGE_ID_MAX_LEN = 128;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidRunId(runId: string): void {
  const id = runId.trim();
  if (id.length === 0) throw new Error(`invalid runId '${runId}' (empty)`);
  if (id === '.' || id === '..') throw new Error(`invalid runId '${runId}'`);
  if (id.length > RUN_ID_MAX_LEN) {
    throw new Error(`invalid runId '${runId}' (max length ${RUN_ID_MAX_LEN})`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`invalid runId '${runId}'`);
  }
  if (!RUN_ID_RE.test(id)) {
    throw new Error(`invalid runId '${runId}' (use letters, digits, hyphen, underscore)`);
  }
}

export function assertValidMessageId(messageId: string): void {
  const id = messageId.trim();
  if (id.length === 0) throw new Error(`invalid messageId '${messageId}' (empty)`);
  if (id === '.' || id === '..') throw new Error(`invalid messageId '${messageId}'`);
  if (id.length > MESSAGE_ID_MAX_LEN) {
    throw new Error(`invalid messageId '${messageId}' (max length ${MESSAGE_ID_MAX_LEN})`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`invalid messageId '${messageId}'`);
  }
  if (!MESSAGE_ID_RE.test(id)) {
    throw new Error(
      `invalid messageId '${messageId}' (use letters/digits, then letters/digits/._-)`,
    );
  }
}

export function assertValidAttemptId(attemptId: string): string {
  const id = attemptId.trim();
  if (!ATTEMPT_ID_RE.test(id)) {
    throw new Error(`invalid attemptId '${attemptId}'`);
  }
  return id;
}

export function assertValidArtifactName(name: string): string {
  const n = name.trim();
  if (!ARTIFACT_NAME_RE.test(n)) {
    throw new Error(
      `invalid artifact name '${name}' (1-128 chars: letter/digit then letters/digits/._-)`,
    );
  }
  return n;
}

export function runPath(runId: string): string {
  assertValidRunId(runId);
  return path.join(runsDir(), `${runId}.json`);
}

/** Per-run dir (~/.orc/runs/<runId>/): instructions, artifacts, results. */
export function runInstructionsDir(runId: string): string {
  assertValidRunId(runId);
  return path.join(runsDir(), runId);
}

export function runDir(runId: string): string {
  return runInstructionsDir(runId);
}

/** Detached workflow runner stdout/stderr log: ~/.orc/runs/<runId>/runner.log (append-only). */
export function runnerLogPath(runId: string): string {
  return path.join(runDir(runId), 'runner.log');
}

/** Per-attempt working dir: ~/.orc/runs/<runId>/attempts/<attemptId>/. */
export function runAttemptDir(runId: string, attemptId: string): string {
  assertValidRunId(runId);
  return path.join(runDir(runId), 'attempts', assertValidAttemptId(attemptId));
}

/** ORC_RESULT_PATH for an attempt: .../attempts/<attemptId>/result.json */
export function runResultPath(runId: string, attemptId: string): string {
  return path.join(runAttemptDir(runId, attemptId), 'result.json');
}

/** Alternate envelope path under results/ (stepId/attemptId layout). */
export function runResultEnvelopePath(
  runId: string,
  stepIdOrAttemptId: string,
  attemptId?: string,
): string {
  assertValidRunId(runId);
  if (attemptId !== undefined) {
    return path.join(runDir(runId), 'results', stepIdOrAttemptId, `${attemptId}.json`);
  }
  return runResultPath(runId, stepIdOrAttemptId);
}

export function runArtifactsDir(runId: string): string {
  assertValidRunId(runId);
  return path.join(runDir(runId), 'artifacts');
}

export function runArtifactBlobsDir(runId: string): string {
  return path.join(runArtifactsDir(runId), 'blobs');
}

export function runArtifactManifestsDir(runId: string): string {
  return path.join(runArtifactsDir(runId), 'manifests');
}

export function runArtifactBlobPath(runId: string, digest: string): string {
  const d = digest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(d)) {
    throw new Error(`invalid artifact digest '${digest}' (expected 64-char hex sha256)`);
  }
  return path.join(runArtifactBlobsDir(runId), d);
}

export function runArtifactManifestPath(runId: string, logicalName: string): string {
  return path.join(runArtifactManifestsDir(runId), `${assertValidArtifactName(logicalName)}.json`);
}

export function runStepInputsDir(runId: string, stepId: string): string {
  assertValidRunId(runId);
  return path.join(runDir(runId), 'inputs', stepId);
}

/** Shared materialization root: ~/.orc/runs/<runId>/artifacts/inputs/ */
export function runArtifactInputsDir(runId: string): string {
  return path.join(runArtifactsDir(runId), 'inputs');
}
