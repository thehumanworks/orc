/**
 * Registry: persist + reconcile session records. ~/.orc/registry.json is an array
 * of SessionRecord, written atomically (tmp + rename).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { registryPath, orcHome } from './paths.ts';
import type { SessionRecord } from './types.ts';
import type { Driver } from './drivers/driver.ts';

const REGISTRY_LOCK_POLL_MS = 25;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 300_000;
const REGISTRY_LOCK_CLEANUP_SUFFIX = '.cleanup';
const ALIAS_RESERVATION_GRACE_MS = 600_000;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RegistryLockOwner {
  pid?: number;
  token?: string;
  createdAt?: string;
}

export interface AliasSelector {
  alias: string;
  workspace?: string;
}

export function validateAlias(alias: string | undefined): string | undefined {
  if (alias === undefined) return undefined;
  const trimmed = alias.trim();
  if (!ALIAS_PATTERN.test(trimmed)) {
    throw new Error(
      `invalid alias '${alias}' (use 1-64 chars: letters, numbers, dot, underscore, dash; no @ or :)`,
    );
  }
  return trimmed;
}

export function parseAliasSelector(value: string): AliasSelector | null {
  if (!value.startsWith('@')) return null;
  const body = value.slice(1);
  const colon = body.indexOf(':');
  try {
    if (colon === -1) {
      const alias = validateAlias(body);
      return alias ? { alias } : null;
    }

    const workspace = body.slice(0, colon).trim();
    const alias = validateAlias(body.slice(colon + 1));
    if (!workspace || !alias) return null;
    return { workspace, alias };
  } catch {
    return null;
  }
}

export function workspaceAlias(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/g, '');
  return path.basename(trimmed) || trimmed || workspace;
}

export function aliasHandle(rec: Pick<SessionRecord, 'alias' | 'workspace'>): string | undefined {
  if (!rec.alias) return undefined;
  return `@${workspaceAlias(rec.workspace)}:${rec.alias}`;
}

async function isActiveRecord(driver: Driver, rec: SessionRecord): Promise<boolean> {
  if (rec.status === 'dead') return false;
  try {
    return await driver.isAlive(rec.tmuxName);
  } catch {
    return false;
  }
}

async function blocksAliasReservation(driver: Driver, rec: SessionRecord): Promise<boolean> {
  if (rec.status === 'dead') return false;
  if (await isActiveRecord(driver, rec)) return true;
  if (!rec.aliasReservedAt) return false;
  const reserved = Date.parse(rec.aliasReservedAt);
  return Number.isFinite(reserved) && Date.now() - reserved < ALIAS_RESERVATION_GRACE_MS;
}

function aliasCandidates(
  records: SessionRecord[],
  selector: AliasSelector,
  defaultWorkspace: string,
): SessionRecord[] {
  const aliased = records.filter((r) => r.alias === selector.alias);
  if (selector.workspace === undefined) {
    return aliased.filter((r) => r.workspace === defaultWorkspace);
  }

  const exact = aliased.filter((r) => r.workspace === selector.workspace);
  if (exact.length > 0) return exact;
  return aliased.filter((r) => workspaceAlias(r.workspace) === selector.workspace);
}

/** Read the registry array. Missing/corrupt file => empty. */
async function readRegistryUnlocked(): Promise<SessionRecord[]> {
  const file = Bun.file(registryPath());
  if (!(await file.exists())) return [];
  try {
    const data = (await file.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data as SessionRecord[];
  } catch {
    return [];
  }
}

export async function readRegistry(): Promise<SessionRecord[]> {
  return readRegistryUnlocked();
}

/** Write the registry array atomically (tmp + rename). */
async function writeRegistryUnlocked(records: SessionRecord[]): Promise<void> {
  const home = orcHome();
  await fs.mkdir(home, { recursive: true });
  const target = registryPath();
  const tmp = path.join(home, `.registry.${randomUUID()}.tmp`);
  await Bun.write(tmp, JSON.stringify(records, null, 2));
  await fs.rename(tmp, target);
}

async function acquireRegistryLock(): Promise<() => Promise<void>> {
  const home = orcHome();
  await fs.mkdir(home, { recursive: true });
  const lock = path.join(home, '.registry.lock');
  const token = randomUUID();
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await Bun.file(lock).text()) as RegistryLockOwner;
          if (owner.token === token) await fs.rm(lock, { force: true });
        } catch {
          // Missing or unreadable lock: treat as already released/stolen.
        }
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;

      let st: Stats;
      try {
        st = await fs.stat(lock);
      } catch (statError) {
        if ((statError as { code?: string }).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - st.mtimeMs > REGISTRY_LOCK_STALE_MS) {
        if (await tryRemoveStaleRegistryLock(lock)) continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for registry lock: ${lock}`);
      }
      await sleep(REGISTRY_LOCK_POLL_MS);
    }
  }
}

async function tryRemoveStaleRegistryLock(lock: string): Promise<boolean> {
  const releaseCleanup = await acquireRegistryCleanupLock(`${lock}${REGISTRY_LOCK_CLEANUP_SUFFIX}`);
  try {
    const st = await fs.stat(lock).catch(() => null);
    if (!st) return true;
    if (Date.now() - st.mtimeMs <= REGISTRY_LOCK_STALE_MS) return false;

    const owner = await readRegistryLockOwner(lock);
    if (owner.pid && processIsAlive(owner.pid)) return false;

    await fs.rm(lock, { force: true });
    return true;
  } finally {
    await releaseCleanup();
  }
}

async function acquireRegistryCleanupLock(lock: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await Bun.file(lock).text()) as RegistryLockOwner;
          if (owner.token === token) await fs.rm(lock, { force: true });
        } catch {
          // Missing or unreadable cleanup lock: treat as already released.
        }
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for registry lock cleanup lock: ${lock}`);
      }
      await sleep(REGISTRY_LOCK_POLL_MS);
    }
  }
}

