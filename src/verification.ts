/**
 * Portable, serializable step completion contracts (phase 3).
 *
 * Descriptor forms (both accepted):
 * - Untagged (preferred in tests/JSON): `{ gitDiff: { minCommits: 1 } }`
 * - Tagged: `{ type: 'gitDiff', minCommits: 1 }`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ResultEnvelope, ResultEnvelopeOutcome } from './result-envelope.ts';
import type { ArtifactManifest } from './artifacts.ts';
import { readArtifactManifest, verifyStoredBlob } from './artifacts.ts';
import { isPathInsideRoot } from './workflow-path.ts';
import { commitCountSince, gitHead, hasDiffSince } from './worktree.ts';
import type { StepOutcome } from './run-schema.ts';
import type { AgentState } from './types.ts';

export { commitCountSince } from './worktree.ts';

/** Max captured stdout/stderr per command verifier (bytes). */
export const VERIFIER_OUTPUT_BOUND = 8_192;

export type VerifyKind =
  | 'all'
  | 'any'
  | 'gitDiff'
  | 'command'
  | 'file'
  | 'artifact'
  | 'resultEnvelope';

/** Leaf + composite descriptors (untagged object form). */
export type VerifyDescriptor =
  | { all: VerifyDescriptor[] }
  | { any: VerifyDescriptor[] }
  | { gitDiff: { minCommits?: number; requireChanges?: boolean } }
  | {
      command: {
        argv: string[];
        cwd?: string;
        timeoutMs?: number;
        exitCode?: number;
        expectExitCode?: number;
      };
    }
  | {
      file: {
        path: string;
        sha256?: string;
        maxBytes?: number;
        json?: boolean;
        requiredKeys?: string[];
        schema?: { type?: 'object' | 'array'; requiredKeys?: string[] };
      };
    }
  | { artifact: { name: string; digest?: string; sha256?: string } }
  | {
      resultEnvelope: {
        acceptAsEvidence?: boolean;
        acceptOutcomes?: ResultEnvelopeOutcome[];
      };
    }
  // Tagged form used by some call sites / workflow examples
  | { type: 'all'; of: VerifyDescriptor[] }
  | { type: 'any'; of: VerifyDescriptor[] }
  | { type: 'gitDiff'; minCommits?: number; requireChanges?: boolean }
  | {
      type: 'command';
      argv: string[];
      cwd?: string;
      timeoutMs?: number;
      expectExitCode?: number;
      exitCode?: number;
    }
  | {
      type: 'file';
      path: string;
      sha256?: string;
      maxBytes?: number;
      json?: boolean;
      schema?: { type?: 'object' | 'array'; requiredKeys?: string[] };
      requiredKeys?: string[];
    }
  | { type: 'artifact'; name: string; sha256?: string; digest?: string }
  | {
      type: 'resultEnvelope';
      acceptAsEvidence?: boolean;
      acceptOutcomes?: ResultEnvelopeOutcome[];
    };

export interface VerifierObservation {
  /** Test field name. */
  kind: VerifyKind | string;
  /** Alias for kind (workflow field). */
  type: VerifyKind | string;
  /** Test field name. */
  passed: boolean;
  /** Alias for passed (workflow field). */
  ok: boolean;
  summary: string;
  message?: string;
  detail?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  details?: Record<string, unknown>;
  children?: VerifierObservation[];
}

export interface VerifyContext {
  cwd: string;
  runId: string;
  stepId: string;
  attemptId: string;
  baselineSha?: string;
  envelope?: ResultEnvelope | null;
  /** Map name → manifest, or array of manifests. */
  artifacts?: Record<string, ArtifactManifest> | ArtifactManifest[];
  timeoutMs?: number;
  state?: AgentState;
  settled?: boolean;
}

export interface VerifyResult {
  /** Test field. */
  passed: boolean;
  /** Alias for passed (workflow). */
  ok: boolean;
  observations: VerifierObservation[];
}

