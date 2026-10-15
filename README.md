# orc

`orc` runs coding agents (`claude`, `codex`, `pi`) as durable, detached sessions that other
agents (and humans) drive. Its core primitive, `agent()`, starts one **actor process per session**
that drives the provider over a **structured protocol** (no terminal, no screen scraping),
optionally in a fresh git worktree, in yolo mode by default. `claude` and `pi` are their own CLIs;
`codex` is orc's **built-in harness** on the OpenAI Responses API (no codex CLI needed).

- **Durable.** Each session has a mailbox (`inbox/`) and an append-only journal. Prompts survive an
  actor crash or a reboot; the next `orc send` (or `orc resume`) wakes the session.
- **Observable.** `orc read` (parsed transcript), `orc read --raw` (journal), `orc attach` (live
  journal view), `orc takeover` (hand the session to a human; `orc resume` takes it back).
- **Scriptable.** A TypeScript SDK (Bun, ESM) and the `orc` CLI; every command takes `--json`.

Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the current system) and
[`docs/DESIGN-runtime.md`](docs/DESIGN-runtime.md) (the actor runtime and why it replaced tmux).

## Requirements

| need | version / notes |
| --- | --- |
| [Bun](https://bun.sh) | ≥ 1.3 (`engines.bun`); developed on 1.4.2 |
| OS | macOS or Linux (POSIX process groups; macOS also needs `ps`). No Windows. |
| a provider | at least one of: `claude` or `pi` on `PATH`, authenticated (verified: claude 2.1.300, pi 1.2.0; other versions are not refused); for `codex`, an OpenAI credential — `orc login chatgpt`, pi's ChatGPT login, or `OPENAI_API_KEY` (see [codex](#codex-built-in-harness)) |
| `git` | only for `--worktree` |
| `tailscale` | only for `orc daemon` / `--host` |

tmux is **not** used.

## Install

```sh
bun install
bun link                                 # `orc` on PATH, runs from source
bun run install:cli                      # or: compile a standalone binary to ~/.local/bin/orc
bun run src/cli/index.ts <command> ...   # or: run it directly
```

## Quick start

```sh
ID=$(orc spawn -p claude -m haiku --prompt "summarize this repo in 3 bullets" --json | jq -r .id)
orc wait "$ID"                 # block until the turn settles
orc read "$ID"                 # latest parsed turn
orc send "$ID" "now list the riskiest module"
orc wait "$ID" && orc read "$ID"
orc kill "$ID"                 # stop it (record + journal kept; --purge removes them)
```

## Session lifecycle

**Status:** is there an actor? (`orc list`, the `status` field)

| status | meaning | next |
| --- | --- | --- |
| `running` | the session's actor holds a live lease | — |
| `suspended` | actor gone without a stop (crash, reboot, provider exit) | the next `orc send` wakes it and resumes the provider session; `orc resume` does too |
| `dead` | stopped by `orc kill` / `orc takeover`, a legacy tmux record, or no runtime state | sticky: never auto-wakes. `orc resume` hands a killed or taken-over session back |

**State:** what is the agent doing? (`orc state`, `orc wait`; derived from the journal)

| state | meaning |
| --- | --- |
| `starting` | actor up, provider not initialised yet |
| `running` | a turn is open, or messages are queued |
| `done` | no open turn, nothing queued: ready for **your** input. Not "succeeded": an agent that asks a clarifying question is also `done`. |
| `waiting` | the provider asked for a permission decision (rare in yolo mode; orc denies it so the turn ends) |
| `failed` | the last turn failed, **or** the session is not live. `orc state --json` says which: `stopped: true` (killed/taken over) or `suspended: true` (resumable) |

Rules that matter for scripts:

- `orc wait` returns on the first matching observation (journal events are authoritative; no
  debounce). After `orc send` returns, the state stays `running` until that turn ends (a queued
  message counts), so `send` then `wait` is race-free.
- A `suspended` session reads as `failed` with `suspended: true`; `orc send` wakes it unless
  `--no-wake`. After 3 consecutive failed starts, auto-wake stops (`send` only queues) until
  `orc resume`.
- `orc kill` drops messages still queued for the session (their delivery becomes `failed`).
- `orc prune` removes `dead` records and their session dirs. It keeps `running` sessions, keeps
  `suspended` ones unless `--suspended`, and keeps a spawn in progress.

## CLI

```
orc spawn  --provider <claude|codex|pi> [options]   Launch a session (aliases: agent, new)
orc send   <id|@alias> [PROMPT | - | @file] [--idempotency-key K] [--no-wake]
orc read   <id|@alias> [--last|--index N|--full|--raw]  Latest parsed turn; --full transcript; --raw journal
orc state  <id|@alias>                              starting|running|done|waiting|failed
orc wait   <id|@alias> [--for done|waiting|failed|settled] [--timeout SEC]
orc list   [--workspace W | --all | --dead | --all-hosts | --run ID | --lineage]   (alias: ps)
orc attach <id|@alias>                              Follow the journal live (read-only)
orc kill   <id|@alias> [--worktree] [--purge]       Stop (sticky); --purge removes record + journal
orc resume <id|@alias>                              Hand a killed/taken-over/suspended session back to an actor
orc takeover <id|@alias>                            Stop the actor; print the provider's own resume command
orc prune  [--worktree] [--suspended]               Drop dead records (+ session dirs, optional worktrees)
orc workflow <run|list|status|attach|logs|resume|retry|cancel|cleanup> ...   (alias: wf)
orc daemon [--port 8787] [--bind <ip>] [--insecure] Serve the HTTP API over tailscale
orc remote <add|list|rm> <host> [--port P]          Manage trusted peers
orc login  chatgpt [--import-pi] [--no-browser]     Sign in with ChatGPT (codex)
orc login  status [--json]                          Which OpenAI credential codex uses
orc logout chatgpt                                  Remove orc's ChatGPT credential
orc --host <h> <command>                            Run a command against a peer's daemon
```

`orc help` prints the full reference. A session is addressed by short id, full session id,
`@alias` (current workspace) or `@workspace:alias`.

### spawn options

| flag | meaning |
| --- | --- |
| `--provider, -p` | `claude` \| `codex` \| `pi` (required) |
| `--model, -m` | model name (codex without it: the first model your account lists, recorded on the session) |
| `--agent <name>` | named agent definition (exclusive with `--system-prompt`) |
| `--alias <name>` | workspace-scoped handle (`@name`); does not change agent behaviour |
| `--system-prompt <txt>`, `--system-prompt-mode` | system prompt; `append` (default) \| `replace` |
| `--prompt <txt \| - \| @file>` | initial prompt, sent once the provider is ready. Omitted = none (stdin is never read implicitly) |
| `--cwd <dir>`, `--workspace <w>` | base directory (default: cwd); logical workspace key |
| `--worktree [--branch <b>]` | create a fresh git worktree and use it as cwd |
| `--no-wait` | return once the actor has started; an initial `--prompt` is queued and delivered when ready |

If spawn fails before the provider is ready, orc stops the actor, drops the record and session
dir, and removes a `--worktree` it created.

### Exit codes and JSON

| command | exit | `--json` output |
| --- | --- | --- |
| `spawn` | 0 / 1 | the `SessionRecord` |
| `send` | 0 `acknowledged` or `queued`; **3** `unknown`; 1 failed or error | `{ok, id, phase, messageId, replayed}` |
| `read` | 0 / 1 | `Turn[]`; `--raw`: `{id, journal}`; no transcript yet: `{id, fallback: true, journal}` |
| `state` | 0 / 1 | `{id, state, status, stopped, suspended, live, pendingMessages, openTurn?, lastTurn?, stopReason?}` |
| `wait` | 0 iff a requested state was reached; 1 on timeout or error | `{id, state, elapsedMs, timedOut}` |
| `list` | 0 / 1 | records, each with `status` and `state` |
| `attach` | 0 when the session stops/suspends or on Ctrl-C; 1 if it has no runtime state | `{id, command, journalPath}` (does not follow) |
| `kill` | 0 / 1 | `{ok, id, purged}` |
| `resume` | 0 / 1 | same shape as `state --json` |
| `takeover` | 0 / 1 | `{id, cwd, command, note?}` |
| `prune` | 0 / 1 | `{ok, pruned: [ids]}` |
| `workflow run` | 0 run `done`; 1 otherwise; 143 runner got SIGTERM | final `WorkflowRun`; `--detach`: `{runId, logPath}` |

With `--json`, errors print `{"error": "..."}` on stdout and exit 1.

`send`:

- `--idempotency-key K` is the message id. Re-sending K with the same text returns the recorded
  phase with `replayed: true` and delivers nothing; K with different text is an error.
- `acknowledged`: the provider accepted the turn. `queued`: durably in the inbox, delivered later
  (the ack wait is bounded at 10 s). `unknown` (exit 3): cut before the provider acked it; orc
  never re-sends it, so check `orc read`, then send again with a new key.
- A killed or taken-over session refuses sends until `orc resume`.

### Examples

```sh
orc send "$ID" @prompt.txt                         # multi-line file, delivered as ONE message
orc spawn -p codex --alias reviewer --prompt "review the failing test"
orc read @reviewer                                 # same workspace
orc send @orc:reviewer "focus on the registry"     # from outside a workspace named `orc`
orc read "$ID" --full                              # full parsed transcript
orc read "$ID" --raw --json                        # the session journal
orc attach "$ID"                                   # follow it live (Ctrl-C stops following)
orc takeover "$ID"                                 # prints: cd <cwd> && claude --resume <id> ...
orc resume "$ID"                                   # hand it back to orc
orc kill "$ID" --worktree --purge
```

## SDK

```ts
import { agent, getSession, listSessions } from 'orc';

const s = await agent({ provider: 'claude', model: 'haiku', prompt: 'reply READY' });
await s.waitFor({ until: ['done'], timeoutMs: 120_000 });
console.log(await s.readParsed());                 // Turn[] from the provider transcript
console.log(await s.stateDetail());                // state, status, stopped/suspended, turns

const r = await s.send('next step', { messageId: 'step-2' });  // {phase, messageId, replayed}
console.log(s.journal({ tail: 20 }));               // JournalEntry[]
const t = await s.takeover();                       // {id, cwd, command}; s.resume() hands back
await s.kill({ removeWorktree: true });
```

- `Session`: `state()`, `stateDetail()`, `status()`, `waitFor()` / `waitForResult()`, `send()`,
  `interrupt()`, `readParsed()`, `readTranscript()`, `transcript()`, `journal()`, `journalPath()`,
  `attach()`, `attachCommand()`, `awaitReady()`, `kill()`, `takeover()`, `resume()`, `toJSON()`.
- Functions: `agent`, `getSession`, `listSessions`, `pruneSessions`, `statusOf`, and the workflow
  API (`runWorkflow`, `resumeWorkflow`, `retryWorkflow`, `cancelWorkflow`, …).
- `AgentOptions.waitForReady: false` returns once the actor has started; `readyTimeoutMs` bounds
  the readiness wait (default 60 s).

## Providers

| | claude | codex | pi |
| --- | --- | --- | --- |
| protocol | `claude -p` stream-json over stdio | orc's harness (`orc __codex-harness`, JSONL over stdio) → OpenAI Responses API | `pi --mode rpc` |
| yolo | `--permission-mode bypassPermissions` | always (no approvals; tools run unattended) | `-a` |
| system prompt | `--append-system-prompt-file` / `--system-prompt-file` | harness prompt + file (append) / the file alone (replace) | `--append-system-prompt` / `--system-prompt` `<file>` |
| `--agent` | native `--agent <name>` | resolved body → system prompt | resolved body → system prompt |
| transcript (`orc read`) | `~/.claude/projects/*/<id>.jsonl` | `~/.orc/sessions/<sid>/codex-session.jsonl` (pi session format) | `~/.orc/transcripts/pi/<sid>/` |
| `orc takeover` prints | `claude --resume <id> …` | `pi --session <codex-session.jsonl>` | `pi … --session-id … --session-dir …` |
| binary | `ORC_CLAUDE_BIN` or `PATH` | none (built into orc) | `PATH` |

- System prompts live in an orc-owned file (`~/.orc/sessions/<sid>/system-prompt.md`), never on
  argv and never in the worktree. orc never writes `AGENTS.md` or provider config.
- claude runs with `--setting-sources user,project,local` (never `--bare`), so skills, agents and
  hooks load. Permission requests that still arrive (claude `can_use_tool`, pi dialogs) are
  journaled and denied; the codex harness never asks.
- Slash commands, verified live with claude 2.1.300 through `orc send`: `/compact` compacts the
  session (the turn completes with an empty result; earlier context survives as a summary), and
  `/goal <condition>` sets a goal the turn keeps working toward until it holds. Interactive
  pickers and `/login` don't work. pi slash commands are unverified; the codex harness has none
  (a `/…` message is sent to the model as text).

`--agent <name>` resolution, each provider's own store first:

| provider | order |
| --- | --- |
| claude | native: `.claude/agents/` → `~/.claude/agents/` |
| codex | `.codex/agents/*.toml` (by `name`) → `$CODEX_HOME/agents/*.toml` → `.codex/prompts/<name>.md` → `$CODEX_HOME/prompts/<name>.md` → `.claude/agents/<name>.md` → `~/.claude/agents/<name>.md` |
| pi | `.claude/agents/<name>.md` → `~/.claude/agents/<name>.md` |

A codex TOML agent's `developer_instructions` become the system prompt, and its `model` applies
when `--model` is omitted. An unresolvable name is an error that lists the locations searched.

### codex (built-in harness)

`--provider codex` runs orc's own coding agent: the actor starts `orc __codex-harness <sid>`
(the same binary), which embeds [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) and
pi-agent-core 1.2.0 and calls `https://api.openai.com/v1/responses` directly.

- **Credentials**, first match wins: `orc login chatgpt` (Sign in with ChatGPT, stored 0600 in
  `~/.orc/auth/chatgpt.json`), then pi's ChatGPT login (`~/.pi/agent/auth.json` or
  `$PI_CODING_AGENT_DIR`), then `OPENAI_API_KEY`. `orc login status` shows which one is active. A
  refreshed token is written back to the store it came from (pi's file under pi's own lock).
  `orc login chatgpt --import-pi` copies pi's login instead of signing in; the copies then
  refresh independently.
