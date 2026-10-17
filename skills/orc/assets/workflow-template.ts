/**
 * Workflow template — copy into `orc.workflows/<name>.ts`, edit, then run:
 *   orc workflow run orc.workflows/<name>.ts            # foreground, streams step events
 *   orc workflow run orc.workflows/<name>.ts --detach   # background, returns a runId
 *   orc workflow logs <runId> [--step <id>]             # inspect each step's work
 *
 * A `WorkflowDef` is a PLAIN object default-exported — no import is required at runtime (the runner
 * validates the shape). The `import type` below is erased at runtime; it only gives your editor types.
 *
 * This example encodes the principles from the orc skill: provider diversity (implement with one
 * model, review with another), hard-signal success (a step "succeeds" only when it produced real
 * evidence — a commit — not merely because the turn yielded), and step-to-step handoff via a shared
 * worktree.
 */
import type { WorkflowDef } from '../src/workflow.ts'; // adjust path, or delete (type-only)

export default {
  name: 'implement-then-review',
  // Absent maxConcurrency ⇒ 1 (strict sequential). Use >1 with needs[] for fan-out fleets
  // (see orc.workflows/fanout-review.ts). CLI: --max-concurrency N
  maxConcurrency: 1,
  steps: [
    {
      id: 'implement',
      provider: 'claude',
      alias: 'implementer',
      worktree: true, // isolated checkout + branch; clean up after merging
      // For a long spec, prefer a file + short pointer over a multi-KB inline prompt:
      //   taskFile: '/abs/path/to/spec.md',
      prompt: 'Implement <the task>. Run the tests. Commit your work on this branch when done.',
      timeoutMs: 1_200_000,
      // SUCCESS = a real signal, not just a yielded turn. A worktree step defaults to
      // `state === 'done' && commitsAhead >= 1`; make it explicit when you want more:
      done: ({ state, commitsAhead }) => state === 'done' && commitsAhead >= 1,
    },
    {
      id: 'review',
      provider: 'codex', // a DIFFERENT provider reviews — diversity catches more
      alias: 'reviewer',
      needs: ['implement'], // explicit dep (also inferred from artifact inputs[].fromStep)
      cwd: '${implement.worktree}', // run in the implementer's worktree to see its diff
      prompt:
        'Adversarially review the diff on this branch for correctness and edge cases. ' +
        'Give a clear verdict and list any issues as your final message.',
      timeoutMs: 600_000,
      // NOTE: `commitsAhead` is only computed for a step that creates its OWN `--worktree`; a step
      // that REUSES another step's worktree via `cwd` (like this one) always sees 0. So gate a
      // review on `state === 'done'` (a soft gate) and read its verdict yourself:
      //   orc workflow logs <runId> --step review
      done: ({ state }) => state === 'done',
    },
  ],
} satisfies WorkflowDef;

// CLEANUP: failed runs stop owned sessions by default, preserving logs and worktrees.
// Use keepSessionsOnError: true or --keep-sessions-on-error to retain failed sessions.
// Successful runs retain their sessions. When you're done:
//   orc workflow status <runId> --json     # → each step's `sessionId`
//   orc kill <sessionId> --worktree --purge # per step (removes the worktree + record)
// then merge or delete the branch yourself. Don't leave sessions/worktrees lying around.
