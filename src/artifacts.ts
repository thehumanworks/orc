/**
 * Run-scoped content-addressed artifact store.
 * Layout: ~/.orc/runs/<runId>/artifacts/{blobs/<sha256>, manifests/<name>.json}
 * Inputs materialize under ~/.orc/runs/<runId>/inputs/<stepId>/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertValidRunId,
  runArtifactsDir,
  runArtifactBlobsDir,
  runArtifactManifestsDir,
  runArtifactBlobPath,
  runArtifactManifestPath,
  runStepInputsDir,
  assertValidArtifactName as pathAssertValidArtifactName,
} from './paths.ts';
import { isPathInsideRoot } from './workflow-path.ts';

/** Default max artifact size (32 MiB). */
export const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** Alias preferred by some call sites. */
export const DEFAULT_ARTIFACT_MAX_BYTES = DEFAULT_MAX_ARTIFACT_BYTES;

export type ArtifactSensitivity = 'normal' | 'sensitive' | 'secret';
export type ArtifactRetention = 'run' | 'keep' | 'ephemeral';

export class ArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

/** Declaration on a WorkflowStep of a file the agent is expected to produce. */
export interface ArtifactOutputDecl {
  name: string;
  path: string;
  required?: boolean;
  mediaType?: string;
  maxBytes?: number;
  sensitivity?: ArtifactSensitivity;
  retention?: ArtifactRetention;
}

/** Downstream step input binding to a prior artifact. */
export interface ArtifactInputDecl {
  name: string;
  fromStep: string;
  artifact?: string;
  materializeAs?: string;
}

export interface ArtifactVerification {
  hashVerified: boolean;
  pathContained: boolean;
  sizeOk: boolean;
  notes?: string[];
}

/** Immutable artifact manifest. */
export interface ArtifactManifest {
  name: string;
  runId: string;
  stepId: string;
  attemptId: string;
  /** SHA-256 hex digest (primary field used by tests). */
  digest: string;
  /** Alias for digest. */
  sha256: string;
  /** Byte size (test field name). */
  byteSize: number;
  /** Alias for byteSize. */
  bytes: number;
  mediaType?: string;
  sourcePath?: string;
  createdAt: string;
  verification: ArtifactVerification;
  sensitivity: ArtifactSensitivity;
  retention: ArtifactRetention;
}

export interface ArtifactRef {
  name: string;
  sha256: string;
  digest: string;
  bytes: number;
  byteSize: number;
  runId: string;
  stepId: string;
  attemptId: string;
  mediaType?: string;
}

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Buffer(buf: Buffer | Uint8Array): string {
  return sha256Hex(buf);
}

export async function hashFile(filePath: string): Promise<{ digest: string; byteSize: number }> {
  const buf = Buffer.from(await Bun.file(filePath).arrayBuffer());
  return { digest: sha256Hex(buf), byteSize: buf.byteLength };
}

export async function sha256File(filePath: string): Promise<string> {
  return (await hashFile(filePath)).digest;
}

/** Validate logical artifact name; returns trimmed name. Throws ArtifactError. */
export function assertValidArtifactName(name: string): string {
  try {
    return pathAssertValidArtifactName(name);
  } catch (e) {
    throw new ArtifactError('INVALID_NAME', (e as Error).message);
  }
}

/** Reject absolute paths and `..` traversal. Returns normalized relative path. */
export function assertSafeRelativePath(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new ArtifactError('INVALID_PATH', 'path must be a non-empty relative path');
  }
  if (path.isAbsolute(rel)) {
    throw new ArtifactError('INVALID_PATH', `path must be relative, got absolute: ${rel}`);
  }
  if (rel.includes('\0')) {
    throw new ArtifactError('INVALID_PATH', 'path contains null byte');
  }
  const norm = path.normalize(rel);
  if (norm === '..' || norm.startsWith(`..${path.sep}`) || norm.includes(`${path.sep}..`)) {
    throw new ArtifactError('INVALID_PATH', `path must not contain '..': ${rel}`);
  }
  return norm;
}

