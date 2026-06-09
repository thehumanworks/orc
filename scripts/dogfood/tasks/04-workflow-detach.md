# Task: backgroundable workflows — `--detach`, status reconcile, `agi workflow logs` (feature 2b)

## Context
Isolated git worktree of `orc`. First `bun install`, then read `README.md` ("Workflows" section),
`src/workflow.ts` (`runWorkflow`, `WorkflowRun`, `StepResult`, run record shape), `src/runs.ts`
(`writeRun`/`readRun`/`listRuns`), `src/paths.ts` (`runsDir`/`runPath`), `src/cli/index.ts`
(`cmdWorkflow*` — the `run|list|status` dispatch), `src/drivers/{driver,tmux}.ts` (the driver:
`spawn`/`isAlive`/`attachCommand`), and `src/session.ts` (`readParsed`/`capture`). Commit on THIS
branch; never `main`.

F2a built the foreground workflow runner. F2b makes a run **backgroundable** (it outlives the CLI
invocation), **reconcilable** (a crashed runner is detected, not stuck "running" forever), and
**inspectable** (read each step's work).

## Goal

### 1. `agi workflow run <file> --detach`
Run the workflow as a **detached, reattachable tmux session** (consistent with how orc runs agents —
reuse the `Driver`, do NOT nohup a bare process):
- Generate the `runId` up front. Spawn a driver session named `orc-wf-<runId>` whose argv runs the
  workflow **in the foreground inside that session**, e.g.
  `bun <abs path to src/cli/index.ts> workflow run <abs file> --run-id <runId>` with `cwd` = the
  current `agi` invocation cwd (so steps that share cwd behave identically to foreground).
- Write an initial `WorkflowRun` (status `running`, plus a new field `runnerTmux: 'orc-wf-<runId>'`)
  BEFORE returning, then print the `runId` (or `{runId, runnerTmux}` with `--json`) and exit 0
  immediately. The detached runner owns the record from there (it persists incrementally as in F2a).
- The runner session is reattachable: `agi workflow attach <runId>` prints the `tmux attach` command
  (reuse `driver.attachCommand`) so a human can watch the orchestration live.

### 2. `workflow run --run-id <id>` (internal, foreground)
`cmdWorkflowRun` accepts `--run-id <id>`; when present, `runWorkflow` uses it INSTEAD of generating one
(add `opts.runId` to `RunWorkflowOptions` and thread the `runnerTmux` value into the persisted run so
status can find the session). This is the entrypoint the detached session executes.

### 3. Status liveness reconciliation
`agi workflow status <runId>` (and `list`) must not trust a stale `running`. If a record says
`running` but its `runnerTmux` session is NOT alive (`driver.isAlive` false), report the run as
**`orphaned`** (add to the status union) — the runner died mid-run. Do this as a read-time reconcile:
return `orphaned` in the output, and persist that transition once observed (so it sticks). A record the
runner itself finalized (`done`/`failed`) is trusted as-is.

### 4. `agi workflow logs <runId> [--step <id>] [--raw]`
Read the actual work each step's agent did: load the run record, and for each `StepResult` (or just
`--step <id>`), build a `Session` from its `sessionId` and print its **token-efficient parsed
transcript** (reuse `session.readParsed()` / `renderTurns`), labeled `### step <id> (<provider>)`.
`--raw` uses the pane capture instead. `--json` emits `{ step, turns }[]`. (This is the per-step
inspection the F2a spec deferred to here.)

Add all new commands to `HELP_TEXT` and the README "Workflows" section.

## Constraints
- Bun + TypeScript, ESM, match style, NO new deps. `bun run typecheck` clean, `bun test` green.
- Unit-test the pure bits: the status-reconcile decision (given `{recordStatus, runnerAlive}` →
  effective status) as a pure function; the logs assembly given a fake run record + a fake transcript
  reader. Don't require a live session for the unit tests.

## Verification — REQUIRED, real CLIs (gates done)
Throwaway `ORC_HOME="$(mktemp -d)/orc"`. Use the existing `orc.workflows/example.ts` (2 real steps):
1. `agi workflow run <abs>/orc.workflows/example.ts --detach --json` from a fresh empty dir → returns a
   `runId` immediately (the command must NOT block for the whole run). Confirm `orc-wf-<runId>` is a
   live tmux session right after.
2. Poll `agi workflow status <runId> --json` until it reaches `done` (use a bounded loop). Then assert
   `agi workflow logs <runId> --step b` shows codex echoing step a's handoff token
   (`ORC-HANDOFF-OK<...>` — whatever the example uses).
3. Orphan test: start a detached run, then `tmux kill-session -t orc-wf-<runId>` while it is still
   `running`, and assert `agi workflow status <runId>` then reports `orphaned` (not stuck `running`).
4. Clean up: kill the workflow runner session + all step sessions, remove throwaway ORC_HOME, restore
   `~/.codex/config.toml` (drop temp trust entries, keep pre-existing). You run inside tmux; prefix
   nested spawns with `TMUX= ` if a nested session refuses to start.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
