/**
 * Fan-out / fan-in review fleet example.
 *
 *   orc workflow run orc.workflows/fanout-review.ts --max-concurrency 3
 *
 * Steps:
 *   implement  →  review-a ─┐
 *              →  review-b ─┼→ merge-verdict
 *              →  review-c ─┘
 *
 * Independent reviewers run concurrently (when maxConcurrency > 1); the merge
 * step waits on all three via `needs`. Artifact inputs from implement are
 * auto-inferred as dependencies (explicit `needs` still recommended for clarity).
 * Set [models].pi = "openai/<model-id>" in ORC settings for OpenAI reviewers, and
 * authenticate using Pi /login openai or OPENAI_API_KEY on the execution host.
 */
import type { WorkflowDef } from '../src/workflow.ts';

export default {
  name: 'fanout-review',
  maxConcurrency: 3,
  steps: [
    {
      id: 'implement',
      provider: 'claude',
      worktree: true,
      prompt:
        'Implement the requested change. Run tests. Commit on this branch when done. ' +
        'Write a short SUMMARY.md describing what changed.',
      timeoutMs: 1_200_000,
      outputs: [{ name: 'summary', path: 'SUMMARY.md', required: false }],
      // Hard signal: worktree default is commitsAhead >= 1 when no verify/done.
    },
    {
      id: 'review-a',
      provider: 'pi',
      needs: ['implement'],
      cwd: '${implement.worktree}',
      prompt:
        'Review the branch diff for correctness bugs. Write findings to REVIEW_A.md. ' +
        'End with verdict: APPROVE or REQUEST_CHANGES.',
      timeoutMs: 600_000,
      allowUnverified: true,
    },
    {
      id: 'review-b',
      provider: 'claude',
      needs: ['implement'],
      cwd: '${implement.worktree}',
      prompt:
        'Review the branch diff for security and edge cases. Write findings to REVIEW_B.md. ' +
        'End with verdict: APPROVE or REQUEST_CHANGES.',
      timeoutMs: 600_000,
      allowUnverified: true,
    },
    {
      id: 'review-c',
      provider: 'pi',
      needs: ['implement'],
      cwd: '${implement.worktree}',
      prompt:
        'Review the branch diff for maintainability and tests. Write findings to REVIEW_C.md. ' +
        'End with verdict: APPROVE or REQUEST_CHANGES.',
      timeoutMs: 600_000,
      allowUnverified: true,
    },
    {
      id: 'merge-verdict',
      provider: 'pi',
      needs: ['review-a', 'review-b', 'review-c'],
      cwd: '${implement.worktree}',
      prompt:
        'Read REVIEW_A.md, REVIEW_B.md, and REVIEW_C.md. Synthesize a single VERDICT.md ' +
        'with overall APPROVE or REQUEST_CHANGES and a bullet list of blocking issues.',
      timeoutMs: 600_000,
      allowUnverified: true,
    },
  ],
} satisfies WorkflowDef;
