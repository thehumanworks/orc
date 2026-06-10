# orc / `orc`

`orc` is a multi-agent orchestration tool. Its core primitive, `agent()`, launches a coding-agent
CLI (`claude`, `codex`, or `pi`) as an **interactive TUI** inside a **detached, reattachable,
readable** tmux session — optionally in a fresh git worktree, in yolo mode by default. Subagent
sessions outlive the parent and can be reattached or inspected by a human at any time. Work is never
opaque.

Ships as a TypeScript SDK (Bun, ESM) and a CLI, `orc`. Both surfaces are scriptable and
`--json`-capable, since they're mostly consumed by other AI agents.

See `docs/ARCHITECTURE.md` and `docs/RESEARCH.md` for the full design and the verified primitives
behind every decision.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [tmux](https://github.com/tmux/tmux) (3.x)
- At least one provider CLI on `PATH`: `claude`, `codex`, and/or `pi`
- `git` (only needed for `--worktree`)

## Install

```sh
bun install
```

To use `orc` globally, link it (`bun link`) or run it directly:

```sh
bun run src/cli/index.ts <command> ...
# or, after `bun link`:
orc <command> ...
```

## CLI

```
orc spawn  --provider <claude|codex|pi> [options]   Launch a new agent session (aliases: agent, new)
orc send   <id|@alias> [PROMPT | - | @file]         Send a prompt (multi-line safe)
orc read   <id|@alias> [--last|--index N|--full|--raw]  Latest parsed turn by default; --full = full transcript; --raw = full tmux pane
orc state  <id|@alias>                              Classify state once: starting|running|done|waiting|failed
orc wait   <id|@alias> [--for done|waiting|failed|settled] [--timeout <sec>]
                                                    Block until the agent settles (default --for settled)
orc list   [--workspace W | --all | --dead]         List sessions for a workspace (alias: ps)
orc attach <id|@alias> [--read-only]                Attach to the tmux session
orc kill   <id|@alias> [--worktree] [--purge]       Kill the session (mark dead; --purge removes record)
orc prune  [--worktree]                             Drop marked-dead/gone records (+ optionally their worktrees)
orc workflow run|list|status|logs|attach …          Run/inspect multi-step workflows (see Workflows)
orc daemon [--port P] [--bind IP] [--insecure]      Serve the HTTP API over tailscale (see Daemon)
orc remote add|list|rm <host>                       Manage trusted peer hosts (~/.orc/peers.json)
orc help
```

Every command accepts `--json`. On failure the process exits non-zero and, with `--json`, prints
`{"error": "..."}`. `orc list --json` returns an array of records each with a live `status` field;
`orc spawn --json` prints the new record so a caller can immediately `orc send <id>`. Any command can
be targeted at another host with `orc --host <h> <command>` (see Daemon).

### spawn options

| flag | meaning |
| --- | --- |
| `--provider, -p` | `claude` \| `codex` \| `pi` (required) |
| `--model, -m` | model name |
| `--agent <name>` | named agent definition (mutually exclusive with `--system-prompt`) |
| `--alias <name>` | workspace-scoped session handle; does not affect agent behavior |
| `--system-prompt <txt>` | system prompt text |
| `--system-prompt-mode` | `append` (default) \| `replace` |
| `--prompt <txt \| ->` | initial prompt sent after boot (`-` reads stdin) |
| `--cwd <dir>` | base working directory (default: cwd) |
| `--workspace <w>` | logical workspace key |
| `--worktree` | create a fresh git worktree and use it as cwd |
| `--branch <b>` | worktree branch name |
| `--no-wait` | return immediately; skip the boot wait **and** the initial-prompt send |

If `--worktree` is used and spawn fails before the agent boots (driver error, provider prep, etc.),
orc removes the new worktree and drops the registry record so nothing is left behind.

### Examples

```sh
# Launch a claude session and send it a prompt once it boots.
orc spawn --provider claude --prompt "summarize the repo in 3 bullets"

# Same, machine-readable, capture the id.
ID=$(orc spawn -p claude --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)')

# Send a multi-line prompt from a file (delivered as ONE message).
orc send "$ID" @prompt.txt

# Give a session an orchestrator-only alias and address it from the same workspace.
orc spawn -p codex --alias codex-debugger --prompt "inspect the failing test"
orc read @codex-debugger

# From another workspace, qualify the alias with the workspace name.
orc send @orc:codex-debugger "focus on the registry lookup path"

# Read the latest token-efficient parsed conversation turn.
orc read "$ID"
# Read the full parsed transcript or a zero-based conversation turn.
orc read "$ID" --full
orc read "$ID" --index 0
# Escape hatch: read the full tmux pane.
orc read "$ID" --raw

# Reattach as a human (read-only view).
orc attach "$ID" --read-only

# Tear down.
orc kill "$ID" --worktree
```

## SDK

```ts
import { agent, listSessions, getSession } from 'orc';

const session = await agent({
  provider: 'claude',
  prompt: 'reply with the single word READY',
});

console.log(session.id, session.tmuxName, await session.status());
console.log(await session.capture());          // live pane
console.log(await session.readTranscript());   // raw on-disk JSONL
console.log(await session.readParsed());        // token-efficient parsed turns (Turn[])

await session.send('now do the next thing');    // multi-line safe

console.log(await session.state());             // 'starting'|'running'|'done'|'waiting'|'failed'
const settled = await session.waitFor();        // blocks until done/waiting/failed (debounced)
await session.waitFor({ until: ['done'], timeoutMs: 120_000, pollMs: 1000 });

const all = await listSessions({ all: true });
await session.kill({ removeWorktree: true });
```

### Provider notes

- **claude** — native `--agent <name>`; `--append-system-prompt` (append, default) or
  `--system-prompt` (replace). Transcript resolved by globbing the session id.
  **Note:** an orc-launched *interactive* claude session DOES write its real
  `user`/`assistant` turns to `~/.claude/projects/*/<sid>.jsonl` as the conversation
  progresses (verified against claude 2.1.170). So parsed `orc read` reads the actual
  conversation from disk; `orc read --raw` is the live-pane escape hatch.
  (An earlier note claimed the file was title-only — that was wrong.)
- **codex** — no launch-time `--agent` flag and no `--session-id`. A persona/system prompt (or a
  resolved `agentName` body) is written to `AGENTS.md` in the cwd when that file does **not** already
  exist; orc **refuses to overwrite** an existing `AGENTS.md` (use another cwd or remove the file).
  Transcript discovered by matching the rollout file's `cwd` with an mtime guard.
- **pi** — `--append-system-prompt` (or `--system-prompt`); `--session-id` + `--session-dir`.
  Transcript resolved by globbing the session id.

`agentName` resolution is provider-aware, preferring each provider's **own** local/user-scoped store:

| provider | resolution order |
| --- | --- |
| claude | native `--agent <name>` (project `.claude/agents/` → user `~/.claude/agents/`) |
| codex  | project `.codex/agents/*.toml` (matched by `name`) → user `$CODEX_HOME/agents/*.toml` → project `.codex/prompts/<name>.md` → user `$CODEX_HOME/prompts/<name>.md` → `.claude/agents/<name>.md` → `~/.claude/agents/<name>.md` |
| pi     | project `.claude/agents/<name>.md` → user `~/.claude/agents/<name>.md` |

For codex/pi the resolved body becomes the injected system prompt (codex TOML uses
`developer_instructions`; markdown uses the file body; codex → `AGENTS.md`; pi →
`--append-system-prompt`). If a Codex TOML agent supplies `model`, orc uses it only when
`--model` was omitted. A bare `agentName` with no resolvable definition throws a clear error
listing the locations searched. `agentName` and `systemPrompt` are mutually exclusive.

First-run workspace-trust dialogs (claude/codex) are auto-confirmed with `Enter` at boot — `orc`
never mutates your CLI config. The boot loop only auto-confirms the trust dialog; any other
interstitial (e.g. codex's "Update available" banner, whose default is a self-update) is dismissed
with `Escape` and never accepted.

`orc kill` keeps the session record (marked dead) so `orc read` still resolves the transcript after a
kill — the transcript path is resolved and persisted at kill time. Dead records are hidden from
`orc list` by default (`--dead`/`--all` to show them). Use `orc kill <id> --purge` to remove a single
record, or `orc prune` to drop records that are either marked dead or whose tmux session is gone.

## Agent state & `wait`

`orc state <id>` classifies an interactive session in one shot (driver liveness + a single pane
capture); `orc wait <id>` blocks until it settles. Both are built on `Session.state()` /
`Session.waitFor()` in the SDK. The five states are the foundation for orchestration, so their
meanings are precise and load-bearing:

| state | meaning |
| --- | --- |
| `starting` | booted but not yet showing a ready composer (transient) |
| `running` | the assistant is actively working — a turn is in progress |
| `done` | the turn YIELDED: the composer is idle and ready for input |
| `waiting` | blocked on a TUI **modal** (trust dialog, approval/permission, update interstitial) |
| `failed` | the process/pane is no longer alive |

Two nuances matter:

- **`done` means "ready for YOUR input," not "succeeded."** It covers both "finished the task" and
  "asked a clarifying question and is waiting for your reply." For claude/codex in yolo mode those two
  are **pane-indistinguishable** (both render as the idle composer with no working indicator), so a
  conversational question is reported as `done`, **not** `waiting`. `waiting` is reserved for actual
  TUI modals that need a keypress.
- **`failed` means "terminated," not "errored."** A crash and a clean `/exit` both just leave the pane
  gone, and those are not pane-distinguishable, so `failed` carries no success/failure judgement.

`orc wait` polls `state()` (~1s) until it reaches a state in the requested set, **debounced**: a
non-progressing state must hold for **2 consecutive polls** before it's returned, so a sub-second gap
between an agent's tool calls is never misread as end-of-turn. `--for` selects the target set
(`done` | `waiting` | `failed` | `settled`, where `settled` = any of the three; default `settled`).
On timeout it returns the last observed state (it does not throw); exit code is `0` iff the reached
state actually settled after debounce, non-zero on timeout.

```sh
orc wait "$ID" --json                       # {"id","state","elapsedMs","timedOut"}
orc wait "$ID" --for done --timeout 120      # block up to 120s for the turn to yield
orc state "$ID" --json                       # {"id","state"} — point-in-time, no blocking
```

## Workflows

A **workflow** sequences multiple agent steps reliably — the layer above `agent()` that runs, say,
`implement → review`. A workflow is a plain TypeScript file you commit (versioned under
`orc.workflows/`); the core runner executes it and persists a run record to
`~/.orc/runs/<runId>.json` after every step transition, so a crash leaves an inspectable record. A
run can be **foreground** or **backgrounded** (`--detach`), is **reconcilable** (a crashed runner is
detected, not stuck `running`), and is **inspectable** per step (`orc workflow logs`).

```sh
orc workflow run <file> [--detach] [--json]       # run a WorkflowDef; --detach backgrounds it
orc workflow list [--json]                         # list persisted runs from ~/.orc/runs/ (newest first)
orc workflow status <runId> [--json]               # print a run record (per-step state)
orc workflow attach <runId> [--read-only]          # print the tmux attach command for a --detach runner
orc workflow logs <runId> [--step <id>] [--raw]    # per-step transcript of the work each agent did
```

`orc workflow run` streams step events to stdout (`--json` prints only the final `WorkflowRun`) and
**exits non-zero if the run failed**. There's a runnable example — a 2-step handoff where claude
writes a token to a file and codex reads it back:

```sh
orc workflow run orc.workflows/example.ts --json
```

### Backgrounding — `--detach`, attach, reconcile

`--detach` runs the workflow as a **detached, reattachable tmux session** named `orc-wf-<runId>`
(consistent with how orc runs agents — it reuses the `Driver`, it does **not** nohup a bare process).
The runId is minted up front and an initial `running` record is written before the command returns,
so `orc workflow run --detach` prints the `runId` (or `{runId, runnerTmux}` with `--json`) and exits
**0 immediately** — the detached runner owns the record from there and persists it incrementally just
like a foreground run. Steps run with the **same cwd** as your `orc` invocation, so a `--detach` run
behaves identically to foreground.

```sh
RUN=$(orc workflow run orc.workflows/example.ts --detach --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).runId)')
eval "$(orc workflow attach "$RUN")"     # reattach to watch the orchestration live
orc workflow status "$RUN" --json        # poll until status reaches done|failed|orphaned
```

**Liveness reconcile.** `status` (and `list`) never trust a stale `running`: if a record still says
`running` but its `runnerTmux` session is no longer alive, the runner died mid-run and the run is
reported **`orphaned`** (the new fifth status). This is a read-time reconcile — the verdict is
persisted once observed so it sticks. A record the runner itself finalized (`done`/`failed`) is
trusted as-is. (Internally, `--detach` launches `orc workflow run <file> --run-id <runId>` in the
foreground inside the tmux session; that `--run-id` entrypoint is how both sides agree on the record.)

### Inspecting the work — `orc workflow logs`

Workflow steps leave their sessions **alive** (the v1 choice), so you can read exactly what each
step's agent did. `orc workflow logs <runId>` prints every step's full **token-efficient parsed
transcript** (the same parsed format as `orc read --full`), labeled `### step <id> (<provider>)`; `--step <id>`
narrows to one step, `--raw` shows the live pane capture instead, and `--json` emits
`{ step, turns }[]` (or `{ step, provider, pane }[]` with `--raw`).

```sh
orc workflow logs "$RUN"               # all steps, parsed
orc workflow logs "$RUN" --step b      # just step b — e.g. to see codex echo step a's handoff token
orc workflow logs "$RUN" --step b --raw
```

### Defining a workflow

A workflow file `default`-exports a **plain object** `{ name, steps[] }`. No import is required for it
to run — `orc workflow run` imports the file and the runner validates the shape. (`orc` is not a
resolvable package name; the bin is `orc`.) The optional `defineWorkflow` helper — or just
`satisfies WorkflowDef` with a type-only import via a relative path — gives an editor types without
adding a runtime dependency.

```ts
// orc.workflows/feature.ts
import type { WorkflowDef } from '../src/workflow.ts'; // type-only: erased at runtime
export default {
  name: 'feature',
  steps: [
    { id: 'implement', provider: 'claude', worktree: true, taskFile: 'tasks/01.md',
      // a worktree step succeeds only when it YIELDS *and* its branch has a new commit:
      done: ({ state, commitsAhead }) => state === 'done' && commitsAhead >= 1 },
    { id: 'review', provider: 'codex', cwd: '${implement.worktree}',
      prompt: 'Review the diff on this branch; write findings to REVIEW.md',
      done: ({ state }) => state === 'done' },
  ],
} satisfies WorkflowDef;
```

Each step spawns an agent (`provider`, `prompt` or `taskFile`, optional `alias`/`worktree`/`cwd`),
waits for it to settle via the debounced `Session.waitFor`, then evaluates its `done(ctx)` predicate.
A step's `cwd` (and `prompt`/`taskFile`) may interpolate a prior step's result field with
`${stepId.field}` — e.g. `${implement.worktree}` to review the diff in the implementer's worktree.

| step field | meaning |
| --- | --- |
| `id` | unique within the workflow; the key for `${id.field}` interpolation |
| `provider` | `claude` \| `codex` \| `pi` |
| `alias` | optional active-session alias for the spawned step agent |
| `taskFile` / `prompt` | exactly one; long specs use `taskFile` (delivered as a file + pointer) |
| `worktree` | create a fresh git worktree for this step (default false) |
| `cwd` | working dir; may interpolate `${stepId.field}` |
| `timeoutMs` | per-step `waitFor` timeout (default 600000) |
| `done(ctx)` | success predicate over `{ state, commitsAhead, capture }` |
| `continueOnFail` | default false → a failed step stops the run |

**Run ids.** Minted ids and optional `orc workflow run … --run-id <id>` must be non-empty, at most
128 characters, and use only letters, digits, hyphen, and underscore (no path separators). Invalid
ids are rejected before writing under `~/.orc/runs/` or naming `orc-wf-<runId>`.

**Per-step timeout.** When a step's `waitFor` hits `timeoutMs` without debounced settle, the step is
**failed** (`ok: false`) even if the last observed pane state was `done` — a timeout is not treated
as unverified success.

### Reliability — a yield is **not** success

`state === 'done'` means the turn **yielded** (ready for input), not that it succeeded: an agent that
asks a clarifying question and stops is pane-indistinguishable from one that finished. So the runner
**never** equates a yield with success:

- `done` predicate provided → `ok = done(ctx)` (your call, over a hard signal).
- else **worktree** step → `ok = state === 'done' && commitsAhead >= 1` (the commit is the evidence).
- else (no predicate, no worktree) → `ok = state === 'done'`, but the step is flagged **`unverified`**
  and the runner emits a loud warning — there's no universal success signal, so add a `done` predicate.

Step instructions are delivered reliably: a `taskFile` or a large inline `prompt` (>~1KB) is written to
a file under `~/.orc/runs/<runId>/` (outside any worktree, so the agent can't commit it) and the agent
gets a short "read this file" pointer — working around the `send()` large-paste bug. **Sessions are left
alive** after a workflow finishes (v1 choice) so you can `orc attach`/`orc read` them and
`orc workflow logs` can read their transcripts; tear them down with `orc kill` when done.

## Daemon & remote hosts

`orc` can drive agents and workflows on **other hosts** over your [tailscale](https://tailscale.com)
network. Each host runs a daemon; one machine can then manage the whole fleet.

```sh
# On a host: serve the HTTP API. Binds to THIS host's tailscale IP by default.
orc daemon                      # bind = tailscale IP (refuses 0.0.0.0 without --insecure)
orc daemon --bind 127.0.0.1     # local testing

# From a client: trust a peer, then target it with --host.
orc remote add mini             # add a trusted tailnet host to ~/.orc/peers.json
orc --host mini spawn -p claude --prompt "summarize this repo"
orc --host mini wait <id> && orc --host mini read <id>
orc list --all-hosts            # fleet view across local + trusted peers
```

The daemon is a thin JSON/HTTP layer over the SDK (`/sessions`, `/sessions/:id/{read,send,wait,kill}`,
`/workflows/*`), so a remote agent's lifecycle is identical to a local one. Malformed requests (e.g.
`POST /sessions` without a valid `provider`, invalid `for` on wait, bad workflow `file`) return
**HTTP 400** with `{"error":"…"}` — the same validation messages the local CLI would print.

**Security.** The daemon binds to the host's **tailscale interface only** (a `100.x` WireGuard
address the tailnet won't route from off-net); it **refuses** to bind a public/LAN address without an
explicit `--insecure`. Every route except `/health` goes through a **fail-closed** trust gate: a
request is allowed only if `tailscale whois` resolves its source to an **allowlisted** peer
(`orc remote add`) **or** it presents `x-orc-secret` equal to `$ORC_DAEMON_SECRET` — anything else is
`403`. (The whois path needs a real two-host tailnet to exercise; the loopback test suite covers the
secret path, the deny path, and bind-refusal.)

## Workspaces

A session is filed under a **workspace** key, and `orc list` (no flags) shows only the sessions for
the current directory's workspace. The key is resolved the same way at spawn time and at list time:

- explicit `--workspace <W>` if given (realpath-normalized when it's a real path), else
- **the git toplevel** of the directory — so a repo and all of its subdirectories share one
  workspace, else
- the directory's exact realpath, when it isn't in a git repo (no nesting — sibling/parent/child
  dirs are distinct workspaces).

A `--worktree` session belongs to its **parent repo's** workspace (a worktree can't exist without a
git parent, and that parent is the project home), so worktree agents are visible from `orc list` run
at the repo root. Use `orc list --workspace <W>` to target another workspace, or `--all` to ignore
the workspace filter entirely.

Aliases are scoped to this workspace key. `--alias debugger` creates an active-session handle
addressable as `@debugger` inside the same workspace and as `@orc:debugger` from outside a workspace
whose display name is `orc` (the basename of the workspace path, or the logical workspace string).
Aliases are not agent definitions and do not change the system prompt, model, worktree label, or
provider behavior. A second active session in the same workspace cannot reuse an alias; once the old
session is killed, gone, or pruned, the alias is available again. Retained dead transcript records
remain addressable by id.

## State

All state lives under `~/.orc` (override with `ORC_HOME`):

```
~/.orc/registry.json            # array of SessionRecord, written atomically
~/.orc/transcripts/pi/<sid>/    # per-session pi transcript dirs
```

## Development

```sh
bun test            # unit tests (pure logic)
bun run typecheck   # tsc --noEmit
```
