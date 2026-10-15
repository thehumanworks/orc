/**
 * The durable mailbox (design §4.3). Any process may drop an item; only the actor
 * consumes. Items are written as `.tmp-<ULID>` in inbox/ (fsync) and renamed to
 * `<ULID>.json`, so a listed item is always complete. Listing ignores anything that does
 * not match INBOX_FILE_RE (temp files, quarantined items, stray files).
 */
import fs from 'node:fs';
import path from 'node:path';
import { INBOX_FILE_RE } from './types.ts';
import type { InboxItem } from './types.ts';
import { sessionPaths } from './layout.ts';
import { ensurePrivateDir, writeFileAtomic } from './fsutil.ts';
import { ulid as newUlid } from './ulid.ts';

/** What a client hands to `enqueue` (ulid/createdAt are assigned here). */
export type NewInboxItem =
  | { kind: 'message'; messageId: string; text: string }
  | { kind: 'interrupt' }
  | { kind: 'stop'; reason?: string; graceMs?: number };

function inboxDir(sessionId: string): string {
  return sessionPaths(sessionId).inbox;
}

export function inboxItemPath(sessionId: string, ulid: string): string {
  return path.join(inboxDir(sessionId), `${ulid}.json`);
}

/** Durably enqueue an item; returns it with its ULID. */
export function enqueue(sessionId: string, item: NewInboxItem): InboxItem {
  const dir = inboxDir(sessionId);
  ensurePrivateDir(dir);
  const ulid = newUlid();
  const full = { ...item, ulid, createdAt: new Date().toISOString() } as InboxItem;
  writeFileAtomic(path.join(dir, `${ulid}.json`), JSON.stringify(full), {
    mode: 0o600,
    fsync: true,
    tmpPath: path.join(dir, `.tmp-${ulid}`),
  });
  return full;
}

function isInboxItem(x: unknown, ulid: string): x is InboxItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.ulid !== ulid || typeof o.createdAt !== 'string') return false;
  switch (o.kind) {
    case 'message':
      return typeof o.messageId === 'string' && typeof o.text === 'string';
    case 'interrupt':
    case 'stop':
      return true;
    default:
      return false;
  }
}

export interface PendingListing {
  /** Valid items, sorted by ULID. */
  items: InboxItem[];
  /** ULIDs of validly-named files whose content is not a valid item. */
  invalid: string[];
}

/** Pending items (sorted by ULID) plus invalid-file ULIDs. Missing inbox → empty. */
export function listPendingDetailed(sessionId: string): PendingListing {
  const dir = inboxDir(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { items: [], invalid: [] };
    throw e;
  }
  const out: PendingListing = { items: [], invalid: [] };
  for (const name of names.filter((n) => INBOX_FILE_RE.test(n)).sort()) {
    const ulid = name.slice(0, -'.json'.length);
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') continue; // consumed meanwhile
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      out.invalid.push(ulid);
      continue;
    }
    if (isInboxItem(parsed, ulid)) out.items.push(parsed);
    else out.invalid.push(ulid);
  }
  return out;
}

/** Pending valid items, sorted by ULID. */
export function listPending(sessionId: string): InboxItem[] {
  return listPendingDetailed(sessionId).items;
}

/** Remove a consumed item. Missing is not an error. */
export function removeInboxItem(sessionId: string, ulid: string): void {
  fs.rmSync(inboxItemPath(sessionId, ulid), { force: true });
}

/** Move an unreadable item aside (`.bad-<ULID>.json`, ignored by listing). */
export function quarantineInboxItem(sessionId: string, ulid: string): void {
  const dir = inboxDir(sessionId);
  try {
    fs.renameSync(path.join(dir, `${ulid}.json`), path.join(dir, `.bad-${ulid}.json`));
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
}
