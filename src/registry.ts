/**
 * Registry: persist + reconcile session records. ~/.orc/registry.json is an array
 * of SessionRecord, written atomically (tmp + rename).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registryPath, orcHome } from './paths.ts';
import type { SessionRecord } from './types.ts';
import type { Driver } from './drivers/driver.ts';

/** Read the registry array. Missing/corrupt file => empty. */
export async function readRegistry(): Promise<SessionRecord[]> {
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

/** Write the registry array atomically (tmp + rename). */
export async function writeRegistry(records: SessionRecord[]): Promise<void> {
  const home = orcHome();
  await fs.mkdir(home, { recursive: true });
  const target = registryPath();
  const tmp = path.join(home, `.registry.${randomUUID()}.tmp`);
  await Bun.write(tmp, JSON.stringify(records, null, 2));
  await fs.rename(tmp, target);
}

/** Insert or replace a record by id. */
export async function upsertRecord(rec: SessionRecord): Promise<void> {
  const records = await readRegistry();
  const idx = records.findIndex((r) => r.id === rec.id);
  if (idx === -1) records.push(rec);
  else records[idx] = rec;
  await writeRegistry(records);
}

/** Remove a record by id. */
export async function removeRecord(id: string): Promise<void> {
  const records = await readRegistry();
  const next = records.filter((r) => r.id !== id);
  if (next.length !== records.length) await writeRegistry(next);
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