/** Inputs for pure outcome mapping (truth table). */
export interface OutcomeInputs {
  state: AgentState;
  settled: boolean;
  cancelled?: boolean;
  allowUnverified?: boolean;
  donePredicateOk?: boolean;
  verifyPassed?: boolean;
  worktreeDefaultOk?: boolean;
  envelopeOutcome?: ResultEnvelopeOutcome | string;
}

function boundText(s: string, max = VERIFIER_OUTPUT_BOUND): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length} chars]`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obs(
  kind: string,
  passed: boolean,
  summary: string,
  extra?: Partial<VerifierObservation>,
): VerifierObservation {
  return {
    kind,
    type: kind,
    passed,
    ok: passed,
    summary,
    message: summary,
    detail: extra?.detail ?? summary,
    ...extra,
  };
}

type Normalized =
  | { kind: 'all'; of: VerifyDescriptor[] }
  | { kind: 'any'; of: VerifyDescriptor[] }
  | { kind: 'gitDiff'; minCommits?: number; requireChanges?: boolean }
  | {
      kind: 'command';
      argv: string[];
      cwd?: string;
      timeoutMs?: number;
      expectExitCode: number;
    }
  | {
      kind: 'file';
      path: string;
      sha256?: string;
      maxBytes?: number;
      json?: boolean;
      requiredKeys?: string[];
      schemaType?: 'object' | 'array';
    }
  | { kind: 'artifact'; name: string; digest?: string }
  | {
      kind: 'resultEnvelope';
      acceptAsEvidence: boolean;
      acceptOutcomes?: ResultEnvelopeOutcome[];
    };

function normalizeDescriptor(v: unknown, label = 'verify'): Normalized {
  if (!isRecord(v)) throw new Error(`${label}: must be an object`);

  // Tagged form
  if (typeof v.type === 'string') {
    switch (v.type) {
      case 'all':
      case 'any': {
        if (!Array.isArray(v.of) || v.of.length === 0) {
          throw new Error(`${label}: ${v.type} requires non-empty of[]`);
        }
        return { kind: v.type, of: v.of as VerifyDescriptor[] };
      }
      case 'gitDiff':
        return {
          kind: 'gitDiff',
          minCommits: typeof v.minCommits === 'number' ? v.minCommits : undefined,
          requireChanges: typeof v.requireChanges === 'boolean' ? v.requireChanges : undefined,
        };
      case 'command': {
        if (!Array.isArray(v.argv) || v.argv.length === 0) {
          throw new Error(`${label}: command.argv must be a non-empty string array`);
        }
        if (!v.argv.every((a) => typeof a === 'string')) {
          throw new Error(`${label}: command.argv must be string[]`);
        }
        return {
          kind: 'command',
          argv: v.argv as string[],
          cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
          timeoutMs: typeof v.timeoutMs === 'number' ? v.timeoutMs : undefined,
          expectExitCode:
            typeof v.expectExitCode === 'number'
              ? v.expectExitCode
              : typeof v.exitCode === 'number'
                ? v.exitCode
                : 0,
        };
      }
      case 'file': {
        if (typeof v.path !== 'string' || v.path.length === 0) {
          throw new Error(`${label}: file.path is required`);
        }
        if (v.path.includes('..') || path.isAbsolute(v.path)) {
          throw new Error(`${label}: file.path must be relative without '..'`);
        }
        const schema = isRecord(v.schema) ? v.schema : undefined;
        return {
          kind: 'file',
          path: v.path,
          sha256: typeof v.sha256 === 'string' ? v.sha256 : undefined,
          maxBytes: typeof v.maxBytes === 'number' ? v.maxBytes : undefined,
          json: v.json === true || schema !== undefined,
          requiredKeys: Array.isArray(v.requiredKeys)
            ? (v.requiredKeys as string[])
            : Array.isArray(schema?.requiredKeys)
              ? (schema!.requiredKeys as string[])
              : undefined,
          schemaType:
            schema?.type === 'object' || schema?.type === 'array' ? schema.type : undefined,
        };
      }
      case 'artifact': {
        if (typeof v.name !== 'string' || v.name.length === 0) {
          throw new Error(`${label}: artifact.name is required`);
        }
        return {
          kind: 'artifact',
          name: v.name,
          digest:
            typeof v.digest === 'string'
              ? v.digest
              : typeof v.sha256 === 'string'
                ? v.sha256
                : undefined,
        };
      }
      case 'resultEnvelope':
        return {
          kind: 'resultEnvelope',
          acceptAsEvidence: v.acceptAsEvidence === true,
          acceptOutcomes: Array.isArray(v.acceptOutcomes)
            ? (v.acceptOutcomes as ResultEnvelopeOutcome[])
            : undefined,
        };
      default:
        throw new Error(`${label}: unknown verify type '${v.type}'`);
    }
  }

  // Untagged form — exactly one key
  const keys = Object.keys(v);
  if (keys.length !== 1) {
    throw new Error(`${label}: expected exactly one verifier key, got [${keys.join(', ')}]`);
  }
  const key = keys[0]!;
  const body = v[key];

  switch (key) {
    case 'all':
    case 'any': {
      if (!Array.isArray(body) || body.length === 0) {
        throw new Error(`${label}: ${key} requires non-empty array`);
      }
      return { kind: key, of: body as VerifyDescriptor[] };
    }
    case 'gitDiff': {
      const b = isRecord(body) ? body : {};
      return {
        kind: 'gitDiff',
        minCommits: typeof b.minCommits === 'number' ? b.minCommits : undefined,
        requireChanges: typeof b.requireChanges === 'boolean' ? b.requireChanges : undefined,
      };
    }
    case 'command': {
      if (!isRecord(body)) throw new Error(`${label}: command body required`);
      if (!Array.isArray(body.argv) || body.argv.length === 0) {
        throw new Error(`${label}: command.argv must be a non-empty string array`);
      }
      if (!body.argv.every((a) => typeof a === 'string')) {
        throw new Error(`${label}: command.argv must be string[]`);
      }
      return {
        kind: 'command',
        argv: body.argv as string[],
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        expectExitCode:
          typeof body.exitCode === 'number'
            ? body.exitCode
            : typeof body.expectExitCode === 'number'
              ? body.expectExitCode
              : 0,
      };
    }
    case 'file': {
      if (!isRecord(body) || typeof body.path !== 'string' || body.path.length === 0) {
        throw new Error(`${label}: file.path is required`);
      }
      if (body.path.includes('..') || path.isAbsolute(body.path)) {
        throw new Error(`${label}: file.path must be relative without '..'`);
      }
      const schema = isRecord(body.schema) ? body.schema : undefined;
      return {
        kind: 'file',
        path: body.path,
        sha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
        maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : undefined,
        json: body.json === true || schema !== undefined || Array.isArray(body.requiredKeys),
        requiredKeys: Array.isArray(body.requiredKeys)
          ? (body.requiredKeys as string[])
          : Array.isArray(schema?.requiredKeys)
            ? (schema!.requiredKeys as string[])
            : undefined,
        schemaType:
          schema?.type === 'object' || schema?.type === 'array' ? schema.type : undefined,
      };
    }
    case 'artifact': {
      if (!isRecord(body) || typeof body.name !== 'string') {
        throw new Error(`${label}: artifact.name is required`);
      }
      return {
        kind: 'artifact',
        name: body.name,
        digest:
          typeof body.digest === 'string'
            ? body.digest
            : typeof body.sha256 === 'string'
              ? body.sha256
              : undefined,
      };
    }
    case 'resultEnvelope': {
      const b = isRecord(body) ? body : {};
      return {
        kind: 'resultEnvelope',
        acceptAsEvidence: b.acceptAsEvidence === true,
        acceptOutcomes: Array.isArray(b.acceptOutcomes)
          ? (b.acceptOutcomes as ResultEnvelopeOutcome[])
          : undefined,
      };
    }
    default:
      throw new Error(`${label}: unknown verifier kind '${key}'`);
  }
}

/** Validate a verify descriptor tree (JSON-safe). Throws on invalid shape. */
export function assertValidVerifyDescriptor(v: unknown, label = 'verify'): void {
  const n = normalizeDescriptor(v, label);
  if (n.kind === 'all' || n.kind === 'any') {
    n.of.forEach((child, i) => assertValidVerifyDescriptor(child, `${label}.${n.kind}[${i}]`));
  }
}

export function cloneVerifyDescriptor(v: VerifyDescriptor): VerifyDescriptor {
  return JSON.parse(JSON.stringify(v)) as VerifyDescriptor;
}

/**
 * Pure truth-table mapping from settle + signals → outcome.
 * Fail-closed: yield without verifier → unverified + ok:false unless allowUnverified.
 */
export function mapToStepOutcome(input: OutcomeInputs): { outcome: StepOutcome; ok: boolean } {
  if (input.cancelled) return { outcome: 'cancelled', ok: false };
  if (!input.settled) return { outcome: 'timed_out', ok: false };
  if (input.state === 'failed') return { outcome: 'failed', ok: false };
  if (input.state === 'waiting') return { outcome: 'failed', ok: false }; // modal waiting
  if (input.state !== 'done') return { outcome: 'failed', ok: false };

  if (input.envelopeOutcome === 'needs_input') {
    return { outcome: 'needs_input', ok: false };
  }
  if (input.envelopeOutcome === 'failed') return { outcome: 'failed', ok: false };
  if (input.envelopeOutcome === 'timed_out') return { outcome: 'timed_out', ok: false };
  if (input.envelopeOutcome === 'cancelled') return { outcome: 'cancelled', ok: false };

  if (input.donePredicateOk === true) return { outcome: 'succeeded', ok: true };
  if (input.donePredicateOk === false) return { outcome: 'failed', ok: false };
  if (input.verifyPassed === true) return { outcome: 'succeeded', ok: true };
  if (input.verifyPassed === false) return { outcome: 'failed', ok: false };
  if (input.worktreeDefaultOk === true) return { outcome: 'succeeded', ok: true };
  if (input.worktreeDefaultOk === false) return { outcome: 'failed', ok: false };

  if (input.allowUnverified === true) return { outcome: 'unverified', ok: true };
  return { outcome: 'unverified', ok: false };
}

async function runLeaf(n: Normalized, ctx: VerifyContext): Promise<VerifierObservation> {
  switch (n.kind) {
    case 'all':
    case 'any':
      throw new Error('internal: composite leaf');
    case 'gitDiff': {
      if (!ctx.baselineSha) {
        return obs('gitDiff', false, 'missing baselineSha', {
          detail: 'baselineSha required for gitDiff (capture HEAD before spawn)',
        });
      }
      const minCommits = n.minCommits ?? 1;
      const commits = await commitCountSince(ctx.cwd, ctx.baselineSha);
      const ok = commits >= minCommits;
      return obs(
        'gitDiff',
        ok,
        ok
          ? `gitDiff ok: ${commits} commit(s) since ${ctx.baselineSha.slice(0, 8)}`
          : `gitDiff failed: ${commits} commit(s) (need ≥${minCommits})`,
        {
          details: { baselineSha: ctx.baselineSha, commits, minCommits },
        },
      );
    }
    case 'command': {
      const timeoutMs = n.timeoutMs ?? 60_000;
      let cwd = ctx.cwd;
      if (n.cwd) {
        const abs = path.isAbsolute(n.cwd) ? n.cwd : path.resolve(ctx.cwd, n.cwd);
        const root = await fs.realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
        const real = await fs.realpath(abs).catch(() => abs);
        if (!isPathInsideRoot(real, root)) {
          return obs('command', false, `command cwd escapes step cwd: ${n.cwd}`);
        }
        cwd = real;
      }
      const proc = Bun.spawn(n.argv, {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      let stdout = '';
      let stderr = '';
      try {
        [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const exitCode = await proc.exited;
      const passed = !timedOut && exitCode === n.expectExitCode;
      return obs(
        'command',
        passed,
        timedOut
          ? `command timed out after ${timeoutMs}ms`
          : passed
            ? `command exit ${exitCode} as expected`
            : `command exit ${exitCode}, expected ${n.expectExitCode}`,
        {
          stdout: boundText(stdout),
          stderr: boundText(stderr),
          exitCode,
          details: { argv: n.argv, timedOut, cwd },
        },
      );
    }
    case 'file': {
      const candidate = path.isAbsolute(n.path)
        ? path.resolve(n.path)
        : path.resolve(ctx.cwd, n.path);
      const root = await fs.realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
      let resolved: string;
      try {
        resolved = await fs.realpath(candidate);
      } catch {
        return obs('file', false, `file not found: ${n.path}`);
      }
      if (!isPathInsideRoot(resolved, root)) {
        return obs('file', false, `file path escapes step cwd: ${n.path}`);
      }
      const st = await fs.stat(resolved);
      if (!st.isFile()) return obs('file', false, `not a file: ${n.path}`);
      const maxBytes = n.maxBytes ?? 32 * 1024 * 1024;
      if (st.size > maxBytes) {
        return obs('file', false, `file size ${st.size} exceeds maxBytes ${maxBytes}`);
      }
      const buf = Buffer.from(await Bun.file(resolved).arrayBuffer());
      const digest = createHash('sha256').update(buf).digest('hex');
      if (n.sha256 && digest.toLowerCase() !== n.sha256.toLowerCase()) {
        return obs('file', false, 'file sha256 mismatch', {
          details: { expected: n.sha256, actual: digest },
        });
      }
      if (n.json || n.requiredKeys || n.schemaType) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(buf.toString('utf8'));
        } catch (e) {
          return obs('file', false, `JSON parse failed: ${(e as Error).message}`);
        }
        if (n.schemaType === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
          return obs('file', false, 'JSON root must be an object');
        }
        if (n.schemaType === 'array' && !Array.isArray(parsed)) {
          return obs('file', false, 'JSON root must be an array');
        }
        if (n.requiredKeys && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const missing = n.requiredKeys.filter((k) => !(k in obj));
          if (missing.length > 0) {
            return obs('file', false, `JSON missing keys: ${missing.join(', ')}`);
          }
        }
      }
      return obs('file', true, `file ok: ${n.path}`, {
        details: { sha256: digest, bytes: buf.byteLength },
      });
    }
    case 'artifact': {
      let manifest: ArtifactManifest | undefined;
      if (Array.isArray(ctx.artifacts)) {
        manifest = ctx.artifacts.find((a) => a.name === n.name);
      } else if (ctx.artifacts && typeof ctx.artifacts === 'object') {
        manifest = ctx.artifacts[n.name];
      }
      if (!manifest) {
        manifest = (await readArtifactManifest(ctx.runId, n.name)) ?? undefined;
      }
      if (!manifest) {
        return obs('artifact', false, `artifact '${n.name}' not found`);
      }
      const dig = manifest.digest ?? manifest.sha256;
      if (n.digest && dig.toLowerCase() !== n.digest.toLowerCase()) {
        return obs('artifact', false, `artifact '${n.name}' digest mismatch`, {
          details: { expected: n.digest, actual: dig },
        });
      }
      const blobOk = await verifyStoredBlob(ctx.runId, dig);
      return obs(
        'artifact',
        blobOk,
        blobOk
          ? `artifact '${n.name}' present and hash-verified`
          : `artifact '${n.name}' blob missing or tampered`,
        { details: { digest: dig, bytes: manifest.byteSize ?? manifest.bytes } },
      );
    }
    case 'resultEnvelope': {
      if (!ctx.envelope) {
        return obs('resultEnvelope', false, 'no validated result envelope', {
          details: { testimonyOnly: true },
        });
      }
      // Observation always "passes" as testimony presence when envelope exists;
      // overall verify pass requires acceptAsEvidence (or acceptOutcomes match).
      const accept = n.acceptOutcomes ?? ['succeeded'];
      const outcomeOk = accept.includes(ctx.envelope.outcome);
      const asEvidence = n.acceptAsEvidence === true && outcomeOk;
      // For the observation itself: record that envelope was seen
      const observationPassed = true; // testimony present
      return obs(
        'resultEnvelope',
        // When used as sole verifier, executeVerify uses asEvidence for overall pass.
        // Observation.passed is true when envelope exists (testimony recorded).
        observationPassed,
        asEvidence
          ? `resultEnvelope accepted as evidence (outcome=${ctx.envelope.outcome})`
          : `resultEnvelope present as agent testimony (outcome=${ctx.envelope.outcome}; not evidence unless acceptAsEvidence)`,
        {
          details: {
            testimonyOnly: !asEvidence,
            outcome: ctx.envelope.outcome,
            acceptAsEvidence: n.acceptAsEvidence,
            asEvidence,
          },
        },
      );
    }
    default: {
      const _e: never = n;
      return obs('unknown', false, `unknown: ${JSON.stringify(_e)}`);
    }
  }
}

/**
 * Execute a verify descriptor tree.
 * Returns passed/ok + flat observations.
 */
export async function executeVerify(
  descriptor: VerifyDescriptor | unknown,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  async function evalOne(d: unknown): Promise<{
    passed: boolean;
    observation: VerifierObservation;
  }> {
    const n = normalizeDescriptor(d);
    if (n.kind === 'all') {
      const children: VerifierObservation[] = [];
      let passed = true;
      for (const child of n.of) {
        const r = await evalOne(child);
        children.push(r.observation);
        if (!r.passed) passed = false;
      }
      return {
        passed,
        observation: obs('all', passed, passed ? 'all passed' : 'one or more failed', {
          children,
        }),
      };
    }
    if (n.kind === 'any') {
      const children: VerifierObservation[] = [];
      let passed = false;
      for (const child of n.of) {
        const r = await evalOne(child);
        children.push(r.observation);
        if (r.passed) passed = true;
      }
      return {
        passed,
        observation: obs('any', passed, passed ? 'at least one passed' : 'all failed', {
          children,
        }),
      };
    }
    if (n.kind === 'resultEnvelope') {
      const leaf = await runLeaf(n, ctx);
      // Overall pass only when acceptAsEvidence
      const asEvidence = leaf.details?.asEvidence === true;
      return { passed: asEvidence, observation: leaf };
    }
    const leaf = await runLeaf(n, ctx);
    return { passed: leaf.passed, observation: leaf };
  }

  const root = await evalOne(descriptor);
  const flat: VerifierObservation[] = [];
  const walk = (o: VerifierObservation) => {
    flat.push(o);
    if (o.children) for (const c of o.children) walk(c);
  };
  walk(root.observation);
  return { passed: root.passed, ok: root.passed, observations: flat };
}

/** Alias used by workflow.ts */
export const runVerify = executeVerify;

/** Capture current HEAD for baseline (undefined if not a git repo). */
export async function captureBaselineSha(cwd: string): Promise<string | undefined> {
  return (await gitHead(cwd)) ?? undefined;
}

export type { StepOutcome };
// silence unused import when hasDiffSince not needed in this module's public API
void hasDiffSince;
