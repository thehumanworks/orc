/**
 * Example orc workflow — a real 2-step smoke test of step-to-step handoff.
 *
 *   agi workflow run orc.workflows/example.ts            # stream step events
 *   agi workflow run orc.workflows/example.ts --json     # final WorkflowRun as JSON
 *
 * Step `a` (claude) writes a token to handoff.txt in the shared cwd; step `b` (codex)
 * reads that file and echoes the token back. Because the steps omit `cwd`, they share
 * the directory you invoke `agi workflow run` from — run it from a fresh/empty dir so
 * the handoff is unambiguous (b's transcript echoing the token proves b read a's file).
 *
 * NOTE ON THE IMPORT STORY: a WorkflowDef is just a PLAIN object `default`-exported, so
 * this file needs NO runtime import to run — `agi workflow run` imports it and the runner
 * validates the shape. The `import type` below is erased at runtime (it only gives an
 * editor the `satisfies WorkflowDef` check); an author who wants the `defineWorkflow`
 * helper may import it via a relative path, but it is never required.
 */
import type { WorkflowDef } from '../src/workflow.ts';

const TOKEN = 'ORC-HANDOFF-OK2476';

export default {
  name: 'example-handoff',
  steps: [
    {
      id: 'a',
      provider: 'claude',
      // Small inline prompt → sent verbatim (no file+pointer needed).
      prompt:
        `Create a file named handoff.txt in the current working directory whose ENTIRE ` +
        `contents are exactly this one line: ${TOKEN}\nThen stop. Do not print anything else.`,
      timeoutMs: 240_000,
      // The handoff is proven out-of-band (read b's transcript for the token); a yield is
      // enough to advance here. A production step should gate on a harder signal.
      done: ({ state }) => state === 'done',
    },
    {
      id: 'b',
      provider: 'codex',
      prompt:
        `Read the file handoff.txt in the current working directory and reply with its ` +
        `exact contents and nothing else.`,
      timeoutMs: 240_000,
      done: ({ state }) => state === 'done',
    },
  ],
} satisfies WorkflowDef;