export function validateArtifactDecl(decl: {
  name: string;
  path?: string;
  maxBytes?: number;
}): void {
  assertValidArtifactName(decl.name);
  if (decl.path !== undefined) assertSafeRelativePath(decl.path);
  if (decl.maxBytes !== undefined && (typeof decl.maxBytes !== 'number' || decl.maxBytes < 0)) {
    throw new ArtifactError('INVALID_DECL', 'maxBytes must be a non-negative number');
  }
}

export async function ensureArtifactDirs(runId: string): Promise<void> {
  assertValidRunId(runId);
  await fs.mkdir(runArtifactBlobsDir(runId), { recursive: true });
  await fs.mkdir(runArtifactManifestsDir(runId), { recursive: true });
}

/**
 * Resolve `candidate` under `root`, realpath when possible, reject escape / symlink-out.
 */
export async function resolveContainedPath(root: string, candidate: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(realRoot, candidate);

  let probe = abs;
  let realCandidate: string | null = null;
  while (true) {
    try {
      realCandidate = await fs.realpath(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  let resolved: string;
  if (realCandidate === null) {
    resolved = abs;
  } else if (probe === abs) {
    resolved = realCandidate;
  } else {
    const rest = path.relative(probe, abs);
    if (rest.startsWith('..')) {
      throw new ArtifactError('ESCAPE', `path escapes root: ${candidate}`);
    }
    resolved = path.resolve(realCandidate, rest);
  }
  if (!isPathInsideRoot(resolved, realRoot)) {
    throw new ArtifactError(
      'ESCAPE',
      `path '${candidate}' is outside containment root '${realRoot}'`,
    );
  }
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) {
      const target = await fs.realpath(abs);
      if (!isPathInsideRoot(target, realRoot)) {
        throw new ArtifactError(
          'ESCAPE',
          `symlink '${candidate}' resolves outside containment root`,
        );
      }
      return target;
    }
  } catch (e) {
    if (e instanceof ArtifactError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (/outside|escape/i.test(String((e as Error).message))) throw e;
    }
  }
  return resolved;
}

export function refFromManifest(m: ArtifactManifest): ArtifactRef {
  return {
    name: m.name,
    sha256: m.digest,
    digest: m.digest,
    bytes: m.byteSize,
    byteSize: m.byteSize,
    runId: m.runId,
    stepId: m.stepId,
    attemptId: m.attemptId,
    mediaType: m.mediaType,
  };
}

/**
 * Collect a declared output into the content-addressed store.
 */
export async function collectOutputArtifact(args: {
  runId: string;
  stepId: string;
  attemptId: string;
  cwd: string;
  decl: ArtifactOutputDecl;
  now?: string;
}): Promise<ArtifactManifest | null> {
  const { runId, stepId, attemptId, cwd, decl } = args;
  validateArtifactDecl({ name: decl.name, path: decl.path, maxBytes: decl.maxBytes });
  await ensureArtifactDirs(runId);

  const maxBytes = decl.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  let resolved: string;
  try {
    resolved = await resolveContainedPath(cwd, decl.path);
  } catch (e) {
    if (decl.required === false) return null;
    throw e instanceof ArtifactError
      ? e
      : new ArtifactError('COLLECT', `artifact '${decl.name}': ${(e as Error).message}`);
  }

  const exists = await Bun.file(resolved).exists();
  if (!exists) {
    if (decl.required === false) return null;
    throw new ArtifactError(
      'MISSING',
      `artifact '${decl.name}': required path not found: ${decl.path}`,
    );
  }

  const st = await fs.lstat(resolved);
  if (st.isSymbolicLink()) {
    const target = await fs.realpath(resolved);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(cwd);
    } catch {
      realRoot = path.resolve(cwd);
    }
    if (!isPathInsideRoot(target, realRoot)) {
      throw new ArtifactError('ESCAPE', `artifact '${decl.name}': symlink escapes step cwd`);
    }
    resolved = target;
  }
  if (!st.isFile() && !st.isSymbolicLink()) {
    throw new ArtifactError('INVALID', `artifact '${decl.name}': not a regular file: ${decl.path}`);
  }

  if (st.size > maxBytes) {
    throw new ArtifactError(
      'OVERSIZE',
      `artifact '${decl.name}': size ${st.size} exceeds maxBytes ${maxBytes}`,
    );
  }

  const buf = Buffer.from(await Bun.file(resolved).arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new ArtifactError(
      'OVERSIZE',
      `artifact '${decl.name}': content size ${buf.byteLength} exceeds maxBytes ${maxBytes}`,
    );
  }
  const digest = sha256Hex(buf);
  const blob = runArtifactBlobPath(runId, digest);
  if (!(await Bun.file(blob).exists())) {
    const tmp = `${blob}.${process.pid}.${Date.now()}.tmp`;
    await Bun.write(tmp, buf);
    await fs.rename(tmp, blob).catch(async () => {
      if (await Bun.file(blob).exists()) {
        await fs.unlink(tmp).catch(() => {});
        return;
      }
      throw new ArtifactError('STORE', `artifact '${decl.name}': failed to store blob`);
    });
  } else {
    const existing = sha256Hex(Buffer.from(await Bun.file(blob).arrayBuffer()));
    if (existing !== digest) {
      throw new ArtifactError('CORRUPT', `artifact store corrupted for digest ${digest}`);
    }
  }

  const manifest: ArtifactManifest = {
    name: decl.name,
    runId,
    stepId,
    attemptId,
    digest,
    sha256: digest,
    byteSize: buf.byteLength,
    bytes: buf.byteLength,
    mediaType: decl.mediaType,
    sourcePath: resolved,
    createdAt: args.now ?? new Date().toISOString(),
    verification: {
      hashVerified: true,
      pathContained: true,
      sizeOk: true,
    },
    sensitivity: decl.sensitivity ?? 'normal',
    retention: decl.retention ?? 'run',
  };

  const mpath = runArtifactManifestPath(runId, decl.name);
  await fs.mkdir(path.dirname(mpath), { recursive: true });
  const mtmp = `${mpath}.${process.pid}.tmp`;
  await Bun.write(mtmp, JSON.stringify(manifest, null, 2));
  await fs.rename(mtmp, mpath);
  return manifest;
}

