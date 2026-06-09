/**
 * Test fixture: resolve a codex transcript in a child process so HOME (and thus
 * os.homedir()) is honored. Prints the resolved path or 'null'.
 */
import { CodexAdapter } from '../../src/providers/codex.ts';
import type { SessionRecord } from '../../src/types.ts';

const recJson = process.argv[2];
if (!recJson) {
  process.stderr.write('missing record json arg\n');
  process.exit(1);
}
const rec = JSON.parse(recJson) as SessionRecord;
const adapter = new CodexAdapter();
const resolved = await adapter.resolveTranscript(rec);
process.stdout.write(resolved ?? 'null');
