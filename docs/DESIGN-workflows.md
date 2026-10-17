# Design: orc workflows (goal-feature 2)

Status: **implemented** — phase 1 (runner), phase 2 (durable execution tree), phase 3 (portable
`verify` descriptors; function `done` predicates remain a local-only escape hatch) and phase 5 (DAG
scheduler). Since the actor runtime (`DESIGN-runtime.md`) steps settle on journal-derived state, not
pane heuristics.

Phase 2 durable execution tree (summary of implemented semantics):
- `schemaVersion` + monotonic `revision` with run-scoped lock and CAS writes (`src/runs.ts`)
- Validated JSON-safe plan + definition digest persisted **before** external side effects
- Per-step attempt phases: queued|spawning|dispatched|running|verifying|succeeded|failed|waiting|cancelled|abandoned
- Owner leases for foreground and detached runners; reconcile → orphaned on expired owner
- Resume / retry / cancel / cleanup CLI + daemon routes; adoption refuses silent duplicates
- Lineage via `ORC_*` env; `ExecutionPolicy` maxDepth/maxSessions/maxConcurrentSessions/deadlineMs/canDelegate
- Not exactly-once across process/filesystem boundaries; token/cost budgets not enforced
- `resume` / `retry` take the original workflow file (required by the local CLI; over `--host` the
  daemon falls back to the run's recorded source file); the plan digest must match

---

## Requirement (from the user's goal)
Workflows must be **easy to define**, **versioned**, **reliable**, and **backgroundable**. They are
the layer above the `agent` primitive that sequences multiple agents/steps to get real work done
(e.g. the research→plan→code→verify→retro loop, or fan-out across files).

## What we already know works
_(Historical: written before the actor runtime. The pane sentinel and idle heuristics below were
replaced by journal-derived `state()` / `waitFor()`; the lessons still hold.)_

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

A step = spawn an agent (provider, prompt or taskFile, worktree/cwd) → `waitFor` it to settle →
evaluate `done(ctx)` or its portable `verify`. `ctx` exposes `state`, `commitsAhead`, `capture` (the
last assistant text + final turn, from the journal), and prior step results (so steps can reference
`${implement.worktree}`). A failed/timed-out step stops new launches unless `continueOnFail`.

### Reliability
- Sequencing is built on `waitFor` (settles on journal-derived state), never ad-hoc polling.
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

### CLI surface (implemented)
```
orc workflow run <file> [--prompt TEXT] [--keep-sessions-on-error] [--detach] [--json] [--max-concurrency N]
orc workflow list [--json]
orc workflow status <runId> [--json]
orc workflow attach <runId> [--json]                  # follow a --detach run's runner.log
orc workflow logs <runId> [--step id] [--raw] [--json] # --raw: step sessions' journal tails
orc workflow resume <runId> <file> [--detach] [--json]
orc workflow retry <runId> [--step id] <file> [--detach] [--json]
orc workflow cancel <runId> [--cascade] [--json]
orc workflow cleanup <runId> [--sessions] [--worktrees] [--json]
```

Daemon mirrors control routes: `POST /workflows/runs/:id/{resume,retry,cancel,cleanup}`.

Workflow modules may export a factory `({ prompt }) => WorkflowDef` (sync or async) as well
as a plain object. Text supplied with `--prompt` is persisted privately and reused when loading
the original module for detached execution and recovery. The expanded plan remains the durable
definition checked on resume/retry. See the [research example](../orc.workflows/research.ts) and
[artifact input guide](../README.md#research-with-text-input-and-artifact-handoffs).

Failed runs clean up owned sessions by default while retaining logs, artifacts, and worktrees.
`keepSessionsOnError: true` on the workflow or `--keep-sessions-on-error` at launch retains the
sessions. The choice is part of the durable plan. Successful runs retain sessions for inspection.

## Open questions (later phases)
1. ~~Replace function `done` predicates with portable JSON-safe predicates (phase 3).~~ (portable `verify` shipped)
2. Worktree lifecycle across steps: shared branch vs one per step (currently per-step `worktree?`).
3. ~~DAG step dependencies~~ — **implemented (phase 5)**: see below.
4. Declarative YAML front-end (optional; scripted TS remains primary).

## DAG / fleet scheduler (phase 5)

### Contract
- Steps may declare `needs?: string[]` (JSON-portable hard dependencies).
- Workflow / run options accept positive integer `maxConcurrency` (CLI: `--max-concurrency N`,
  daemon body: `maxConcurrency`). **Absent ⇒ 1** — preserves strict array-order sequential
  execution and existing start/done event behavior.
- With `maxConcurrency > 1`, dependency-free steps may run concurrently; readiness is derived
  from `needs` (+ inferred artifact edges). Ready ties break by **definition order**.
- **Artifact dependency rule:** each `inputs[].fromStep` is **unioned into the effective
  dependency set** (explicit `needs` optional). Missing / self `fromStep` fail validation.
  Inferred edges are persisted on the durable plan `needs` and participate in the plan digest.
- Normalized `maxConcurrency` + effective `needs` are part of the plan/digest so resume/retry
  cannot silently change scheduling semantics.

### Scheduler
Pure module `src/workflow-scheduler.ts` derives ready / blocked / running / terminal from
attempt history. The runner uses a **bounded** launch loop (no unbounded `Promise.all`):
at most `min(maxConcurrency, policy.maxConcurrentSessions ?? ∞)` in flight; `queued`
attempts persist before launch; phase transitions persist as today.

### Failure / cancel / resume / retry
- A step whose required dependency terminally failed/cancelled/timed out/unverified becomes
  durably **`blocked`** (never launches).
- **`continueOnFail`:** when a step fails *without* it, stop **new** launches (including
  independent branches), wait for in-flight, mark remaining unfinished as **`skipped`**.
  When `continueOnFail` is true, independent branches continue; dependents stay blocked.
  At `maxConcurrency === 1` this preserves prior sequential stop/continue behavior.
- **Cancel** stops new launches immediately; in-flight owned sessions settle under existing
  cascade semantics (`cancel --cascade`).
- **Resume** skips verified successes; schedules only incomplete / unblocked nodes.
- **Retry** appends new attempt history for the selected failed/blocked node and its affected
  descendants (graph descendants; at concurrency 1 also the definition-order tail) without
  deleting prior attempts.

### Observability
List/get expose `maxConcurrency` + per-step scheduling state; plan prompts are not returned
on list/get projections.