- **Login** prints (and opens) the ChatGPT authorize URL and waits for the browser on
  `http://127.0.0.1:1455/auth/callback`; from a remote shell, paste the final redirect URL.
  Sign in with ChatGPT is an OpenAI program with eligibility rules for apps; if your account
  cannot use it, set `OPENAI_API_KEY`.
- **Model**: `--model`, else (on resume) the session's model, else the first model your account
  lists (`GET /v1/models`, cached 10 min). If the list is unavailable, spawn fails and asks for
  `--model`.
- **Tools**: `read`, `write`, `edit`, `bash`, `ls` (pi's names and schemas), in the session cwd,
  unsandboxed. `bash` commands live in the harness's process group, so `orc kill` stops them.
- **Session file**: pi's session JSONL v3 at `~/.orc/sessions/<sid>/codex-session.jsonl`; resume
  replays it. `orc takeover` prints `cd <cwd> && pi --session <file>` (pi ≥ 1.2.0 with its own
  OpenAI login); `orc resume` continues whatever pi appended.

## Workflows

A workflow is a TypeScript file (versioned in `orc.workflows/`) that default-exports a plain
`{ name, steps[] }`; `orc workflow run` imports and validates it. Runs persist to
`~/.orc/runs/<runId>.json`: a validated plan and digest before any side effect, per-step attempts
(`queued|spawning|dispatched|running|verifying|succeeded|failed|waiting|cancelled|abandoned`),
revision/CAS writes and an owner lease. A crashed run can be resumed, retried, cancelled or
cleaned up without silently duplicating children (durable intent + adoption + compensation, not
exactly-once).

```sh
orc workflow run <file> [--detach] [--json] [--max-concurrency N]
orc workflow list [--json]
orc workflow status <runId> [--json]                 # a stale `running` with a dead owner → orphaned
orc workflow attach <runId> [--json]                 # follow a --detach run's runner.log until it ends
orc workflow logs <runId> [--step id] [--raw] [--json]
orc workflow resume <runId> <file> [--detach] [--json]
orc workflow retry <runId> [--step id] <file> [--detach] [--json]
orc workflow cancel <runId> [--cascade] [--json]     # --cascade kills only sessions the run owns
orc workflow cleanup <runId> [--sessions] [--worktrees] [--json]
```

- **`--detach`** starts a detached runner process and returns the runId at once (`--json`:
  `{runId, logPath}`). Output goes to `~/.orc/runs/<runId>/runner.log`; the run records
  `runner: {pid, startTime, logPath, startedAt}`. Liveness = lease fresh and that same process
  (pid + start time) alive; otherwise `status` reports `orphaned` (persisted once observed; a
  finalized run is never downgraded).
- **`logs`** prints each step's parsed transcript (`### step <id> (<provider>)`); `--raw` shows the
  last 200 journal entries of each step session; `--json` emits `{step, turns}[]`, or
  `{step, provider, journal}[]` with `--raw`.
- **`resume` / `retry`** need the original workflow file locally (over `--host` the daemon falls
  back to the run's recorded source file); the plan digest must match.
- **Policy.** Optional `ExecutionPolicy` (`maxDepth`, `maxSessions`, `maxConcurrentSessions` (live
  actors), `deadlineMs`, `canDelegate`) is enforced fail-closed. Token/cost budgets are not
  enforced. Lineage flows through `ORC_*` env vars; `orc list --run <id>` filters by run tree.

```ts
// orc.workflows/feature.ts
import type { WorkflowDef } from '../src/workflow.ts'; // type-only, erased at runtime
export default {
  name: 'feature',
  steps: [
    { id: 'implement', provider: 'claude', worktree: true, taskFile: 'tasks/01.md' },
    { id: 'review', provider: 'codex', needs: ['implement'], cwd: '${implement.worktree}',
      prompt: 'Review the diff on this branch; write findings to REVIEW.md',
      verify: { file: { path: 'REVIEW.md' } } },
  ],
} satisfies WorkflowDef;
```

| step field | meaning |
| --- | --- |
| `id` | unique; `${id.field}` interpolates a prior step's result (e.g. `${implement.worktree}`) |
| `provider`, `alias`, `cwd`, `worktree` | as for `orc spawn` |
| `prompt` / `taskFile` | exactly one. Prompts over 1 KiB and every `taskFile` are dropped as a file under `~/.orc/runs/<runId>/`; the agent gets a short "read this file" pointer |
| `needs` | step ids that must succeed first (DAG). Root `maxConcurrency` (default 1) or `--max-concurrency N` runs ready steps in parallel |
| `verify` | portable success check: `gitDiff`, `command`, `file`, `artifact`, `resultEnvelope`, `all` / `any` |
| `done(ctx)` | local-only predicate over `{state, commitsAhead, capture, …}`; `capture` = last assistant text + the final turn, from the journal |
| `allowUnverified` | accept a yielded step with no check (default false) |
| `turns` | bounded multi-turn steering (`maxTurns`, `onNeedsInput`) |
| `outputs` / `inputs` | content-addressed artifacts passed between steps |
| `timeoutMs` | per-step wait (default 600000); a timeout fails the step |
| `continueOnFail` | default false: a failure stops new launches |

**A yield is not success.** A step succeeds by `done`, by `verify`, or (a `worktree` step with
neither) by `state === 'done' && commitsAhead >= 1`. A non-worktree step with no check is
**unverified** and fails unless `allowUnverified`. Step sessions are left alive for inspection;
`orc workflow cleanup <runId> --sessions --worktrees` removes what the run owns.

Runnable example: `orc workflow run orc.workflows/example.ts --json` (claude writes a token, codex
reads it back).

## Daemon & remote hosts

```sh
orc daemon                         # binds to this host's tailscale IP; refuses 0.0.0.0 without --insecure
orc daemon --bind 127.0.0.1        # local testing
orc remote add mini                # trust a peer (~/.orc/peers.json)
orc --host mini spawn -p claude --prompt "summarize this repo"
orc --host mini wait <id> && orc --host mini read <id>
orc list --all-hosts               # fleet view with a host column
```

- The daemon is a JSON/HTTP layer over the SDK on the same `~/.orc`: `/sessions`,
  `/sessions/:id/{read,send,wait,kill}`, `/workflows/run`, `/workflows/runs[/:id]`,
  `/workflows/runs/:id/{logs,resume,retry,cancel,cleanup}`, `/health`, `/whoami`. Bad requests →
  400 with `{"error"}`.
- `GET /health` reports `api: 2` (raw reads return `journal`; v1 daemons returned `pane`).
- `--host` covers `list`, `spawn`, `send`, `read`, `wait`, `state`, `kill` and `workflow`. Remote
  `attach` prints `tailscale ssh <host> orc attach <id>`. `resume`, `takeover`, `prune`, `daemon`
  and `remote` are host-local.
- **Auth is fail-closed** on every route but `/health`: an allowlisted tailnet identity (all
  scopes); `Authorization: Bearer` from `ORC_DAEMON_TOKENS` (JSON `token → scopes`; client:
  `ORC_DAEMON_TOKEN`); or legacy `x-orc-secret` = `ORC_DAEMON_SECRET` (all scopes). Missing or
  invalid → 401; missing scope → 403. Scopes: `sessions:read|write`, `workflows:read|write`,
  `admin` (implies all; needed for kill/cancel/cleanup). Tokens are never logged or returned.
- Daemon workflow file imports are confined to `ORC_WORKFLOW_ROOTS` (default: the daemon's cwd).

## Workspaces & aliases

- A session's workspace is `--workspace W` (realpath when it is a path), else the git toplevel of
  its cwd, else the cwd's realpath. A `--worktree` session belongs to its parent repo's workspace.
- `orc list` shows the current workspace's `running` and `suspended` sessions; `--workspace W`,
  `--all` (every workspace, dead included) and `--dead` widen it.
- `--alias debugger` makes `@debugger` (same workspace) and `@<workspace-name>:debugger` resolve
  to the session. An alias is unique among a workspace's active (running or suspended) sessions
  and reusable once the old session is killed or pruned. Dead records stay addressable by id.

## State & privacy

All state lives under `~/.orc` (override: `ORC_HOME`):

```
registry.json              session records
peers.json                 trusted daemon peers
locks/                     cross-process locks
sessions/<sid>/            spawn.json, state.json, journal.jsonl, inbox/, provider.jsonl,
                           actor.log, system-prompt.md
transcripts/pi/<sid>/      pi session files
runs/<runId>.json          workflow run record (the plan includes step prompts)
runs/<runId>/              runner.log, instruction drops, attempts/, artifacts/, inputs/
```

Prompt bodies, replies and step prompts are stored under `~/.orc`, **owner-only**: orc creates
directories 0700 and files 0600 whatever the umask, and tightens state left by older versions the
next time it writes it (one-off: `chmod -R go-rwx ~/.orc`). `orc kill --purge` and `orc prune`
delete a session's dir.

| env | effect |
| --- | --- |
| `ORC_HOME` | state root (default `~/.orc`) |
| `ORC_CLAUDE_BIN` | claude executable |
| `ORC_AUTH_DIR` | codex login dir (default `$ORC_HOME/auth`) |
| `OPENAI_API_KEY` | codex fallback credential (API-key Responses API) |
| `PI_CODING_AGENT_DIR` | where codex looks for pi's login (pi's own variable) |
| `ORC_CODEX_THINKING` | codex reasoning level: `off`/`minimal`/`low`/`medium` (default)/`high`/`xhigh`/`max` |
| `ORC_CODEX_MAX_RETRIES` | codex retries for 408/409/429/5xx (default 2) |
| `ORC_CODEX_BOOT_TIMEOUT_MS` | codex harness ready timeout (default 60000) |
| `ORC_CLAUDE_READY_TIMEOUT_MS` | claude initialize timeout (default 60000) |
| `ORC_ACTOR_READY_TIMEOUT_MS` | the actor's provider-ready timeout (default 120000) |
| `ORC_WORKFLOW_ROOTS` | daemon workflow import allowlist (`path.delimiter`-separated) |
| `ORC_DAEMON_TOKENS`, `ORC_DAEMON_TOKEN`, `ORC_DAEMON_SECRET` | daemon auth (server, client, legacy) |
| `CODEX_HOME` | codex agent/prompt lookup |

## Development & verification

```sh
bun test                                   # unit + fake-provider suites (codex: a local fake OpenAI server)
bun run typecheck                          # tsc --noEmit (src, test, scripts)
bun run check:compile                      # compile orc; run the codex harness's offline self-test
bun run verify:live --claude-model haiku   # live end-to-end on an authenticated host
```

`verify:live` runs `scripts/verify-runtime/all.ts`: per-provider runtime gates; CLI end-to-end
(spawn, idempotent send, SIGKILL the actor → `suspended` → wake, takeover/resume, kill/prune); a
detached workflow; and a check that `tmux` is never invoked. A missing provider is SKIP; any FAIL
exits 1. Everything runs in a temp `ORC_HOME`; expect a few cents with haiku. Flags and the
per-provider gates: [`scripts/verify-runtime/README.md`](scripts/verify-runtime/README.md).

Dogfooding: `bun scripts/dogfood/run.ts spawn <task.md> [provider]` starts an implementer in a
worktree of this repo; `bun scripts/dogfood/run.ts watch <id>` supervises it until it reports
`DOGFOOD_COMPLETE` (with a commit), `DOGFOOD_BLOCKED: …`, or yields (example specs in
`scripts/dogfood/tasks/`).

## Upgrading from the tmux runtime

1. **Kill live pre-actor sessions first**, with the old binary (`orc kill`) or
   `tmux kill-session -t <name>`. After the upgrade they show as `dead` with `legacy: "tmux"`:
   readable and prunable, never controlled, and their tmux panes keep running until you kill them.
2. Records and run files are normalised on read: `tmuxName` is dropped, `instructionsPath` →
   `systemPromptPath`, `transcriptSessionId` → `providerSessionId`. Runs go from schema 4 to 5; a
   `runnerTmux` becomes a read-only `legacyRunnerTmux` and such runs read as `orphaned` (resumable).
3. `~/.orc/messages/` and codex `instructions.md` files are no longer written; delete them freely
   (`prune` and `kill --purge` remove the latter).
4. Script-visible changes:
   - no live TUI: `orc attach` follows the journal; `orc takeover` + `orc resume` replace
     `tmux attach`
   - `wait` is not debounced; `send` can exit 3 (`unknown`) and has `--no-wake`
   - `list` shows `suspended`; `prune` keeps it unless `--suspended`
   - `spawn --no-wait` queues the initial prompt instead of skipping it
   - `--json`: `read --raw` → `{id, journal}` (was `pane`); `workflow logs --raw` → `journal`;
     `workflow run --detach` → `{runId, logPath}` (was `runnerTmux`); `attach` → `orc attach <id>`;
     `state` has more fields
   - new commands `resume` and `takeover`; `resume`, `takeover`, `prune`, `daemon` and `remote`
     are host-local under `--host`
5. Yolo flags: claude `--permission-mode bypassPermissions` (was `--dangerously-skip-permissions`);
   pi `--mode rpc -a`; codex is now orc's built-in harness (see below).
6. Daemon `api` is 2; in a mixed fleet check `GET /health` → `api`.
7. SDK: removed `Session.tmuxName`, `Session.capture()`, `classifyState`, `reduceWait`,
   `AgentOptions.driver`, `pruneSessions({driver})`, `runnerTmuxName`, `PaneInfo` and the
   `messages.ts` delivery-record helpers. `Session.attach()` follows the journal, `SessionStatus`
   adds `suspended`, `SendResult` is `{phase, messageId, replayed}`, and `StepDoneCtx.capture` is
   journal text rather than a pane.

### Upgrading from the codex app-server runtime

codex no longer runs the `codex` CLI (`codex app-server`); it runs orc's built-in harness, and the
codex CLI is not needed. Sessions created by the app-server runtime show as `dead`, have no
transcript in `orc read` (their rollouts stay in `~/.codex/sessions`), and cannot be resumed;
`orc prune` removes them. `ORC_CODEX_BIN` is ignored. Sign in once with `orc login chatgpt` (or
reuse pi's login, or set `OPENAI_API_KEY`). `--agent` still reads codex TOML agents.
