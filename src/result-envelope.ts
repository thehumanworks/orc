/**
 * Versioned JSON result envelope written by agents to ORC_RESULT_PATH.
 * An envelope is agent testimony — never sufficient evidence unless a
 * verifier explicitly accepts it as evidence.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepOutcome } from './run-schema.ts';

/** Env var name for the result path (also used as constant). */
export const ORC_RESULT_PATH = 'ORC_RESULT_PATH';

/** Envelope schema version. */
export const RESULT_ENVELOPE_VERSION = 1 as const;

export type ResultEnvelopeOutcome =
  | 'succeeded'
  | 'failed'
  | 'needs_input'
  | 'unverified'
  | 'timed_out'
  | 'cancelled';

export interface ResultEnvelopeArtifactMeta {
  name: string;
  path?: string;
  sha256?: string;
  digest?: string;
  mediaType?: string;
  bytes?: number;
}

/**
 * Agent-written result envelope. Ids must match the attempt that created the path.
 */
export interface ResultEnvelope {
  version: typeof RESULT_ENVELOPE_VERSION;
  runId: string;
  stepId: string;
  attemptId: string;
  outcome: ResultEnvelopeOutcome;
  summary?: string;
  /** When outcome is needs_input, optional clarifying question text. */
  question?: string;
  artifacts?: ResultEnvelopeArtifactMeta[];
}

export type EnvelopeValidation =
  | { ok: true; envelope: ResultEnvelope }
  | { ok: false; error: string; raw?: unknown };

const OUTCOMES = new Set<string>([
  'succeeded',
  'failed',
  'needs_input',
  'unverified',
  'timed_out',
  'cancelled',
]);

const MAX_SUMMARY = 4_096;
const MAX_QUESTION = 4_096;
const MAX_ARTIFACTS = 64;

export function isResultEnvelopeOutcome(v: unknown): v is ResultEnvelopeOutcome {
  return typeof v === 'string' && OUTCOMES.has(v);
}

function isSafeArtifactPath(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  if (p.includes('\0')) return false;
  const norm = path.normalize(p);
  if (norm.startsWith('..') || norm.includes(`${path.sep}..`)) return false;
  return true;
}

/**
 * Validate envelope shape and optional expected ids. Does NOT treat the envelope
 * as success evidence — callers decide via verifiers / turn policy.
 */
