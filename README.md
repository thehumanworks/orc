# orc / `agi`

`orc` is a multi-agent orchestration tool. Its core primitive, `agent()`, launches a coding-agent
CLI (`claude`, `codex`, or `pi`) as an **interactive TUI** inside a **detached, reattachable,
readable** tmux session — optionally in a fresh git worktree, in yolo mode by default. Subagent
sessions outlive the parent and can be reattached or inspected by a human at any time. Work is never
opaque.

Ships as a TypeScript SDK (Bun, ESM) and a CLI, `agi`. Both surfaces are scriptable and
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

To use `agi` globally, link it (`bun link`) or run it directly:

```sh
bun run src/cli/index.ts <command> ...
# or, after `bun link`:
agi <command> ...
```

## CLI

```
agi spawn  --provider <claude|codex|pi> [options]   Launch a new agent session (aliases: agent, new)
agi send   <id|name> [PROMPT | - | @file]           Send a prompt (multi-line safe)
agi read   <id|name> [--raw]                        Parsed transcript (default); --raw = full tmux pane
agi state  <id|name>                                Classify state once: starting|running|done|waiting|failed
agi wait   <id|name> [--for done|waiting|failed|settled] [--timeout <sec>]
                                                    Block until the agent settles (default --for settled)
agi list   [--workspace W | --all | --dead]         List sessions for a workspace (alias: ps)
agi attach <id|name> [--read-only]                  Print the `tmux attach` command (does not exec)
agi kill   <id|name> [--worktree] [--purge]         Kill the session (mark dead; --purge removes record)
agi prune  [--worktree]                             Drop all dead records (+ optionally their worktrees)
agi help
```

Every command accepts `--json`. On failure the process exits non-zero and, with `--json`, prints
`{"error": "..."}`. `agi list --json` returns an array of records each with a live `status` field;
`agi spawn --json` prints the new record so a caller can immediately `agi send <id>`.

### spawn options

| flag | meaning |
| --- | --- |
| `--provider, -p` | `claude` \| `codex` \| `pi` (required) |
| `--model, -m` | model name |
| `--agent <name>` | named agent definition (mutually exclusive with `--system-prompt`) |
| `--system-prompt <txt>` | system prompt text |
| `--system-prompt-mode` | `append` (default) \| `replace` |
| `--prompt <txt \| ->` | initial prompt sent after boot (`-` reads stdin) |
| `--cwd <dir>` | base working directory (default: cwd) |
| `--workspace <w>` | logical workspace key |
| `--worktree` | create a fresh git worktree and use it as cwd |
| `--branch <b>` | worktree branch name |
| `--no-wait` | return immediately; skip the boot wait **and** the initial-prompt send |

### Examples

```sh
# Launch a claude session and send it a prompt once it boots.
agi spawn --provider claude --prompt "summarize the repo in 3 bullets"

# Same, machine-readable, capture the id.
ID=$(agi spawn -p claude --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)')

# Send a multi-line prompt from a file (delivered as ONE message).
agi send "$ID" @prompt.txt

# Read the token-efficient parsed transcript; --raw for the full tmux pane.
agi read "$ID"
agi read "$ID" --raw

# Reattach as a human (read-only view).
eval "$(agi attach "$ID" --read-only)"

# Tear down.
agi kill "$ID" --worktree
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
  progresses (verified against claude 2.1.170). So the default parsed `agi read` reads
  the actual conversation from disk; `agi read --raw` is the live-pane escape hatch.
  (An earlier note claimed the file was title-only — that was wrong.)
- **codex** — no launch-time `--agent` flag and no `--session-id`. A persona/system prompt (or a
  resolved `agentName` body) is written to `AGENTS.md` in the cwd. Transcript discovered by matching
  the rollout file's `cwd` with an mtime guard.
- **pi** — `--append-system-prompt` (or `--system-prompt`); `--session-id` + `--session-dir`.
  Transcript resolved by globbing the session id.

`agentName` resolution is provider-aware, preferring each provider's **own** local/user-scoped store:

| provider | resolution order |
| --- | --- |
| claude | native `--agent <name>` (project `.claude/agents/` → user `~/.claude/agents/`) |
| codex  | project `.codex/prompts/<name>.md` → user `$CODEX_HOME/prompts/<name>.md` → `.claude/agents/<name>.md` → `~/.claude/agents/<name>.md` |
| pi     | project `.claude/agents/<name>.md` → user `~/.claude/agents/<name>.md` |

For codex/pi the resolved markdown body becomes the injected system prompt (codex → `AGENTS.md`;
pi → `--append-system-prompt`). A bare `agentName` with no resolvable definition throws a clear error
listing the locations searched. `agentName` and `systemPrompt` are mutually exclusive.

First-run workspace-trust dialogs (claude/codex) are auto-confirmed with `Enter` at boot — `orc`
never mutates your CLI config. The boot loop only auto-confirms the trust dialog; any other
interstitial (e.g. codex's "Update available" banner, whose default is a self-update) is dismissed
with `Escape` and never accepted.

`agi kill` keeps the session record (marked dead) so `agi read` still resolves the transcript after a
kill — the transcript path is resolved and persisted at kill time. Dead records are hidden from
`agi list` by default (`--dead`/`--all` to show them). Use `agi kill <id> --purge` to remove a single
record, or `agi prune` to drop all dead records.

## Agent state & `wait`

`agi state <id>` classifies an interactive session in one shot (driver liveness + a single pane
capture); `agi wait <id>` blocks until it settles. Both are built on `Session.state()` /
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

`agi wait` polls `state()` (~1s) until it reaches a state in the requested set, **debounced**: a
non-progressing state must hold for **2 consecutive polls** before it's returned, so a sub-second gap
between an agent's tool calls is never misread as end-of-turn. `--for` selects the target set
(`done` | `waiting` | `failed` | `settled`, where `settled` = any of the three; default `settled`).
On timeout it returns the last observed state (it does not throw); exit code is `0` iff the reached
state is in the requested set, non-zero on timeout.

```sh
agi wait "$ID" --json                       # {"id","state","elapsedMs","timedOut"}
agi wait "$ID" --for done --timeout 120      # block up to 120s for the turn to yield
agi state "$ID" --json                       # {"id","state"} — point-in-time, no blocking
```

## Workspaces

A session is filed under a **workspace** key, and `agi list` (no flags) shows only the sessions for
the current directory's workspace. The key is resolved the same way at spawn time and at list time:

- explicit `--workspace <W>` if given (realpath-normalized when it's a real path), else
- **the git toplevel** of the directory — so a repo and all of its subdirectories share one
  workspace, else
- the directory's exact realpath, when it isn't in a git repo (no nesting — sibling/parent/child
  dirs are distinct workspaces).

A `--worktree` session belongs to its **parent repo's** workspace (a worktree can't exist without a
git parent, and that parent is the project home), so worktree agents are visible from `agi list` run
at the repo root. Use `agi list --workspace <W>` to target another workspace, or `--all` to ignore
the workspace filter entirely.

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
