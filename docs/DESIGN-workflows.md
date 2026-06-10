# Design: orc workflows (goal-feature 2)

Status: DRAFT — depends on the `wait`/state primitive (goal-feature 1, in progress). API specifics
marked _(pending F1)_ will be pinned once `Session.waitFor()` / `orc wait` land.

## Requirement (from the user's goal)
Workflows must be **easy to define**, **versioned**, **reliable**, and **backgroundable**. They are
the layer above the `agent` primitive that sequences multiple agents/steps to get real work done
(e.g. the research→plan→code→verify→retro loop, or fan-out across files).

## What we already know works
`scripts/dogfood/run.ts` is, in effect, a hardcoded **one-step workflow**: spawn an agent in a
worktree → deliver a versioned task file → watch until it _settles_ → report the branch diff. It has
already driven two real features to merge. Feature 2 generalizes this proven pattern into a reusable,
multi-step runner. The lessons it encodes are requirements:
- **Completion must be a hard signal, not a string match** — the watcher gates "done" on a real
  branch commit + a pane sentinel, because the prompt itself echoes any sentinel string. Workflow
  step-completion needs the same rigor (see Reliability).
- **Stalls must surface** — idle-detection (the working indicator vanishing) wakes the operator
  instead of blocking for the full timeout. Once F1 lands, this becomes `state() === 'waiting'|'done'`
  instead of a pane heuristic.
- **Large prompts can't be pasted** — deliver task specs as files + a short pointer (the `send()`
  multi-KB bug). Workflows should deliver step instructions the same way.

## Design

### Definition format — scripted-first (recommended)
A workflow is a **versioned TypeScript module** under `orc.workflows/` (committed to the repo),
authored against the orc SDK. Rationale: the consumers are AI agents (TS is easy for them to emit);
the harness already proves the ergonomics; loops/branches/fan-out need real control flow that a
declarative schema would constrain; "versioned" is just "it's a file in git." A declarative
(YAML/JSON) front-end can be added later for the common linear case, compiling to the same runner —
but it is NOT needed for v1.

```ts
// orc.workflows/feature.ts
import { defineWorkflow } from 'orc/workflow';
export default defineWorkflow({
  name: 'feature',
  steps: [
    { id: 'implement', provider: 'claude', worktree: true, taskFile: 'tasks/NN.md',
      // step succeeds when the agent settles AND its branch has a new commit:
      done: ({ state, commitsAhead }) => state === 'done' && commitsAhead >= 1 },
    { id: 'review',    provider: 'codex',  cwd: '${implement.worktree}',
      prompt: 'Review the diff on this branch for correctness; write findings to REVIEW.md',
      done: ({ state }) => state === 'done' },
  ],
});
```

A step = spawn an agent (provider, prompt or taskFile, worktree/cwd) → `waitFor` it to settle _(pending
F1)_ → evaluate its `done(ctx)` predicate. `ctx` exposes `state`, `commitsAhead`, captured output, and
prior step results (so steps can reference `${implement.worktree}`). A failed/timed-out step stops the
workflow (or a `onFail` branch).

### Reliability
- Sequencing is built on F1's `waitFor` (debounced settle detection), NOT ad-hoc pane polling.
- A step's success is an explicit predicate over a **hard signal** (a commit, a written file, an
  exit), never a substring of the agent's own narration.
- Every step has a timeout; a workflow records per-step state transitions to `~/.orc` so a crash is
  recoverable/inspectable.

### Backgroundable
`orc workflow run <name> [--detach]`. Foreground streams step progress. `--detach` runs it as a
tracked background process whose live state is queryable (`orc workflow status <run-id>`,
`orc workflow logs <run-id>`) — the run record lives in `~/.orc/runs/<id>.json`. This is the natural
bridge to goal-feature 3 (the daemon): a detached workflow run is exactly what a remote orc server
would host and expose.

### CLI surface (proposed)
```
orc workflow list                       # versioned workflows discovered in orc.workflows/
orc workflow run <name> [--detach]      # run; --json streams step events
orc workflow status <run-id>            # state of each step
orc workflow logs <run-id> [--step s]   # per-step transcript (token-efficient `read`, reused)
```

## Open questions (resolve after F1)
1. Exact `waitFor`/`state` API shape to bind steps to _(pending F1)_.
2. Worktree lifecycle across steps: does a multi-step workflow share ONE worktree/branch (review the
   same diff) or one per step? Likely: a workflow owns a branch; steps share its worktree by default,
   opt into their own.
3. Step-to-step handoff of large context — reuse the file-drop + pointer pattern.
4. Do we need declarative YAML in v1, or is scripted enough? (Recommendation: scripted only for v1.)
