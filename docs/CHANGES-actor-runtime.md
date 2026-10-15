# Changes: the actor runtime (`feat/actor-runtime` vs `main` @ 2795c34)

orc no longer uses tmux. Every session is a detached **actor process** that drives its provider
over a structured protocol, with a durable inbox and an append-only journal. codex is now orc's
**built-in harness** on the OpenAI Responses API instead of the `codex` CLI.

Design and rationale: [`DESIGN-runtime.md`](DESIGN-runtime.md) (§7 lists what the build added).
Current behaviour: [`../README.md`](../README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Prerequisites

| | before | now |
| --- | --- | --- |
| tmux | required | **not used** |
| claude | `claude` CLI | `claude` CLI (verified 2.1.300; `ORC_CLAUDE_BIN` overrides) |
| codex | `codex` CLI | **no CLI**: an OpenAI credential — `orc login chatgpt`, pi's ChatGPT login, or `OPENAI_API_KEY` |
| pi | `pi` CLI | `pi` CLI (verified 1.2.0); also needed to continue a codex session after `orc takeover` |
| runtime deps | none | `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, pinned to 1.2.0 (codex harness) |
| Bun | ≥ 1.3 | ≥ 1.3 (unchanged) |

## User-visible changes

### Added

- `orc resume <id>`: hand a killed, taken-over or suspended session back to an actor.
- `orc takeover <id>`: stop orc's actor and print the provider's own resume command
  (`--json`: `{id, cwd, command, note?}`).
- `orc login chatgpt [--import-pi] [--no-browser]`, `orc login status [--json]`,
  `orc logout chatgpt` (codex credentials).
- `orc send --no-wake`; `send` exit code **3** for delivery `unknown`.
- `orc prune --suspended` and `--taken-over`.
- Session status `suspended` (actor gone without a stop; the next send wakes it) and `spawning`
  (spawn in progress).
- `orc attach` follows the session journal live (read-only).
- `bun run verify:live` (`scripts/verify-runtime/all.ts`) and `bun run check:compile`.

### Changed

- **State comes from the journal**, not screen scraping: `orc wait` returns on the first matching
  observation (no two-poll debounce). `waiting` means a permission request (rare in yolo mode).
  `failed` also covers a session that is not live; `orc state --json` says `stopped` or
  `suspended`.
- **Durable, idempotent send.** Messages persist in the session inbox; `--idempotency-key` is checked
  against the journal. Phases: `acknowledged | queued | unknown | failed`.
- **Kill is sticky** (never auto-wakes) and keeps the record and journal; queued messages are
  dropped.
- **`spawn --no-wait`** queues the initial prompt instead of skipping it.
- **Prune** keeps `running`, `spawning`, `suspended` (unless `--suspended`) and taken-over sessions
  (unless `--taken-over`); every removal is decided under the session lock, so it cannot race a
  resume.
- **codex**: runs `orc __codex-harness` (pi-ai + pi-agent-core → `https://api.openai.com/v1/responses`).
  Tools `read/write/edit/bash/ls`; default model = the first model the account lists (API key: the
  newest chat model pi-ai knows), recorded on the session; transcript
  `~/.orc/sessions/<sid>/codex-session.jsonl` (pi session format); takeover prints
  `cd <cwd> && pi --session <file>`; `--system-prompt-mode replace` now works for codex.
- **claude** runs `-p` stream-json with `--permission-mode bypassPermissions` (was
  `--dangerously-skip-permissions`); `/compact` and `/goal` work through `orc send` (verified).
- **pi** runs `--mode rpc -a`.
- **Detached workflow runners** are plain processes logging to `~/.orc/runs/<runId>/runner.log`;
  `orc workflow attach` follows that log.
- **Workflows**: a step whose session a human took over is never relaunched by `resume` (attempt
  fails `taken_over`); attempt transition events are emitted once, forward only;
  `StepDoneCtx.capture` is journal text (last reply + final turn), not a pane.
- **Daemon** `api: 2`; errors map to 400/403/404/409/502 (was mostly 500); `--host` still talks to
  v1 daemons.
- **Privacy**: everything under `~/.orc` is owner-only (0700 dirs, 0600 files).
- **Locks** whose owner process is gone are reclaimed at once (was: after 5 minutes).

### Removed

- tmux driver, pane capture, `orc read --raw` as a pane (it is now the journal), `orc attach` as
  `tmux attach`, `orc-wf-<runId>` tmux runners.
- The `codex app-server` runtime and `ORC_CODEX_BIN`.
- `~/.orc/messages/` delivery records (idempotency lives in the journal); codex `instructions.md`
  persona files.

## Breaking changes for scripts (CLI `--json`)

| command | before | now |
| --- | --- | --- |
| `read --raw --json` | `{id, pane}` | `{id, journal}`; fallback `{id, fallback: true, journal}` |
| `state --json` | `{id, state}` | `{id, state, status, stopped, suspended, live, pendingMessages, openTurn?, lastTurn?, stopReason?}` |
| `send` | exit 0/1 | exit 0 acknowledged/queued, **3 unknown**, 1 failed; `{ok, id, phase, messageId, replayed}` |
| `list` | statuses `running`/`dead` | `running`/`suspended`/`spawning`/`dead` |
| `attach --json` | tmux attach command | `{id, command: "orc attach <id>", journalPath}` |
| `workflow run --detach --json` | `{runId, runnerTmux}` | `{runId, logPath}` |
| `workflow logs --raw --json` | `{step, provider, pane}[]` | `{step, provider, journal}[]` |
| `workflow attach` | printed a tmux command | follows `runner.log` until the run ends |
| `workflow resume/retry` | file optional | `<file>` required locally (over `--host`: the run's recorded file) |
| `resume`, `takeover`, `prune`, `daemon`, `remote` | — | host-local: error under `--host` |

## Breaking changes for SDK users (`src/index.ts`)

- **Removed exports**: `classifyState`, `reduceWait`, `StateMatchers`, `WaitTracking`,
  `runnerTmuxName`, `PaneInfo`, `DeliveryRecord`, `hashPayload`, `evaluateDeliveryReplay`,
  `readDelivery`, `persistDelivery`.
- **Removed members/options**: `Session.tmuxName`, `Session.capture()`, `AgentOptions.driver`,
  `pruneSessions({driver})`, the `Session` constructor's driver argument.
- **Changed**: `SessionStatus` = `running | suspended | spawning | dead`; `SendOptions` =
  `{messageId, wake, ackTimeoutMs}`; `SendResult` = `{phase, messageId, replayed}`;
  `Session.attach()` follows the journal and resolves an exit code; `attachCommand()` returns
  `orc attach <id>`; `listSessions` hides dead, shows suspended/spawning; `WorkflowRun.runnerTmux` →
  `runner {pid, startTime, logPath, startedAt}`; `WORKFLOW_SCHEMA_VERSION` 4 → 5;
  `SessionRecord.transcriptSessionId` → `providerSessionId`, `instructionsPath` → `systemPromptPath`.
- **Added**: `Session.takeover()`, `resume()`, `journal()`, `journalPath()`, `stateDetail()`,
  `interrupt()`, `awaitReady()`; `AgentOptions.readyTimeoutMs`; `pruneSessions({suspended,
  takenOver})`; `SessionNotControllableError` (codes `ORC_SESSION_STOPPED`, `ORC_MESSAGE_CONFLICT`,
  `ORC_SESSION_LEGACY`, `ORC_SESSION_UNKNOWN`); journal renderers (`renderJournal`,
  `renderJournalEntry`, `renderCapture`, `lastAssistantText`); `nativeResumeCommand`;
  `sessionStatusOf`, `countLiveSessions`, `LivenessProbe`; detached-runner helpers
  (`launchDetachedRun`, `launchDetachedRecovery`, `followRunnerLog`, `runnerLogPath`, …).

## Schema and on-disk migrations

All migrations happen on read; nothing needs to be run.

- **Registry** (`~/.orc/registry.json`): a record with `tmuxName` and no `runtime` becomes
  `{legacy: "tmux", status: "dead", legacyTmuxName}` — readable and prunable, never controlled.
  `instructionsPath` → `systemPromptPath`, `transcriptSessionId` → `providerSessionId`; the next
  write persists the new shape. New records carry `runtime: "actor"`.
- **Workflow runs** (`~/.orc/runs/<runId>.json`): schema 4 → 5. A `runnerTmux` (top level or on the
  lease) becomes the read-only `legacyRunnerTmux` marker (never persisted): such a run reconciles
  to `orphaned` and can be resumed. Leases carry the owner's `startTime`.
- **Sessions**: new per-session state under `~/.orc/sessions/<sid>/` (`spawn.json`, `state.json`,
  `journal.jsonl`, `inbox/`, `provider.jsonl`, `actor.log`, `system-prompt.md`, codex
  `codex-session.jsonl`). codex sessions from the app-server runtime (provider session id ≠ orc
  session id) are `dead`, show no transcript and refuse resume.
- **New**: `~/.orc/auth/` (codex login; `ORC_AUTH_DIR`), `~/.orc/cache/codex-models.json`.
- **Permissions**: files and dirs under `~/.orc` are tightened to 0600/0700 the next time orc writes
  them.

## Upgrade steps

1. Before upgrading, kill live sessions with the **old** binary (`orc kill <id>`), or
   `tmux kill-session -t <name>`. Old sessions otherwise keep their tmux panes and provider
   processes running; after the upgrade they read as `dead` (`legacy: "tmux"`).
2. Install the new build: `bun install` (pulls the pinned pi-ai / pi-agent-core), then `bun link`
   or `bun run install:cli`.
3. For codex: `orc login chatgpt` (or keep pi's ChatGPT login, or set `OPENAI_API_KEY`); check with
   `orc login status`. The `codex` CLI and `ORC_CODEX_BIN` are no longer used.
4. Clean up: `orc prune` (drops legacy and dead records); optionally delete `~/.orc/messages/`.
   One-off privacy fix for old state: `chmod -R go-rwx ~/.orc`.
5. Update scripts for the JSON and exit-code changes above (notably `send` exit 3, `read --raw`
   → `journal`, `list` statuses, `workflow resume/retry <file>`).
6. Daemon fleets: upgrade every host; `GET /health` → `api` tells versions apart (a v2 client still
   reads v1 answers).
7. Verify on the host: `bun scripts/verify-runtime/all.ts --claude-model haiku` (README →
   "Live verification on a Mac").

## Known limitations

- codex has **no context compaction** yet: a conversation that outgrows the model's context window
  fails the turn ("…start a new session").
- codex has no slash commands; claude's `/compact` and `/goal` are verified, pi's are not.
- There is no live, typeable TUI; use `orc attach` (read-only) or `orc takeover` → `orc resume`.
- Sign in with ChatGPT is an OpenAI program: plan usage is offered to open-source projects and
  personal projects that run locally
  ([OpenAI guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)); otherwise
  use `OPENAI_API_KEY`.
- Not verified live in the build environment (no OpenAI account there): codex against a real
  Sign in with ChatGPT token and the real token-refresh endpoint; offline fake-server tests and
  `check:compile` pass. Run `verify:live` on an authenticated Mac to cover the codex and pi rows.
