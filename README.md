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
| [Bun](https://bun.sh) | ≥ 1.3.3 (`engines.bun`); developed on 1.4.2 |
| OS | macOS or Linux (POSIX process groups; macOS also needs `ps`). No Windows. |
| at least one provider | see below; other CLI versions are not refused |
| `claude` CLI | for `--provider claude`: on `PATH` (or `ORC_CLAUDE_BIN`), signed in. Verified: 2.1.300 |
| `pi` CLI | only for `--provider pi`, and to continue a codex session after `orc takeover`. Verified: 1.2.0 |
| OpenAI credential | for `--provider codex`: `orc login chatgpt`, pi's ChatGPT login, or `OPENAI_API_KEY` (see [codex](#codex-built-in-harness)). The `codex` CLI is **not** needed |
| `git` | only for `--worktree` |
| `tailscale` | only for `orc daemon` / `--host` |

tmux is **not** used.

## Install

**Prebuilt binary** (no Bun needed; from the first tagged release on): each
[GitHub release](https://github.com/thehumanworks/orc/releases) attaches single-file executables built with `bun build --compile` (`orc-darwin-arm64`,
`orc-darwin-x64`, `orc-linux-x64`, `orc-linux-arm64`; the Linux ones need glibc), a `SHA256SUMS`
file and a build-provenance attestation. The x64 binaries embed Bun's default (non-baseline) x64
runtime, so they need a CPU with AVX2 (Intel Haswell / AMD Excavator or newer).

```sh
TAG=v0.1.0 ASSET=orc-darwin-arm64          # orc-<darwin|linux>-<arm64|x64>
gh release download "$TAG" --repo thehumanworks/orc --pattern "$ASSET" --pattern SHA256SUMS
grep " $ASSET\$" SHA256SUMS | shasum -a 256 -c -          # orc-darwin-arm64: OK
gh attestation verify "$ASSET" --repo thehumanworks/orc   # built by this repo's release workflow
chmod +x "$ASSET" && mkdir -p ~/.local/bin && mv "$ASSET" ~/.local/bin/orc
orc --version                                             # orc 0.1.0
```

With every binary downloaded next to it, `shasum -a 256 -c SHA256SUMS` checks them all. On Linux,
`sha256sum -c` can stand in for `shasum -a 256 -c` in both commands. On macOS,
a binary downloaded with a browser is quarantined and Gatekeeper refuses to start it: clear the
flag with `xattr -d com.apple.quarantine ~/.local/bin/orc` (`gh` and `curl` downloads are not
quarantined).

**From source** (Bun ≥ 1.3.3):

```sh
bun install
bun link                                 # `orc` on PATH, runs from source
bun run install:cli                      # or: compile a standalone binary to ~/.local/bin/orc
bun run src/cli/index.ts <command> ...   # or: run it directly
```

**With Nix** (Linux, Apple-silicon macOS): `nix run github:thehumanworks/orc -- --version` (once
the flake is on `main`), or `nix build` in a checkout; see [Nix](#nix).

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
| `spawning` | reserved by `orc spawn` moments ago; the actor is being created (`state`: `starting`) | becomes `running`, or `dead` if the spawn died (after 10 min) |
| `dead` | stopped by `orc kill` / `orc takeover`, a legacy tmux record, a codex app-server session, or no runtime state | sticky: never auto-wakes. `orc resume` hands a killed or taken-over session back |

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
  `kill --worktree` and `prune --worktree` remove the worktree checkout but keep its branch (it may
  hold the agent's commits); delete the branch yourself once merged.
- `orc prune` removes `dead` records and their session dirs. It keeps `running` and `spawning`
  sessions; keeps `suspended` ones unless `--suspended` (which stops them first, under the
  session's lock, so a concurrent `orc resume` either wins or finds nothing); and keeps sessions a
  human took over unless `--taken-over` (their dir holds the system prompt the printed resume
  command uses). `orc list` marks those `taken-over(hand back: orc resume <id>)`.

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
orc prune  [--worktree] [--suspended] [--taken-over]  Drop dead records (+ session dirs, optional worktrees)
orc workflow <run|list|status|attach|logs|resume|retry|cancel|cleanup> ...   (alias: wf)
orc daemon [--port 8787] [--bind <ip>] [--insecure] Serve the HTTP API over tailscale
orc remote <add|list|rm> <host> [--port P]          Manage trusted peers
orc login  chatgpt [--import-pi] [--no-browser]     Sign in with ChatGPT (codex)
orc login  status [--json]                          Which OpenAI credential codex uses
orc logout chatgpt                                  Remove orc's ChatGPT credential
orc settings [--json]                               Effective settings and where each value comes from
orc mcp    [--wait-timeout SEC]                     Serve these commands as MCP tools over stdio (see MCP)
orc --host <h> <command>                            Run a command against a peer's daemon
orc --local <command>                               Run here, ignoring ORC_HOST / settings `host`
orc --version [--json]                              This binary's version (alias: -V)
orc --color[=WHEN] <command>                        auto (default) | always | never; --no-color = never
```

`orc help` prints the full reference. Add `--help` (or `-h`) to a command or subcommand
for focused help, for example `orc spawn --help` or `orc workflow run --help`. Help is
shown locally without connecting to a daemon or loading project settings.
A session is addressed by short id, full session id,
`@alias` (current workspace) or `@workspace:alias`.

Output to a terminal is coloured. A status word has the same colour everywhere (running
cyan, done green, failed red, waiting yellow, suspended magenta, dead dim). Where a status
stands on its own (`orc state`/`wait`, detail views, a list row's lifecycle tag, a step's
ok/FAIL, a run's result) it also gets a glyph: `● running`, `✓ done`, `✗ failed`,
`! waiting`, `◌ suspended`, `○ dead`. Secondary statuses inside dense rows (a list row's
agent state, `state=` in step lines, settings file states) are colour only. Ids are bold,
secondary detail dim. `--no-color` or `NO_COLOR=1` turns colour off, `--color=always` or
`FORCE_COLOR=1` forces it (the flags win). Piped/redirected output is plain text and
`--json` is never coloured. Agent text printed to a terminal has escape sequences and
control characters stripped.

### spawn options

| flag | meaning |
| --- | --- |
| `--provider, -p` | `claude` \| `codex` \| `pi` (required unless [settings](#settings-orc_host-and-settingstoml) set `provider`) |
| `--model, -m` | model name; default: settings `[models].<provider>` (not with `--agent`), else the provider's own (codex: the first model your account lists, recorded on the session) |
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
| `state` | 0 / 1 | `{id, state, status, stopped, suspended, live, pendingMessages, openTurn?, lastTurn?, stopReason?, legacy?}` |
| `wait` | 0 iff a requested state was reached; 1 on timeout or error | `{id, state, elapsedMs, timedOut}` |
| `list` | 0 / 1 | records, each with `status` and `state` |
| `attach` | 0 when the session stops/suspends or on Ctrl-C; 1 if it has no runtime state | `{id, command, journalPath}` (does not follow) |
| `kill` | 0 / 1 | `{ok, id, purged}` |
| `resume` | 0 / 1 | same shape as `state --json` |
| `takeover` | 0 / 1 | `{id, cwd, command, note?}` |
| `prune` | 0 / 1 | `{ok, pruned: [ids]}` |
| `login chatgpt` | 0 signed in / imported; 1 failed | — (prints the default codex model) |
| `login status` | 0; 1 when a credential file is unreadable | `{active: orc\|pi\|env\|none\|error, error?, orc: {path, credential}, pi: {path, credential}, openaiApiKey}` (no secrets) |
| `logout chatgpt` | 0 | — (orc's credential only; pi's login is untouched) |
| `workflow run` | 0 run `done`; 1 otherwise; 143 runner got SIGTERM | final `WorkflowRun`; `--detach`: `{runId, logPath}` |

With `--json`, errors print `{"error": "..."}` on stdout and exit 1.

`send`:

- `--idempotency-key K` is the message id. Re-sending K with the same text returns the recorded
  phase with `replayed: true` and delivers nothing; K with different text is an error.
- `acknowledged`: the provider accepted the turn. `queued`: durably in the inbox, delivered later
  (the ack wait is bounded at 10 s). `unknown` (exit 3): cut before the provider acked it; orc
  never re-sends it, so check `orc read`, then send again with a new key.
- A killed or taken-over session refuses sends until `orc resume`.
- With no prompt argument, `send` reads stdin when it is not a terminal (blocking until EOF; empty
  input is an error) and errors on a terminal. `spawn` never reads stdin implicitly.
- There is no per-subcommand `--help`; `orc help` prints the whole reference.

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
- **Login** prints (and, unless `--no-browser`, opens) the ChatGPT authorize URL and waits for
  the browser on `http://127.0.0.1:1455/auth/callback`; from a remote shell, paste the final
  redirect URL. On success it prints the default codex model. `orc logout chatgpt` removes orc's
  credential only (pi's login stays and is then used).
- **Eligibility.** Sign in with ChatGPT is an OpenAI program: eligible ChatGPT Plus/Pro users can
  opt in to plan usage, which OpenAI offers to open-source projects and personal projects that
  run locally (paid or remotely hosted apps must request access first). See OpenAI's
  [Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
  guide. Otherwise set `OPENAI_API_KEY`.
- **Model**: `--model`, else (on resume) the session's model, else the live default: the first
  model your ChatGPT account lists (server order), or with an API key the newest chat model in
  pi-ai's catalog (`GET /v1/models`, cached 10 min). The choice is recorded on the session and
  printed by `orc spawn`. If no model can be listed, spawn fails and asks for `--model`.
- **Tools**: `read`, `write`, `edit`, `bash`, `ls` (pi's names and schemas), in the session cwd,
  unsandboxed. `bash` commands live in the harness's process group, so `orc kill` stops them.
- **Session file**: pi's session JSONL v3 at `~/.orc/sessions/<sid>/codex-session.jsonl`; resume
  replays it. `orc takeover` prints `cd <cwd> && pi --session <file>` (pi ≥ 1.2.0 with its own
  OpenAI login); `orc resume` continues whatever pi appended.
- **Known limitation: no context compaction yet.** When a conversation outgrows the model's
  context window the turn fails ("the conversation exceeds the model's context window; start a
  new session"). Start a fresh session and hand it a summary. (claude's `/compact` does not apply:
  the harness has no slash commands.)
- **Legacy sessions** from the removed `codex app-server` runtime are `dead`, have no transcript in
  `orc read`, and cannot be resumed (see the upgrade notes).

## Workflows

A workflow is a TypeScript file (versioned in `orc.workflows/`) that default-exports a plain
`{ name, steps[] }` or a factory `({ prompt }) => ({ name, steps })`; `orc workflow run` imports
and validates it. Supply text with `--prompt "Your question"`. Runs persist to
`~/.orc/runs/<runId>.json`: a validated plan and digest before any side effect, per-step attempts
(`queued|spawning|dispatched|running|verifying|succeeded|failed|waiting|cancelled|abandoned`),
revision/CAS writes and an owner lease. A crashed run can be resumed, retried, cancelled or
cleaned up without silently duplicating children (durable intent + adoption + compensation, not
exactly-once).

```sh
orc workflow run <file> [--prompt TEXT] [--keep-sessions-on-error] [--detach] [--json] [--max-concurrency N]
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
  back to the run's recorded source file); the plan digest must match. With `--detach` they start a
  detached runner and return at once (`--json`: `{runId, logPath, action}`). A step whose session a
  human took over is never relaunched around them: the attempt fails as `taken_over`; hand the
  session back (`orc resume <id>`), then `orc workflow retry <runId> --step <id>`.
- **Events**: each attempt transition is emitted once and only forward
  (`queued → spawning → dispatched → running → verifying → succeeded|failed|…`).
- **Models.** Steps have no model of their own: each step session gets settings
  `[models].<provider>` (else the provider's default), fixed when the run starts. The run records
  that map (`defaultModels`); `resume`, `retry` and detached runners use the record and never read
  settings, so a later settings change never switches models mid-run (a run that started without
  `[models]` keeps none). Over `--host` the daemon applies no `[models]` (foreground or
  `--detach`).
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
**unverified** and fails unless `allowUnverified`. Failed runs stop their owned sessions by
default, preserving logs, artifacts, and worktrees. Set `keepSessionsOnError: true` on the
workflow (or `--keep-sessions-on-error` when starting it) to retain them for debugging.
Successful runs retain their sessions. `orc workflow cleanup <runId> --sessions --worktrees`
explicitly cleans up a run's sessions and worktrees.

### Research with text input and artifact handoffs

[orc.workflows/research.ts](orc.workflows/research.ts) is a complete two-step example: Pi writes
an optimized query, then Claude researches it and writes a cited JSON answer. From this checkout,
run the source CLI to use these changes immediately:

```sh
bun src/cli/index.ts --local workflow run orc.workflows/research.ts \
  --prompt "Which five inference subscriptions offer the best value for coding agents?"
```

After installing the updated CLI (`bun run install:cli`), the same command starts with `orc`.
Run it from a directory where you want `optimized-query.txt` and `search-results.json` written;
use an absolute workflow path if that directory is elsewhere. Pi and Claude must already be
configured with working credentials and model access. Each provider needs file tools, and the
research step needs web access. Inspect results with `orc --local workflow logs <runId>`.

The workflow factory receives `prompt?: string`. It can reject missing text, as the research
example does. The supplied text is saved privately with the run and reused for detached runs,
resume, and retry; it is separate from step artifact `inputs`.
Use `--prompt @question.txt` to read a file or `--prompt -` to read standard input.

```ts
inputs: [{
  name: 'query',                       // local name used by this step
  fromStep: 'search-query-optimizer', // producing step id; also creates a dependency
  artifact: 'optimized-query',        // producer's outputs[].name (defaults to name)
  materializeAs: 'optimized-query.txt', // optional relative filename
}],
prompt: 'Read ${inputs.query}, research it, and write search-results.json.',
```

`outputs` declares files the agent must create; it does not instruct the agent to write them.
State the filename explicitly in the producer's prompt. Inputs copy verified artifact bytes
into `~/.orc/runs/<runId>/inputs/<consumerStepId>/`; `${inputs.query}` resolves to the absolute
copied path in a step's `prompt`, `taskFile`, or `cwd`. Use a quoted string or escape `\${…}` in a
JavaScript template literal so JavaScript does not evaluate the placeholder itself. Different
consumers have separate input directories. Missing or corrupt inputs fail before spawning the
consumer. A required dependency must succeed even when its producer has `continueOnFail: true`;
that flag only lets independent work continue. `allowUnverified` does not bypass missing outputs.

The original research failure was a missing output: the optimizer replied in chat but never
wrote `optimized-query.txt`. The example now requests the file explicitly, verifies artifacts,
and binds the second step's input. Output collection failures include the underlying error in
the workflow log and saved attempt diagnostics.

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
  `/workflows/runs/:id/{logs,resume,retry,cancel,cleanup}`, `/health`, `/whoami`.
- Errors are `{"error"}` with: 400 invalid request; 401/403 auth (below); 403 also when the
  execution policy forbids a spawn or wake; 404 unknown session or run; 409 a stopped session
  (`orc resume` first), an idempotency-key conflict, a legacy session, or a run in the wrong state
  (cancelled, live owner); 502 the provider failed to start; 500 anything else.
- `GET /health` reports `api: 2` (raw reads return `journal`) and `mcp: "/mcp"`. `--host` still
  works against a v1 (pre-actor) daemon: its `submitted` send phase counts as success and `pane`
  reads render.
- `--host` covers `list`, `spawn`, `send`, `read`, `wait`, `state`, `kill` and `workflow`, with the
  local output except: `state --json` is only `{id, state, status, suspended, stopped}`; `list`
  takes only `--workspace`/`--all`/`--dead` (rows have no `lineage`); `workflow resume`/`retry`
  take no `--detach`. Remote `attach` prints `tailscale ssh <host> orc attach <id>`. `resume`,
  `takeover`, `prune`, `daemon` and `remote` are host-local.
- **Auth is fail-closed** on every route but `/health`: an allowlisted tailnet identity (all
  scopes); `Authorization: Bearer` from `ORC_DAEMON_TOKENS` (JSON `token → scopes`; client:
  `ORC_DAEMON_TOKEN`); or legacy `x-orc-secret` = `ORC_DAEMON_SECRET` (all scopes). Missing or
  invalid → 401; missing scope → 403. Scopes: `sessions:read|write`, `workflows:read|write`,
  `admin` (implies all; needed for kill/cancel/cleanup). Tokens are never logged or returned.
- REST workflow file imports (`/workflows/run`, `resume`, `retry`) are meant to be confined to
  `ORC_WORKFLOW_ROOTS` (default: the daemon's cwd), but a path outside the roots that names an
  existing file is still accepted (a known gap). The MCP tools on `/mcp` (`workflow_run`,
  `workflow_resume`, `workflow_retry`) run `orc --local workflow … <absolute file>` and have no
  containment: they import any workflow file the daemon's user can read.
- The daemon also serves the MCP tools at `/mcp`, behind the same auth (see
  [MCP](#mcp-orc-as-tools-for-a-lead-agent)).

## MCP (orc as tools for a lead agent)

`orc mcp` serves orc's commands as [MCP](https://modelcontextprotocol.io) tools over stdio, and
`orc daemon` serves the same tools at `/mcp` (Streamable HTTP). Point a lead agent (Claude Code,
Codex, any MCP client) at it and it runs a team of agents through tool calls.

- **Every tool runs the CLI**: `orc <cmd> … --json` (this build, as a child process: argv only,
  prompts on stdin) and returns that JSON as `structuredContent` (arrays wrapped, e.g.
  `{sessions: […]}`) plus compact text for the model (`guide` is text only). The CLI's `--json`
  output is the contract; nothing is re-implemented. CLI errors become `isError` results with the
  message and a hint. Arguments are validated strictly: an unknown or misspelled one (e.g.
  `idempotencyKey` for `idempotency_key`) is an error, never silently ignored.
- **The lead is taught the method.** The server's `instructions` and the `guide` tool (also the
  `orc://guide` resource; `orchestrate` is a prompt) carry the team method: split the work into
  vertical slices that can each be verified on their own; per slice a context gatherer (a fast,
  cheap model), an implementor (the strongest model) and a judge (a strong model, ideally another
  provider) who reviews before the lead accepts; worktrees for overlapping code; parallel waits;
  cleanup. Model-neutral: `settings` shows the configured defaults.
- Supported protocol revisions: 2026-07-28 (`server/discover`) and the 2025 ones (`initialize`),
  via the official MCP TypeScript SDK.

| tool | runs | daemon scope |
| --- | --- | --- |
| `guide` | — (the playbook; `topic` for one section) | any |
| `spawn` | `spawn … --no-wait` (returns at once; the prompt is queued) | `sessions:write` |
| `send` | `send <id> - [--idempotency-key K] [--no-wake]` | `sessions:write` |
| `wait` | one `wait <id> --for … --timeout …` per id, concurrently (`ids`, `mode: all\|any`) | `sessions:read` |
| `read` | `read <id> [--index N\|--full\|--raw]`, bounded by `max_chars` (the end is kept) | `sessions:read` |
| `state`, `list` | `state <id>`, `list […]` | `sessions:read` |
| `settings` | `settings` (in `cwd`) | `sessions:read` |
| `kill`, `prune` | `kill <id> […]`, `prune […]` | `admin` |
| `resume` | `resume <id>` | `sessions:write` |
| `workflow_run` | `workflow run <file> --detach` (in `cwd`) | `workflows:write` |
| `workflow_resume`, `workflow_retry` | `workflow resume\|retry <runId> <file> … --detach` (in `cwd`) | `workflows:write` |
| `workflow_list`, `workflow_status`, `workflow_logs` | `workflow list\|status\|logs …` | `workflows:read` |
| `workflow_cancel`, `workflow_cleanup` | `workflow cancel\|cleanup <runId> …` | `admin` |

Not exposed, on purpose: `attach` and `workflow attach` (live streams for a human; use `read` /
`workflow_logs`), `takeover` (hands a session to a human: the lead keeps the reins), `login` /
`logout` (credentials), `daemon` and `remote` (serving and trust configuration), `mcp`, `help`.

**stdio** (the lead's machine). Add the server to the lead's client:

```sh
claude mcp add --transport stdio orc -- orc mcp     # Claude Code (--scope user: every project)
codex mcp add orc -- orc mcp                         # Codex CLI
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.orc]
command = "orc"
args = ["mcp"]
```

From source, the command is `bun` with args `["<repo>/src/cli/index.ts", "mcp"]`. The server runs
orc in its own working directory (clients start it in the session's directory) with the client's
environment, so `ORC_HOME`, settings and default hosts apply as for `orc` itself. On the
remote-capable tools (`spawn`, `send`, `wait`, `read`, `state`, `list`, `kill`, `workflow_run`,
`workflow_list|status|logs|cancel|cleanup`), `host` sends that call to a peer's daemon
(`orc --host`); the others run here only.

**HTTP** (any daemon). `orc daemon` serves `/mcp` on its bind address, the tailscale IP by default:
exposing the daemon on the tailnet exposes MCP too. The startup line prints the URL.

```sh
claude mcp add --transport http orc-mini http://mini:8787/mcp --header "Authorization: Bearer $ORC_DAEMON_TOKEN"
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.orc-mini]
url = "http://mini:8787/mcp"
bearer_token_env_var = "ORC_DAEMON_TOKEN"
```

- **Auth** is the daemon's: an allowlisted tailnet identity (all scopes, no header needed), a
  bearer token from `ORC_DAEMON_TOKENS`, or the legacy `x-orc-secret`; anything else is 401.
- **Scopes**: each tool needs the scope of its REST route (table above; `wait` is an observation,
  so `sessions:read`). `tools/list` shows only the tools the caller may call; calling another one
  returns an error result that names the missing scope.
- **Host/Origin guard** (DNS rebinding): `/mcp` answers only requests whose `Host` names the
  daemon (the bound address; loopback names on loopback; this node's MagicDNS name, short name
  and tailnet IPs on the tailnet) and whose `Origin`, if any, names it too (CLI and agent
  clients send none); otherwise 403. Ports are not compared. `orc daemon --mcp-allow-host H`
  (repeatable) adds a name, e.g. a DNS alias or a proxy.
- Everything runs **on the daemon host** (`orc --local …`, whatever its settings say): `spawn`,
  `workflow_run`, `workflow_resume` and `workflow_retry` need an absolute, existing `cwd` (a
  workflow step without its own `cwd` runs there), paths must be absolute, and an `@alias` resolves
  against the daemon's own directory (use ids). There is no `host` parameter. Workflow files are
  not confined to `ORC_WORKFLOW_ROOTS` here (see Daemon).
- Stateless: no MCP session; sessions and runs are addressed by their orc ids.

**Timeouts and limits.** `wait` returns within 45 s by default even when agents are still running
(the result says which are pending; the lead calls it again): Codex times out a tool call after
60 s (`tool_timeout_sec`). Change it with `orc mcp --wait-timeout SEC` (stdio), or per call with
`timeout_seconds` (≤ 600). `wait` takes up to 16 ids; `read` and `workflow_logs` return at most
`max_chars` (16000 by default). At most 32 CLI children run at once per server process (each
`wait` id is one); further calls queue, and a cancelled call leaves the queue. The daemon
credentials `ORC_DAEMON_SECRET`, `ORC_DAEMON_TOKENS` and `ORC_DAEMON_TOKEN` are never passed to
the CLI children (so never to agents), except that an explicit `host` call keeps the client
credentials (`ORC_DAEMON_TOKEN`, `ORC_DAEMON_SECRET`) it authenticates with. Calls without `host`
that follow a default host carry none: when that peer needs a token, pass `host` explicitly (an
`unauthorized` error on such a call says so).

## Settings (`ORC_HOST` and `settings.toml`)

Set a default remote host and spawn defaults once instead of on every command:

```toml
# ~/.orc/settings.toml (global) or <project>/.orc/settings.toml (local)
host = "studio"        # default remote target: host or host:port, as for --host
provider = "claude"    # default `orc spawn --provider`
[models]               # default --model per provider (spawn and workflow steps)
claude = "haiku"
codex  = "gpt-5.5"
pi     = "openai/gpt-5"
```

- **Files.** Global: `$ORC_HOME/settings.toml`. Local: the **nearest** `<dir>/.orc/settings.toml`
  from the current directory (its realpath; never `--cwd`) up to the git toplevel (the nearest
  directory holding `.git`, so a linked worktree stops at itself); outside a repo only the current
  directory. One local file at most (no cascading); a local file that is the
  global file itself (running from `~`) is ignored as local. Local overrides global per key,
  `[models]` per provider.
- **Validation.** Unknown keys or tables warn once on stderr (forward compatible). A wrong type or
  value (provider not `claude|codex|pi`, empty strings, bad host syntax) or unparsable TOML is an
  error that names the file and key. An invalid `ORC_HOST` refuses only the commands it would
  route (with `--local` or `--host` it is irrelevant; `orc settings` shows it as a note).
- **`orc settings [--json]`** prints each effective value with its source (flag / env / local
  file / global file / default), the files considered and any warnings.

| key | precedence (first wins) |
| --- | --- |
| host | `--local` > `--host` > `ORC_HOST` (set and non-empty; `ORC_HOST=""` = no default host) > local `host` > global `host` > this host |
| provider | `--provider` > local > global > error ("provider is required") |
| model | `--model` > local `[models].<p>` > global `[models].<p>` > the provider's own default; a named `--agent` keeps its own model |

- A default host applies to `list`, `spawn`, `send`, `read`, `wait`, `state`, `kill`, `attach` and
  `workflow`, and prints one line on stderr — `orc: → studio (from ORC_HOST)` or
  `(from /path/settings.toml)` — even with `--json` (stdout stays machine-clean).
  `list --all-hosts` is unaffected. Host-local commands (`daemon`, `remote`, `resume`, `takeover`,
  `prune`, `login`, `logout`, `settings`, `help`) ignore default hosts; an explicit `--host` on them
  is still an error.
- `spawn` resolves provider and model on the client and sends them explicitly, locally or remote.
- **Safety.** A `host` from a **local** (project) file is honoured only for a trusted peer
  (`orc remote add`, matched by host and port like `--host`) or your own global `host`; otherwise
  the command is refused —
  `orc remote add <host>`, or pass `--local` / `--host`. `ORC_HOST`, `--host` and the global file
  are your own intent and are not restricted. Inside an orc session (the provider env carries
  `ORC_PARENT_SESSION_ID` / `ORC_DEPTH` ≥ 1) default hosts are ignored, so a nested `orc` stays on
  its host; `--host` still works and provider/model defaults still apply. `ORC_HOST` is never
  passed to agent processes, and detached workflow runners always run with `--local`.
- The SDK reads no settings files; `loadSettings({cwd, env})` returns the same resolution (values
  with their sources) for callers who want it.

## Workspaces & aliases

- A session's workspace is `--workspace W` (realpath when it is a path), else the git toplevel of
  its cwd, else the cwd's realpath. A `--worktree` session belongs to its parent repo's workspace.
- But a session spawned with `--cwd` **inside an existing linked worktree** (e.g. a reviewer
  pointed at another agent's worktree) gets that worktree's toplevel as its workspace: plain
  `orc list` and `@alias` from the main checkout don't see it. Pass `--workspace <repo>` to keep
  it in the repo's workspace, or address it by id.
- `orc list` shows the current workspace's `running`, `suspended` and `spawning` sessions;
  `--workspace W`, `--all` (every workspace, dead included) and `--dead` widen it.
- `--alias debugger` makes `@debugger` (same workspace) and `@<workspace-name>:debugger` resolve
  to the session. An alias is unique among a workspace's active (running or suspended) sessions
  and reusable once the old session is killed or pruned. Dead records stay addressable by id.

## State & privacy

All state lives under `~/.orc` (override: `ORC_HOME`):

```
registry.json              session records
peers.json                 trusted daemon peers
settings.toml              global settings (optional; see Settings)
locks/                     cross-process locks (a lock whose owner process is gone is reclaimed
                           at once; one with no recorded owner after 5 min)
auth/                      codex login: chatgpt.json, device-id (ORC_AUTH_DIR overrides)
cache/codex-models.json    codex model list per account (ids only, 10 min)
sessions/<sid>/            spawn.json, state.json, journal.jsonl, inbox/, provider.jsonl,
                           actor.log, system-prompt.md, codex-session.jsonl (codex)
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
| `ORC_HOST` | default remote host for remote-capable commands (`""` = none; see Settings) |
| `ORC_CLAUDE_BIN` | claude executable |
| `ORC_AUTH_DIR` | codex login dir (default `$ORC_HOME/auth`) |
| `OPENAI_API_KEY` | codex fallback credential (API-key Responses API) |
| `PI_CODING_AGENT_DIR` | where codex looks for pi's login (pi's own variable) |
| `ORC_CODEX_THINKING` | codex reasoning level: `off`/`minimal`/`low`/`medium` (default)/`high`/`xhigh`/`max` |
| `ORC_CODEX_MAX_RETRIES` | codex retries for 408/409/429/5xx (default 2) |
| `ORC_CODEX_BOOT_TIMEOUT_MS` | codex harness ready timeout (default 60000) |
| `ORC_CLAUDE_READY_TIMEOUT_MS` | claude initialize timeout (default 60000) |
| `ORC_ACTOR_READY_TIMEOUT_MS` | the actor's provider-ready timeout (default 120000) |
| `ORC_WORKFLOW_ROOTS` | daemon REST workflow import allowlist (`path.delimiter`-separated; see Daemon for its limits) |
| `ORC_DAEMON_TOKENS`, `ORC_DAEMON_TOKEN`, `ORC_DAEMON_SECRET` | daemon auth (server, client, legacy) |
| `CODEX_HOME` | codex agent/prompt lookup |

## Development & verification

```sh
bun test                                   # unit + fake-provider suites (codex: a local fake OpenAI server)
bun run typecheck                          # tsc --noEmit (src, test, scripts)
bun run check:compile                      # compile orc; run the codex harness's offline self-test
bun run verify:live --claude-model haiku   # live end-to-end on an authenticated host
```

With Nix, `nix develop` provides the toolchain and `nix flake check` builds, smoke-tests and
typechecks orc in the sandbox: see [Nix](#nix).

`verify:live` runs `scripts/verify-runtime/all.ts`: per-provider runtime gates; CLI end-to-end
(spawn, idempotent send, SIGKILL the actor → `suspended` → wake, takeover/resume, kill/prune); a
detached workflow; and a check that `tmux` is never invoked. A missing provider is SKIP; any FAIL
exits 1. Everything runs in a temp `ORC_HOME`; expect a few cents with haiku. Flags, every row and
the per-provider gates: [`scripts/verify-runtime/README.md`](scripts/verify-runtime/README.md).

### Live verification on a Mac

You need Bun ≥ 1.3.3, git and a signed-in `claude`. `pi` (for the pi rows) and an OpenAI credential
(for the codex rows) are optional: a provider you don't have is reported SKIP.

```sh
git clone -b feat/actor-runtime https://github.com/thehumanworks/orc.git && cd orc
bun install
bun test && bun run typecheck                  # optional: the offline suites first
bun src/cli/index.ts login status              # which OpenAI credential codex would use
bun src/cli/index.ts login chatgpt             # only if status shows none and you want codex rows
                                               # (or reuse pi's ChatGPT login, or export OPENAI_API_KEY)
bun scripts/verify-runtime/all.ts --claude-model haiku \
    [--codex-model <model-id>] [--pi-model <provider>/<model-id>]
```

- Without `--codex-model`, codex uses your account's default model (`orc login chatgpt` prints
  it); without `--pi-model`, pi uses its own default. Each run prints a note for such providers.
- Read the table: one `preflight` row per provider (claude/pi: binary and `--version`; codex: which
  credential), then `runtime gate`, the `e2e …` rows, the `workflow` rows (claude), and
  `tmux never invoked`. Exit 0 means no FAIL.
- Results are also written to `verify-results.json` in the repo root (no tokens, emails or env;
  home paths shown as `~`); share that file. `--keep` keeps the temp root for debugging.
- Ctrl-C is safe: it stops workflow runners, then the run's processes, then every actor and
  provider it started, and removes the temp root.

Dogfooding: `bun scripts/dogfood/run.ts spawn <task.md> [provider]` starts an implementer in a
worktree of this repo; `bun scripts/dogfood/run.ts watch <id>` supervises it until it reports
`DOGFOOD_COMPLETE` (with a commit), `DOGFOOD_BLOCKED: …`, or yields (example specs in
`scripts/dogfood/tasks/`).

### CI & releases

`.github/workflows/ci.yml` runs on every pull request and push to `main`: typecheck + `bun test`
on Linux and macOS, and `build.yml`, which builds `orc-<os>-<arch>` natively on four runners
(linux/darwin × x64/arm64) with `bun run compile:cli`, the same script as local builds, and the Bun
pinned in `.bun-version` (1.4.2). It smoke-tests each binary on the runner that built it
(`--version` matches `package.json`, `--help`, the codex harness self-test, no `.env` /
`bunfig.toml` autoload from the cwd) and uploads it as a workflow artifact. `nix.yml` checks the
[Nix](#nix) flake on the same events.

To cut a release, bump `version` in `package.json`, merge to `main`, then tag that commit:

```sh
git tag v0.2.0 && git push origin v0.2.0   # must be v<package.json version>
```

`release.yml` checks the tag against `package.json`, builds and smoke-tests the four binaries,
writes `SHA256SUMS`, attests build provenance and publishes the GitHub release with generated
notes and every asset (a tag with a `-`, e.g. `v0.2.0-rc.1`, is marked pre-release). If the run
fails before publishing, re-run it from the Actions tab or with `gh workflow run release.yml --ref v0.2.0`.

## Nix

Optional: `flake.nix` adds a dev shell and a pure build. Without Nix nothing changes: `bun install`,
`compile:cli` and the release binaries never use it. Systems: `x86_64-linux`, `aarch64-linux`,
`aarch64-darwin`. nixpkgs-unstable no longer supports `x86_64-darwin`, so on an Intel Mac use the
`orc-darwin-x64` [release binary](#install) or the Bun build.

```sh
nix develop               # bun (nixpkgs; 1.4.2 at this lock), git, jq, bash, nixfmt; procps on Linux
nix build                 # ./result/bin/orc, built by package.json's compile:cli
nix run . -- --version    # or from anywhere: nix run github:thehumanworks/orc -- --version
nix flake check           # orc, a smoke test (--version, --help, codex self-test), the typecheck
nix fmt                   # nixfmt (RFC style) on the .nix files
```

`flake.lock` pins nixpkgs; the only network access is a fixed-output `bun install --frozen-lockfile`
of `bun.lock` (the same `node_modules` as a plain `bun install`), whose hash is in
`nix/hashes.json`. The binary embeds nixpkgs' bun (on x86_64-linux its baseline build), so it is
not byte-identical to a release binary. `overlays.default` adds `pkgs.orc`. Nix takes bun from the
locked nixpkgs while CI uses `.bun-version`; both are 1.4.2 today, but nothing ties them together,
so after a `nix flake update` that moves bun, bump `.bun-version` to match (or pin it back).

**When `bun.lock` changes** (or a `nix flake update` brings a bun that installs differently), Nix
builds fail with `hash mismatch in fixed-output derivation` until the hash is refreshed. One hash
covers every system:

```sh
nix run .#update-deps-hash   # builds the dependencies and writes nix/hashes.json; commit it
```

Without Nix, copy the `got: sha256-…` value from the failing `nix` workflow into
`nix/hashes.json`. `.github/workflows/nix.yml` runs `nix flake check`, `nix build`, the binary and
the dev shell on Linux x64/arm64 and macOS arm64.

## Upgrading from the tmux runtime

The full list of user-visible and breaking changes, with schema migrations, is in
[`docs/CHANGES-actor-runtime.md`](docs/CHANGES-actor-runtime.md).

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
   - `list` shows `suspended` and `spawning`; `prune` keeps suspended sessions unless
     `--suspended` and taken-over ones unless `--taken-over`
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
   adds `suspended` and `spawning`, `SendResult` is `{phase, messageId, replayed}`, and `StepDoneCtx.capture` is
   journal text rather than a pane.

### Upgrading from the codex app-server runtime

codex no longer runs the `codex` CLI (`codex app-server`); it runs orc's built-in harness, and the
codex CLI is not needed. Sessions created by the app-server runtime show as `dead`, have no
transcript in `orc read` (their rollouts stay in `~/.codex/sessions`), and cannot be resumed;
`orc prune` removes them. `ORC_CODEX_BIN` is ignored. Sign in once with `orc login chatgpt` (or
reuse pi's login, or set `OPENAI_API_KEY`); `orc login status` shows which is used. `--agent`
still reads codex TOML agents. Takeover now prints a `pi --session …` command, so install pi
(1.2.0) if you want to continue codex sessions by hand.
