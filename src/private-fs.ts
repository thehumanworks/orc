/**
 * Owner-only orc state. What orc keeps under ORC_HOME (~/.orc) can hold prompt bodies,
 * step prompts, cwd paths, aliases and peer host names, so it is created owner-only
 * whatever the umask: directories 0700, files 0600. Modes are set explicitly (chmod /
 * fchmod) because mkdir/open modes are umask-filtered; state written by an older orc is
 * tightened the next time orc writes it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { orcHome } from './paths.ts';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Ancestors of `dir` inside ORC_HOME, ORC_HOME first (empty when `dir` is outside it). */
function ancestorsInsideHome(dir: string): string[] {
  const home = orcHome();
  const rel = path.relative(home, dir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
  const out = [home];
  let cur = home;
  const parts = rel.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    out.push(cur);
  }
  return out;
}

/**
 * mkdir -p `dir` and chmod it 0700. Its ancestors inside ORC_HOME (ORC_HOME included) are
 * chmod'ed 0700 too, best effort; nothing outside ORC_HOME is touched except `dir`.
 */
export function ensurePrivateDir(dir: string): void {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true, mode: PRIVATE_DIR_MODE });
  for (const d of ancestorsInsideHome(abs)) {
    try {
      fs.chmodSync(d, PRIVATE_DIR_MODE);
    } catch {
      /* not ours, or removed concurrently: best effort */
    }
  }
  fs.chmodSync(abs, PRIVATE_DIR_MODE);
}

/**
 * Atomically replace `file` with `data` at mode 0600: write a temp file in the same dir
 * (O_EXCL, fchmod), then rename it over the target.
 */
export async function writePrivateFile(
  file: string,
  data: string | Uint8Array,
  opts: { tmpPath?: string } = {},
): Promise<void> {
  const tmp = opts.tmpPath ?? path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fsp.open(tmp, 'wx', PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(data);
  } catch (e) {
    await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  await handle.close();
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}
