/**
 * Small durable-filesystem helpers for the actor kernel: atomic (tmp + rename) writes with
 * explicit modes and optional fsync, tolerant JSON reads, private directories and
 * session-id validation. Synchronous on purpose: the kernel's critical sections are tiny
 * and a sync write cannot interleave with another task on the same thread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** orc session ids are uuids in practice; anything path-safe and reasonably long is accepted. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function assertValidSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `invalid sessionId '${String(sessionId)}' (8-64 chars: letter/digit, then letters/digits/hyphens)`,
    );
  }
  return sessionId;
}

/** Write all of `data` to `fd` (loops over short writes). */
export function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/** Best-effort fsync of a directory (persists a rename). Unsupported platforms are ignored. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface WriteFileAtomicOptions {
  /** File mode, enforced with fchmod (umask-proof). Default 0o600. */
  mode?: number;
  /** fsync the data before the rename and the parent dir after it. Default false. */
  fsync?: boolean;
  /** Explicit temp path (must be in the same directory). Default `.<name>.tmp-<pid>-<rand>`. */
  tmpPath?: string;
}

/**
 * Atomically replace `filePath`: open a temp file in the same dir (O_EXCL, mode), write,
 * optionally fsync, close, rename over the target, optionally fsync the parent dir.
 * Readers see either the old or the new content, never a mix.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): void {
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(filePath);
  const tmp =
    opts.tmpPath ??
    path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.fchmodSync(fd, mode);
    writeAll(fd, data);
    if (opts.fsync) fs.fsyncSync(fd);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (opts.fsync) fsyncDir(dir);
}

/** Parse a JSON file. Missing → undefined; unreadable/corrupt → throws with the path. */
export function readJsonFile<T>(filePath: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`corrupt JSON in ${filePath}: ${(e as Error).message}`);
  }
}

/** mkdir -p with mode 0700, then chmod the leaf explicitly (mkdir modes are umask-filtered). */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Last `maxBytes` of a text file ('' when missing). */
export function readFileTail(filePath: string, maxBytes = 4_096): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, size - len + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