/** Alias used by workflow.ts */
export const collectArtifact = collectOutputArtifact;

/**
 * Collect all declared outputs.
 * Returns a map name → manifest (tests). Also iterable as values for array-style callers.
 */
export async function collectDeclaredOutputs(args: {
  runId: string;
  stepId: string;
  attemptId: string;
  cwd: string;
  outputs: ArtifactOutputDecl[];
  now?: string;
}): Promise<Record<string, ArtifactManifest>> {
  const map: Record<string, ArtifactManifest> = {};
  for (const decl of args.outputs) {
    const m = await collectOutputArtifact({ ...args, decl });
    if (m) map[m.name] = m;
  }
  return map;
}

export async function readArtifactManifest(
  runId: string,
  name: string,
): Promise<ArtifactManifest | null> {
  assertValidRunId(runId);
  assertValidArtifactName(name);
  const f = Bun.file(runArtifactManifestPath(runId, name));
  if (!(await f.exists())) return null;
  try {
    const m = (await f.json()) as ArtifactManifest;
    // Normalize legacy field names
    if (m.digest && !m.sha256) m.sha256 = m.digest;
    if (m.sha256 && !m.digest) m.digest = m.sha256;
    if (m.byteSize !== undefined && m.bytes === undefined) m.bytes = m.byteSize;
    if (m.bytes !== undefined && m.byteSize === undefined) m.byteSize = m.bytes;
    return m;
  } catch {
    return null;
  }
}


export async function listArtifactManifests(runId: string): Promise<ArtifactManifest[]> {
  const dir = runArtifactManifestsDir(runId);
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: ArtifactManifest[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const m = await readArtifactManifest(runId, n.slice(0, -'.json'.length));
    if (m) out.push(m);
  }
  return out;
}

export async function verifyStoredBlob(runId: string, digest: string): Promise<boolean> {
  try {
    const blob = runArtifactBlobPath(runId, digest);
    if (!(await Bun.file(blob).exists())) return false;
    const buf = Buffer.from(await Bun.file(blob).arrayBuffer());
    return sha256Hex(buf) === digest.toLowerCase();
  } catch {
    return false;
  }
}

