/**
 * The session journal: append-only JSONL facts with a monotonic `seq` (design §4.3).
 *
 * - One writer (the lease-holding actor) appends through a kept-open fd; entries whose
 *   type is in DURABLE_EVENT_TYPES are fsync'd.
 * - Readers are tolerant: an unterminated final line is an in-flight or torn write and is
 *   dropped; any other unparseable line is skipped.
 * - On start the actor truncates a torn tail (`repairTornTail`) so new appends never glue
 *   onto a partial line, and continues `seq` from the last valid entry.
 */
import fs from 'node:fs';
import { DURABLE_EVENT_TYPES } from './types.ts';
import type { JournalEntry, JournalEvent } from './types.ts';
import { sessionPaths } from './layout.ts';
import { writeAll } from './fsutil.ts';

const NL = 0x0a;

export function isJournalEntry(x: unknown): x is JournalEntry {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.seq === 'number' &&
    Number.isInteger(o.seq) &&
    o.seq > 0 &&
    typeof o.type === 'string' &&
    typeof o.ts === 'string'
  );
}

function parseLine(line: string): JournalEntry | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const o: unknown = JSON.parse(line);
    return isJournalEntry(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse journal text. Only newline-terminated lines count: the final unterminated segment
 * (a torn or in-flight write) is dropped. Invalid lines are skipped.
 */
export function parseJournalText(text: string): JournalEntry[] {
  const lines = text.split('\n');
  lines.pop(); // unterminated tail ('' when the text ends with a newline)
  const out: JournalEntry[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  return out;
}

export interface ReadJournalOptions {
  /** Only entries with seq >= fromSeq. */
  fromSeq?: number;
  /** Only the last N entries (after fromSeq filtering). */
  tail?: number;
}

export function readJournalFile(filePath: string, opts: ReadJournalOptions = {}): JournalEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
  let entries = parseJournalText(text);
  if (opts.fromSeq !== undefined) {
    const from = opts.fromSeq;
    entries = entries.filter((e) => e.seq >= from);
  }
  if (opts.tail !== undefined) entries = opts.tail <= 0 ? [] : entries.slice(-opts.tail);
  return entries;
}

/** All (or a filtered slice of) a session's journal entries. Missing journal → []. */
export function readJournal(sessionId: string, opts: ReadJournalOptions = {}): JournalEntry[] {
  return readJournalFile(sessionPaths(sessionId).journal, opts);
}

function maxSeq(entries: JournalEntry[]): number {
  let m = 0;
  for (const e of entries) if (e.seq > m) m = e.seq;
  return m;
}

/**
 * Truncate a torn tail: bytes after the last newline, plus any trailing newline-terminated
 * lines that are not valid entries (e.g. zero-filled blocks after a power loss). Returns
 * the number of bytes removed. Mid-file garbage is left alone (readers skip it).
 */
export function repairTornTail(filePath: string): number {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return 0;
    throw e;
  }
  let keep = buf.lastIndexOf(NL) + 1; // 0 when there is no newline at all
  while (keep > 0) {
    const prevNl = keep >= 2 ? buf.lastIndexOf(NL, keep - 2) : -1;
    const line = buf.subarray(prevNl + 1, keep - 1).toString('utf8');
    if (line.trim().length === 0 || parseLine(line)) break;
    keep = prevNl + 1;
  }
  const removed = buf.length - keep;
  if (removed > 0) fs.truncateSync(filePath, keep);
  return removed;
}

/**
 * Single-writer appender. `open` repairs a torn tail and continues seq from the last valid
 * entry. Only the lease-holding actor (or a client holding the actor lock while no actor
 * is live) may append.
 */
export class JournalWriter {
  private fd: number;
  private _lastSeq: number;

  private constructor(
    readonly path: string,
    fd: number,
    lastSeq: number,
  ) {
    this.fd = fd;
    this._lastSeq = lastSeq;
  }

  static open(filePath: string): JournalWriter {
    repairTornTail(filePath);
    const last = maxSeq(readJournalFile(filePath));
    const fd = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
    return new JournalWriter(filePath, fd, last);
  }

  static forSession(sessionId: string): JournalWriter {
    return JournalWriter.open(sessionPaths(sessionId).journal);
  }

  get lastSeq(): number {
    return this._lastSeq;
  }

  get closed(): boolean {
    return this.fd < 0;
  }

  /** Append one event (seq/ts assigned here). fsync'd when durable (or when forced). */
  append(event: JournalEvent, opts: { fsync?: boolean } = {}): JournalEntry {
    if (this.fd < 0) throw new Error(`journal ${this.path} is closed`);
    const entry = { seq: this._lastSeq + 1, ts: new Date().toISOString(), ...event } as JournalEntry;
    writeAll(this.fd, `${JSON.stringify(entry)}\n`);
    this._lastSeq = entry.seq;
    if (opts.fsync ?? DURABLE_EVENT_TYPES.has(event.type)) fs.fsyncSync(this.fd);
    return entry;
  }

  /** Re-read the highest seq on disk (used when another writer may have appended). */
  resync(): void {
    this._lastSeq = Math.max(this._lastSeq, maxSeq(readJournalFile(this.path)));
  }

  close(): void {
    if (this.fd < 0) return;
    try {
      fs.closeSync(this.fd);
    } finally {
      this.fd = -1;
    }
  }
}

/**
 * Incremental reader: each `readNew()` returns complete entries appended since the last
 * call (never a partial line). Survives truncation (rescans and dedupes by seq).
 */
export class JournalCursor {
  private offset = 0;
  private lastSeq = 0;

  constructor(readonly path: string) {}

  static forSession(sessionId: string): JournalCursor {
    return new JournalCursor(sessionPaths(sessionId).journal);
  }

  readNew(): JournalEntry[] {
    let fd: number;
    try {
      fd = fs.openSync(this.path, 'r');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // truncated: rescan, dedupe by seq
      const len = size - this.offset;
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      const lastNl = buf.subarray(0, read).lastIndexOf(NL);
      if (lastNl < 0) return [];
      this.offset += lastNl + 1;
      const out = parseJournalText(buf.subarray(0, lastNl + 1).toString('utf8')).filter(
        (e) => e.seq > this.lastSeq,
      );
      for (const e of out) if (e.seq > this.lastSeq) this.lastSeq = e.seq;
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

export interface FollowJournalOptions {
  /** First seq to yield (inclusive). Default 1 (everything). */
  fromSeq?: number;
  signal?: AbortSignal;
  /** Poll interval. Default 150 ms. */
  pollMs?: number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Follow a session's journal (poll-based): yields existing entries from `fromSeq`, then
 * new ones as they are appended, until `signal` aborts. Never yields a partial line.
 */
export async function* followJournal(
  sessionId: string,
  opts: FollowJournalOptions = {},
): AsyncGenerator<JournalEntry> {
  const cursor = JournalCursor.forSession(sessionId);
  const from = opts.fromSeq ?? 1;
  const pollMs = opts.pollMs ?? 150;
  while (!opts.signal?.aborted) {
    for (const e of cursor.readNew()) {
      if (opts.signal?.aborted) return;
      if (e.seq >= from) yield e;
    }
    await abortableSleep(pollMs, opts.signal);
  }
}
