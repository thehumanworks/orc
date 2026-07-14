/**
 * Path containment helpers shared by workflow import roots and artifact collection.
 * Kept separate so artifacts.ts does not import the full workflow module.
 */
import path from 'node:path';

/** True when `child` is `root` or a path strictly inside `root`. */
export function isPathInsideRoot(child: string, root: string): boolean {
  const c = path.resolve(child);
  const r = path.resolve(root);
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}
