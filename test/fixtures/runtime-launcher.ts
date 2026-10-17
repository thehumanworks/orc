/**
 * Short-lived launcher used by the actor-kernel tests: performs one client call from a
 * separate process, prints the JSON result and exits immediately (the actor it spawned
 * must survive it).
 *
 *   bun runtime-launcher.ts create <spec.json>
 *   bun runtime-launcher.ts wake <sessionId>
 */
import fs from 'node:fs';
import { createSession, ensureAwake } from '../../src/runtime/client.ts';
import type { SpawnSpec } from '../../src/runtime/types.ts';

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'create' && arg) {
    const spec = JSON.parse(fs.readFileSync(arg, 'utf8')) as SpawnSpec;
    process.stdout.write(`${JSON.stringify(await createSession(spec))}\n`);
  } else if (mode === 'wake' && arg) {
    process.stdout.write(`${JSON.stringify(await ensureAwake(arg))}\n`);
  } else {
    throw new Error(`usage: runtime-launcher.ts create <spec.json> | wake <sessionId>`);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
