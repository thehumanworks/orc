/** spawn.json: validation and durable read/write of the SpawnSpec. */
import path from 'node:path';
import { RUNTIME_SCHEMA_VERSION } from './types.ts';
import type { RuntimeProvider, SpawnSpec } from './types.ts';
import { sessionPaths } from './layout.ts';
import { assertValidSessionId, readJsonFile, writeFileAtomic } from './fsutil.ts';
import { assertProvider, validateModel, validateReasoningEffort } from '../providers.ts';
import { legacyCodexSessionError } from '../legacy-codex.ts';

/** Historical specs can be read and stopped, but never launched or sent new work. */
export function assertExecutableSpec(spec: SpawnSpec): asserts spec is SpawnSpec & { provider: RuntimeProvider } {
  if (spec.provider === 'codex') throw legacyCodexSessionError(spec.sessionId);
  if (spec.provider !== 'fake') assertProvider(spec.provider);
}

export function validateSpawnSpec(spec: SpawnSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('spawn spec must be an object');
  if (spec.version !== RUNTIME_SCHEMA_VERSION) {
    throw new Error(`spawn spec version ${String(spec.version)} unsupported (want ${RUNTIME_SCHEMA_VERSION})`);
  }
  assertValidSessionId(spec.sessionId);
  assertExecutableSpec(spec);
  if (spec.provider !== 'fake') {
    validateModel(spec.provider, spec.model);
    validateReasoningEffort(spec.provider, spec.reasoningEffort);
  }
  if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)) {
    throw new Error(`spawn spec cwd must be an absolute path (got '${String(spec.cwd)}')`);
  }
  if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) {
    throw new Error('spawn spec env must be an object');
  }
  for (const [k, v] of Object.entries(spec.env)) {
    if (typeof v !== 'string') throw new Error(`spawn spec env '${k}' must be a string`);
  }
  if (spec.systemPrompt && !path.isAbsolute(spec.systemPrompt.path)) {
    throw new Error('spawn spec systemPrompt.path must be absolute');
  }
  if (typeof spec.createdAt !== 'string' || Number.isNaN(Date.parse(spec.createdAt))) {
    throw new Error('spawn spec createdAt must be an ISO timestamp');
  }
}

export function readSpawnSpec(sessionId: string): SpawnSpec | undefined {
  return readJsonFile<SpawnSpec>(sessionPaths(sessionId).spawn);
}

/** Durable write (fsync file + dir). */
export function writeSpawnSpec(spec: SpawnSpec): void {
  validateSpawnSpec(spec);
  writeFileAtomic(sessionPaths(spec.sessionId).spawn, `${JSON.stringify(spec, null, 2)}\n`, {
    mode: 0o600,
    fsync: true,
  });
}