export function validateResultEnvelope(
  raw: unknown,
  expected?: { runId?: string; stepId?: string; attemptId?: string },
): EnvelopeValidation {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'envelope missing' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'envelope must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== RESULT_ENVELOPE_VERSION && o.version !== 1) {
    return { ok: false, error: `unsupported envelope version '${String(o.version)}'` };
  }
  if (typeof o.runId !== 'string' || o.runId.length === 0) {
    return { ok: false, error: 'envelope.runId must be a non-empty string' };
  }
  if (typeof o.stepId !== 'string' || o.stepId.length === 0) {
    return { ok: false, error: 'envelope.stepId must be a non-empty string' };
  }
  if (typeof o.attemptId !== 'string' || o.attemptId.length === 0) {
    return { ok: false, error: 'envelope.attemptId must be a non-empty string' };
  }
  if (!isResultEnvelopeOutcome(o.outcome)) {
    return { ok: false, error: `envelope.outcome invalid: '${String(o.outcome)}'` };
  }
  if (expected?.runId !== undefined && o.runId !== expected.runId) {
    return {
      ok: false,
      error: `envelope.runId mismatch: got '${o.runId}', expected '${expected.runId}'`,
    };
  }
  if (expected?.stepId !== undefined && o.stepId !== expected.stepId) {
    return {
      ok: false,
      error: `envelope.stepId mismatch: got '${o.stepId}', expected '${expected.stepId}'`,
    };
  }
  if (expected?.attemptId !== undefined && o.attemptId !== expected.attemptId) {
    return {
      ok: false,
      error: `envelope.attemptId mismatch: got '${o.attemptId}', expected '${expected.attemptId}'`,
    };
  }
  if (o.summary !== undefined && typeof o.summary !== 'string') {
    return { ok: false, error: 'envelope.summary must be a string when present' };
  }
  if (o.question !== undefined && typeof o.question !== 'string') {
    return { ok: false, error: 'envelope.question must be a string when present' };
  }
  if (o.artifacts !== undefined) {
    if (!Array.isArray(o.artifacts)) {
      return { ok: false, error: 'envelope.artifacts must be an array when present' };
    }
    if (o.artifacts.length > MAX_ARTIFACTS) {
      return { ok: false, error: `envelope.artifacts exceeds max ${MAX_ARTIFACTS}` };
    }
    for (const a of o.artifacts) {
      if (!a || typeof a !== 'object' || typeof (a as { name?: unknown }).name !== 'string') {
        return { ok: false, error: 'envelope.artifacts entries require a string name' };
      }
      const pathVal = (a as { path?: unknown }).path;
      if (typeof pathVal === 'string' && !isSafeArtifactPath(pathVal)) {
        return {
          ok: false,
          error: `envelope.artifacts path must be relative and non-traversing: '${pathVal}'`,
        };
      }
    }
  }

  const envelope: ResultEnvelope = {
    version: RESULT_ENVELOPE_VERSION,
    runId: o.runId,
    stepId: o.stepId,
    attemptId: o.attemptId,
    outcome: o.outcome,
  };
  if (typeof o.summary === 'string') {
    envelope.summary = o.summary.slice(0, MAX_SUMMARY);
  }
  if (typeof o.question === 'string') {
    envelope.question = o.question.slice(0, MAX_QUESTION);
  }
  if (Array.isArray(o.artifacts)) {
    envelope.artifacts = o.artifacts.map((a) => {
      const x = a as Record<string, unknown>;
      const meta: ResultEnvelopeArtifactMeta = { name: String(x.name) };
      if (typeof x.path === 'string') meta.path = x.path;
      if (typeof x.sha256 === 'string') meta.sha256 = x.sha256;
      if (typeof x.digest === 'string') meta.digest = x.digest;
      if (typeof x.mediaType === 'string') meta.mediaType = x.mediaType;
      if (typeof x.bytes === 'number' && Number.isFinite(x.bytes)) meta.bytes = x.bytes;
      return meta;
    });
  }
  return { ok: true, envelope };
}

/** Map a validated envelope outcome to a StepOutcome. */
export function envelopeToStepOutcome(outcome: ResultEnvelopeOutcome): StepOutcome {
  return outcome;
}

/** Skeleton envelope for an attempt (agent may overwrite). */
export function skeletonEnvelope(ids: {
  runId: string;
  stepId: string;
  attemptId: string;
}): ResultEnvelope {
  return {
    version: RESULT_ENVELOPE_VERSION,
    runId: ids.runId,
    stepId: ids.stepId,
    attemptId: ids.attemptId,
    outcome: 'unverified',
  };
}

/** Envelopes are always agent testimony (not hard evidence by themselves). */
export function envelopeIsTestimonyOnly(_env: unknown): true {
  return true;
}

/** Atomically write a validated envelope to disk. */
export async function writeResultEnvelope(
  filePath: string,
  envelope: ResultEnvelope,
): Promise<void> {
  const v = validateResultEnvelope(envelope);
  if (!v.ok) throw new Error(`refusing to write invalid envelope: ${v.error}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await Bun.write(tmp, JSON.stringify(v.envelope, null, 2));
  await fs.rename(tmp, filePath);
}

/**
 * Read and validate an envelope file.
 * Missing file ⇒ null. Malformed/invalid ⇒ EnvelopeValidation with ok:false.
 */
export async function readResultEnvelope(
  filePath: string,
  expected?: { runId?: string; stepId?: string; attemptId?: string },
): Promise<EnvelopeValidation | null> {
  const f = Bun.file(filePath);
  if (!(await f.exists())) {
    return null;
  }
  let raw: unknown;
  try {
    raw = await f.json();
  } catch (e) {
    return { ok: false, error: `envelope JSON parse failed: ${(e as Error).message}` };
  }
  return validateResultEnvelope(raw, expected);
}
