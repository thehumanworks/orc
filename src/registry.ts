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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RegistryLockOwner {
  pid?: number;
  token?: string;
  createdAt?: string;
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

/** Live status of a record reconciled against the driver. */
export async function reconcileStatus(
  driver: Driver,
  rec: SessionRecord,
): Promise<'running' | 'dead'> {
  return (await driver.isAlive(rec.tmuxName)) ? 'running' : 'dead';
}
