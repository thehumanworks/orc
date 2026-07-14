import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateResultEnvelope,
  skeletonEnvelope,
  writeResultEnvelope,
  readResultEnvelope,
  envelopeIsTestimonyOnly,
  RESULT_ENVELOPE_VERSION,
  ORC_RESULT_PATH,
} from '../src/result-envelope.ts';

const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await fs.rm(d, { recursive: true, force: true });
});

describe('validateResultEnvelope', () => {
  const base = {
    version: RESULT_ENVELOPE_VERSION,
    runId: 'run1',
    stepId: 'stepA',
    attemptId: 'att1',
    outcome: 'succeeded' as const,
  };

  test('accepts a minimal valid envelope', () => {
    const v = validateResultEnvelope(base);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.envelope.outcome).toBe('succeeded');
  });

  test('rejects non-object', () => {
    expect(validateResultEnvelope(null).ok).toBe(false);
    expect(validateResultEnvelope([]).ok).toBe(false);
  });

  test('rejects bad outcome', () => {
    const v = validateResultEnvelope({ ...base, outcome: 'won' });
    expect(v.ok).toBe(false);
  });

  test('rejects id mismatch against expectedIds', () => {
    const v = validateResultEnvelope(base, {
      runId: 'run1',
      stepId: 'other',
      attemptId: 'att1',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/stepId mismatch/);
  });

  test('rejects absolute artifact paths and traversal', () => {
    const v = validateResultEnvelope({
      ...base,
      artifacts: [{ name: 'out', path: '/etc/passwd' }],
    });
    expect(v.ok).toBe(false);
    const v2 = validateResultEnvelope({
      ...base,
      artifacts: [{ name: 'out', path: '../escape' }],
    });
    expect(v2.ok).toBe(false);
  });

  test('accepts needs_input with question', () => {
    const v = validateResultEnvelope({
      ...base,
      outcome: 'needs_input',
      question: 'Which API version?',
    });
    expect(v.ok).toBe(true);
  });

  test('envelopeIsTestimonyOnly is always true', () => {
    expect(envelopeIsTestimonyOnly(base)).toBe(true);
    expect(envelopeIsTestimonyOnly(null)).toBe(true);
  });

  test('skeletonEnvelope has unverified outcome', () => {
    const s = skeletonEnvelope({ runId: 'r', stepId: 's', attemptId: 'a' });
    expect(s.version).toBe(1);
    expect(s.outcome).toBe('unverified');
  });

  test('ORC_RESULT_PATH constant is stable', () => {
    expect(ORC_RESULT_PATH).toBe('ORC_RESULT_PATH');
  });
});

describe('read/write ResultEnvelope', () => {
  beforeEach(async () => {
    process.env.ORC_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-env-'));
    tmp.push(process.env.ORC_HOME);
  });

  test('round-trip write/read with id check', async () => {
    const file = path.join(process.env.ORC_HOME!, 'res.json');
    const env = {
      version: RESULT_ENVELOPE_VERSION,
      runId: 'runx',
      stepId: 'sx',
      attemptId: 'ax',
      outcome: 'failed' as const,
      summary: 'boom',
    };
    await writeResultEnvelope(file, env);
    const v = await readResultEnvelope(file, {
      runId: 'runx',
      stepId: 'sx',
      attemptId: 'ax',
    });
    expect(v).not.toBeNull();
    expect(v!.ok).toBe(true);
    if (v!.ok) expect(v!.envelope.summary).toBe('boom');
  });

  test('missing file returns null', async () => {
    const v = await readResultEnvelope(path.join(process.env.ORC_HOME!, 'nope.json'));
    expect(v).toBeNull();
  });

  test('malformed JSON fails validation', async () => {
    const file = path.join(process.env.ORC_HOME!, 'bad.json');
    await Bun.write(file, '{not json');
    const v = await readResultEnvelope(file);
    expect(v).not.toBeNull();
    expect(v!.ok).toBe(false);
  });
});
