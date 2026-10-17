# Task: orc workflows — core runner (feature 2a)

> **Completed** (the feature shipped). Kept as an example task spec for `scripts/dogfood/run.ts`.
> Written for the pre-actor runtime: tmux- and codex-CLI-specific steps were removed (codex is now
> orc's built-in harness); other details (e.g. the large-paste bug) are historical. Current
> behaviour: `README.md`, `docs/ARCHITECTURE.md`.

## Context
You are an autonomous coding agent in an **isolated git worktree** of `orc` — a tool that drives
coding agents (claude/codex/pi) as detached sessions, with an SDK + an `orc` CLI. First:
`bun install` (no node_modules in the worktree), then read `README.md`, `docs/DESIGN-workflows.md`
(the design you are implementing), `src/index.ts`, `src/session.ts` (note `state()`, `waitFor()`,
`readParsed()`), `src/agent.ts`, `src/state.ts` (`AgentState`), and `scripts/dogfood/run.ts` (a
hardcoded one-step proto-workflow — your runner GENERALIZES this). Commit on THIS branch; never `main`.

## Goal
A **workflow** sequences multiple agent steps reliably. Implement the CORE runner (foreground +
persisted run records). Backgrounding (`--detach`) and `logs` are a SEPARATE later task — do NOT build
them now, but don't preclude them (persist enough state that a status reader could be added later).

### SDK (`src/workflow.ts`)
```ts
export interface WorkflowStep {
  id: string;                       // unique within the workflow
  provider: Provider;
  taskFile?: string;                // path to a spec file (PREFERRED for long instructions)
  prompt?: string;                  // inline prompt (small only); exactly one of taskFile|prompt
  worktree?: boolean;               // default false
  cwd?: string;                     // may interpolate a prior step's field, e.g. '${implement.worktree}'
  timeoutMs?: number;               // per-step waitFor timeout (default 600000)
  done?: (ctx: StepDoneCtx) => boolean;  // explicit success predicate (see CRITICAL note below)
  continueOnFail?: boolean;         // default false → a failed step stops the run
}
export interface StepDoneCtx { state: AgentState; commitsAhead: number; capture: string; }
export interface WorkflowDef { name: string; steps: WorkflowStep[]; }
export function defineWorkflow(def: WorkflowDef): WorkflowDef;   // identity + validation (unique ids, one of taskFile|prompt)

export interface StepResult {
  id: string; sessionId: string; provider: Provider;
  state: AgentState; ok: boolean; worktree?: string; branch?: string; commitsAhead: number;
  unverified?: boolean;             // true when ok was inferred from a yield with NO real success signal
}
```

### CRITICAL — `done` must not equate "yielded" with "succeeded"
`state === 'done'` means the turn YIELDED (ready for input), NOT that the step succeeded — an agent
that asks a clarifying question and stops is indistinguishable from one that finished (this is a
documented F1 limitation; `waitFor` returns `done`, not `waiting`, for a question). If the runner
treated yield as success it would chain past a stalled step into garbage. So success evaluation is:
- `step.done` provided → `ok = step.done(ctx)`.
- else worktree step → default `ok = state === 'done' && commitsAhead >= 1` (the commit is the evidence).
- else (non-worktree, no predicate) → there is no universal success signal: set `ok = (state === 'done')`
  BUT also set `StepResult.unverified = true` and emit a loud warning event/log line. NEVER silently
  equate yield with success.
```
export interface WorkflowRun {
  id: string; name: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'done' | 'failed'; steps: StepResult[];
}
export async function runWorkflow(def: WorkflowDef, opts?: { onEvent?: (e: WorkflowEvent) => void }): Promise<WorkflowRun>;
```

### Runner behavior (this is the important part — be precise)
1. Generate a short run id. Create a `WorkflowRun` and persist it to `~/.orc/runs/<runId>.json`
   (respect `ORC_HOME`; write ATOMICALLY like the registry does), and re-persist after EVERY step
   transition so a crash leaves an inspectable record.
2. For each step IN ORDER:
   - Interpolate `cwd` (and any `${stepId.field}` references) from prior `StepResult`s.
   - Spawn the agent via `agent({...})`. Deliver instructions RELIABLY: if `prompt` is large
     (>~1KB) or `taskFile` is set, write/copy it to a file OUTSIDE any worktree and send a SHORT
     pointer (`agent({ ... })` then `session.send('Read <file> and do it.')`) — DO NOT pass a
     multi-KB string as the initial `prompt` (the `send()` verify-before-submit probe drops large
     pastes — this is a known bug; the harness shows the file+pointer workaround).
   - `await session.waitFor({ until: ['done','waiting','failed'], timeoutMs })` — RELIABILITY:
     sequencing MUST use `waitFor` (the journal-derived settle), never an ad-hoc sleep or poll.
   - Compute `commitsAhead` (`git -C <worktree> rev-list --count main..HEAD`) when a worktree exists.
   - Evaluate `done(ctx)` (default `state==='done'`). `ok = predicate`. Record the `StepResult`,
     re-persist the run.
   - If `!ok` and not `continueOnFail`: set run `status:'failed'`, stop. Otherwise continue.
   - Leave each step's session record intact (do NOT purge) so a later `logs` command can read its
     transcript; killing the session is fine (kill() persists the transcript path) but is OPTIONAL — for
     v1 you may leave sessions running. Document the choice.
3. Set `status:'done'` if all steps ok; `finishedAt`; final persist; return the run.

### CLI (`orc workflow <sub>`)
- `orc workflow run <file> [--json]` — import the file's default export (a `WorkflowDef`), run it,
  stream step events to stdout (or `--json` the final `WorkflowRun`). Exit non-zero if the run failed.
- `orc workflow list [--json]` — list persisted runs from `~/.orc/runs/`.
- `orc workflow status <runId> [--json]` — print a run record (per-step state).
- Add to `HELP_TEXT` and a README "Workflows" section. Wire `workflow` into the dispatcher in
  `src/cli/index.ts` (note: it has a sub-arg, like nothing else there yet — parse `argv[1]` as the
  workflow subcommand).

### Versioned workflow location + import story
Workflows are plain TS files the user commits. Import story (decide and document): a `WorkflowDef` is
just a **plain object** `default`-exported — `orc workflow run <file>` dynamically imports the file and
`runWorkflow` VALIDATES the shape, so the file needs NO import to work (`orc` is not a resolvable
package name; the bin is `orc`). `defineWorkflow` is an OPTIONAL typing helper the author may import
via a relative path for editor types; it must not be required. Add an example `orc.workflows/example.ts`
that `default`-exports a plain 2-step `WorkflowDef` (step `a` claude writes a unique token to a file in
a shared cwd, step `b` codex reads + echoes it) that actually runs, so `orc workflow run
orc.workflows/example.ts` is a real smoke test.

## Constraints
- Bun + TypeScript, ESM, match style, NO new deps. `bun run typecheck` clean, `bun test` green.
- Unit tests: the runner's pure bits — step ordering, `${...}` interpolation, done-predicate
  evaluation, run-status transitions — tested with a FAKE step executor (inject a function that
  returns canned `StepResult`s) so the runner logic is testable WITHOUT spawning real agents. Put the
  injectable seam in `runWorkflow` (e.g. an internal `opts.execStep` default that does the real spawn).

## Verification — REQUIRED, real CLIs (gates done)
Throwaway `ORC_HOME="$(mktemp -d)/orc"`. Run the real example workflow end-to-end:
1. `orc workflow run orc.workflows/example.ts --json` — assert both steps reach `ok:true`, run
   `status:"done"`, and that step `b`'s agent actually saw step `a`'s output (have `a` write a unique
   token to a file in a shared cwd and `b` read+echo it; check `b`'s transcript via `orc read`).
2. Assert the run record exists at `$ORC_HOME/runs/<id>.json` with both steps recorded.
3. Assert a deliberately-failing step (a `done` predicate that returns false) sets run `status:"failed"`
   and STOPS subsequent steps (plumbing check).
3b. **Reliability check (do NOT skip):** a WORKTREE step whose agent YIELDS WITHOUT producing the
   evidence — prompt it to "ask one clarifying question and then stop, do not make any changes or
   commits" — must, under the DEFAULT predicate (`state==='done' && commitsAhead>=1`), be reported
   `ok:false` (because `commitsAhead===0`), NOT chained past. This proves the runner catches a real
   yielded-but-didn't-succeed step, not just an artificial false predicate. Also verify a non-worktree
   yield-only step is flagged `unverified:true`.
4. Clean up: kill any sessions you spawned, remove throwaway ORC_HOME.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