async function readRegistryLockOwner(lock: string): Promise<RegistryLockOwner> {
  try {
    return JSON.parse(await Bun.file(lock).text()) as RegistryLockOwner;
  } catch {
    return {};
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

export async function writeRegistry(records: SessionRecord[]): Promise<void> {
  const release = await acquireRegistryLock();
  try {
    await writeRegistryUnlocked(records);
  } finally {
    await release();
  }
}

export async function updateRegistry<T>(
  fn: (records: SessionRecord[]) => Promise<{ records: SessionRecord[]; value: T }> | {
    records: SessionRecord[];
    value: T;
  },
): Promise<T> {
  const release = await acquireRegistryLock();
  try {
    const records = await readRegistryUnlocked();
    const result = await fn(records);
    await writeRegistryUnlocked(result.records);
    return result.value;
  } finally {
    await release();
  }
}

/** Insert or replace a record by id. */
export async function upsertRecord(rec: SessionRecord): Promise<void> {
  await updateRegistry((records) => {
    const next = records.slice();
    const idx = next.findIndex((r) => r.id === rec.id);
    if (idx === -1) next.push(rec);
    else next[idx] = rec;
    return { records: next, value: undefined };
  });
}

/** Reserve or update a record under the registry lock, enforcing workspace alias uniqueness. */
export async function reserveRecord(rec: SessionRecord, opts: { driver: Driver }): Promise<void> {
  await updateRegistry(async (records) => {
    if (rec.alias) {
      for (const existing of records) {
        if (existing.id === rec.id) continue;
        if (existing.alias !== rec.alias || existing.workspace !== rec.workspace) continue;
        if (!(await blocksAliasReservation(opts.driver, existing))) continue;
        throw new Error(
          `alias '@${rec.alias}' is already in use by active session ${existing.id} in workspace '${workspaceAlias(
            rec.workspace,
          )}'`,
        );
      }
    }

    const next = records.slice();
    const idx = next.findIndex((r) => r.id === rec.id);
    if (idx === -1) next.push(rec);
    else next[idx] = rec;
    return { records: next, value: undefined };
  });
}

/** Remove a record by id. */
export async function removeRecord(id: string): Promise<void> {
  await updateRegistry((records) => ({
    records: records.filter((r) => r.id !== id),
    value: undefined,
  }));
}

/** Find a record by short id, full sessionId, or tmux name. */
export async function findRecord(idOrName: string): Promise<SessionRecord | null> {
  const records = await readRegistry();
  return (
    records.find(
      (r) => r.id === idOrName || r.sessionId === idOrName || r.tmuxName === idOrName,
    ) ?? null
  );
}

export async function findRecordByAlias(
  selector: AliasSelector,
  opts: { defaultWorkspace: string; driver: Driver },
): Promise<SessionRecord | null> {
  const records = await readRegistry();
  const candidates = aliasCandidates(records, selector, opts.defaultWorkspace);
  const active: SessionRecord[] = [];
  for (const rec of candidates) {
    if (await isActiveRecord(opts.driver, rec)) active.push(rec);
  }
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!;

  const scope = selector.workspace ?? workspaceAlias(opts.defaultWorkspace);
  throw new Error(
    `alias '@${scope}:${selector.alias}' is ambiguous (${active
      .map((r) => r.id)
      .join(', ')})`,
  );
}

export async function assertAliasAvailable(
  alias: string | undefined,
  opts: { workspace: string; driver: Driver },
): Promise<void> {
  if (!alias) return;
  const records = await readRegistry();
  for (const rec of records) {
    if (rec.alias !== alias || rec.workspace !== opts.workspace) continue;
    if (!(await isActiveRecord(opts.driver, rec))) continue;
    throw new Error(
      `alias '@${alias}' is already in use by active session ${rec.id} in workspace '${workspaceAlias(
        opts.workspace,
      )}'`,
    );
  }
}

/** Live status of a record reconciled against the driver. */
export async function reconcileStatus(
  driver: Driver,
  rec: SessionRecord,
): Promise<'running' | 'dead'> {
  return (await driver.isAlive(rec.tmuxName)) ? 'running' : 'dead';
}
