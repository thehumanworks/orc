import { removeRecord, upsertRecord } from '../../src/registry.ts';
import type { SessionRecord } from '../../src/types.ts';

const [op, payload] = process.argv.slice(2);

if (op === 'upsert' && payload) {
  await upsertRecord(JSON.parse(payload) as SessionRecord);
} else if (op === 'remove' && payload) {
  await removeRecord(payload);
} else {
  process.stderr.write('usage: registry-worker.ts <upsert JSON|remove ID>\n');
  process.exit(1);
}