export async function verifyArtifactBlob(
  runId: string,
  manifest: Pick<ArtifactManifest, 'digest' | 'sha256' | 'byteSize' | 'bytes'>,
): Promise<boolean> {
  const dig = manifest.digest ?? manifest.sha256;
  const size = manifest.byteSize ?? manifest.bytes;
  if (!dig || !/^[a-f0-9]{64}$/i.test(dig)) return false;
  const blob = runArtifactBlobPath(runId, dig);
  if (!(await Bun.file(blob).exists())) return false;
  const buf = Buffer.from(await Bun.file(blob).arrayBuffer());
  if (size !== undefined && buf.byteLength !== size) return false;
  return sha256Hex(buf) === dig.toLowerCase();
}

/**
 * Materialize a stored artifact into the run inputs directory for a consumer step.
 */
export async function materializeInput(args: {
  runId: string;
  stepId: string;
  ref: ArtifactRef;
  destName?: string;
}): Promise<string> {
  const dig = args.ref.digest ?? args.ref.sha256;
  if (!(await verifyStoredBlob(args.runId, dig))) {
    throw new ArtifactError(
      'TAMPER',
      `artifact '${args.ref.name}' failed hash verification (tampered or missing blob)`,
    );
  }
  const destRoot = runStepInputsDir(args.runId, args.stepId);
  await fs.mkdir(destRoot, { recursive: true });
  const destName = args.destName ?? args.ref.name;
  if (destName.includes('..') || destName.includes('/') || destName.includes('\\')) {
    throw new ArtifactError('INVALID_PATH', `invalid dest name '${destName}'`);
  }
  const dest = path.join(destRoot, destName);
  if (!isPathInsideRoot(dest, destRoot)) {
    throw new ArtifactError('ESCAPE', 'materialize path escapes inputs dir');
  }
  const blob = runArtifactBlobPath(args.runId, dig);
  await fs.copyFile(blob, dest);
  const h = await sha256File(dest);
  if (h !== dig.toLowerCase()) {
    await fs.unlink(dest).catch(() => {});
    throw new ArtifactError('TAMPER', `artifact '${args.ref.name}' copy integrity check failed`);
  }
  return dest;
}

/** Materialize by logical name under artifacts/inputs (workflow-style). */
export async function materializeArtifact(args: {
  runId: string;
  name: string;
  destRel?: string;
}): Promise<{ path: string; manifest: ArtifactManifest }> {
  const manifest = await readArtifactManifest(args.runId, args.name);
  if (!manifest) {
    throw new ArtifactError('MISSING', `artifact '${args.name}' not found for run '${args.runId}'`);
  }
  if (!(await verifyArtifactBlob(args.runId, manifest))) {
    throw new ArtifactError(
      'TAMPER',
      `artifact '${args.name}' failed hash verification (tampered or missing blob)`,
    );
  }
  const dest = await materializeInput({
    runId: args.runId,
    stepId: '_shared',
    ref: refFromManifest(manifest),
    destName: args.destRel ? path.basename(args.destRel) : manifest.name,
  });
  return { path: dest, manifest };
}

/**
 * Resolve and materialize declared inputs for a step.
 * Returns absolute paths by local input name.
 */
export async function materializeStepInputs(args: {
  runId: string;
  inputs: ArtifactInputDecl[];
  resolve: (fromStep: string, artifactName: string) => ArtifactRef | undefined;
}): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const inp of args.inputs) {
    const artName = inp.artifact ?? inp.name;
    const ref = args.resolve(inp.fromStep, artName);
    if (!ref) {
      throw new ArtifactError(
        'MISSING',
        `input '${inp.name}': no artifact '${artName}' from step '${inp.fromStep}'`,
      );
    }
    const dest = await materializeInput({
      runId: args.runId,
      stepId: inp.fromStep,
      ref,
      destName: inp.materializeAs ? path.basename(inp.materializeAs) : artName,
    });
    paths[inp.name] = dest;
  }
  return paths;
}

export function artifactsRoot(runId: string): string {
  return runArtifactsDir(runId);
}
