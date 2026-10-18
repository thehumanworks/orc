# orc — command & SDK reference

Read the orchestration playbook in `SKILL.md`. Consult `orc help` from the installed binary for
its supported commands and `orc <command> --help` for focused help.

Contents: [Sessions](#session-commands) · [Workflows](#workflows) · [Named agents](#named-agents) ·
[Providers](#providers) · [Removed-provider migration](#removed-provider-migration) ·
[Remote hosts](#daemon--remote-hosts) · [MCP](#mcp-server) ·
[Settings](#settings-orc_host-settingstoml---local) · [SDK](#sdk-typescript) · [Files](#state--files).

Conventions:

- Flags are parsed per subcommand and strictly (an unknown flag is an error). Every command except
  `help` takes `--json`. Help is local and available even when settings are invalid or the default
  remote host is offline: `orc help`, `orc --help`, `-h`, or `orc spawn --help`.
- Errors: exit 1; with `--json` the error is `{"error": "..."}` on **stdout** (option-parse
  errors too), otherwise `error: ...` on stderr (`fatal: ...` for an option-parse error).
- Global flags (before or after the subcommand): `--host <h>` / `--local` (see Settings) and
  `--color[=auto|always|never]` / `--no-color` (human output only; colour is on only for a TTY,
  `NO_COLOR` / `FORCE_COLOR` apply, `--json` is never coloured, and the colour flags are not read
  after a literal `--`). `orc --version [--json]` (alias `-V`) prints this binary's version and
  never goes remote.
- A session is addressed by short id, full session id, `@alias` (current workspace) or
  `@workspace:alias`. Aliases resolve only to active (running or suspended) sessions; use the id
  for dead ones.
- Prompt arguments: literal text, `-` (stdin) or `@path` (file). Multi-line text is delivered
  verbatim as one message. Text that starts with `-` goes after `--`
  (`orc send <id> -- "-v is broken"`).
- `orc send <id>` with **no** prompt argument reads stdin when stdin is not a terminal (it blocks
  until EOF; empty stdin is an error) and errors on a terminal. `orc spawn` never reads stdin
  implicitly: no `--prompt` means no initial prompt.
- Workspace of a session: `--workspace W`, else the git toplevel of its cwd, else the cwd. A
  `--worktree` session belongs to its parent repo's workspace, but a session spawned with
  `--cwd` **inside an existing linked worktree** gets that worktree's toplevel: plain `orc list` and
  `@alias` run from the main checkout won't see it. Pass `--workspace <repo>` (or use the id).

## Session commands

| command | flags | exit | `--json` |
| --- | --- | --- | --- |
| `orc spawn` (aliases `agent`, `new`) | see below | 0 / 1 | `SessionRecord` (`id`, `sessionId`, `provider`, `cwd`, `worktreePath?`, `branch?`, `workspace`, `alias?`, …) |
| `orc send <sel> [PROMPT\|-\|@file]` | `--idempotency-key K`, `--no-wake` | 0 acknowledged/queued, **3 unknown**, 1 failed/error | `{ok, id, phase, messageId, replayed}` |
| `orc read <sel>` | `--last` (default) \| `--index N` \| `--full` \| `--raw` | 0 / 1 | `Turn[]`; `--raw`: `{id, journal}`; no transcript yet: `{id, fallback: true, journal}` |
| `orc state <sel>` | — | 0 / 1 | `{id, state, status, stopped, suspended, live, pendingMessages, openTurn?, lastTurn?, stopReason?, legacy?}` |
| `orc wait <sel>` | `--for done\|waiting\|failed\|settled` (default settled), `--timeout SEC` (default 600) | 0 reached, 1 timeout/error | `{id, state, elapsedMs, timedOut}` |
| `orc list` (alias `ps`) | `--workspace W`, `--all`, `--dead`, `--all-hosts`, `--run ID`, `--lineage` | 0 / 1 | records + `status` + `state` (+ `lineage`; `host` with `--all-hosts`) |
| `orc attach <sel>` | — | 0 when the session stops/suspends or Ctrl-C; 1 no runtime state | `{id, command, journalPath}` (no follow) |
| `orc kill <sel>` | `--worktree`, `--purge` | 0 / 1 | `{ok, id, purged}` |
| `orc resume <sel>` | — | 0 / 1 | same as `state --json` |
| `orc takeover <sel>` | — | 0 / 1 | `{id, cwd, command, note?}` |
| `orc prune` | `--worktree`, `--suspended`, `--taken-over` | 0 / 1 | `{ok, pruned: [ids]}` |
| `orc settings` | — | 0 / 1 (bad settings file; an invalid `ORC_HOST` is a `host.note`) | `{cwd, root, nested, host, provider, models: {claude, pi}, files, warnings}`; each value `{value, source: flag\|env\|local\|global\|default, from?, note?}` |

### spawn options

- `--provider, -p claude|pi` (required unless settings set `provider`); `--model, -m <name>`
  (default: settings `[models].<provider>` unless `--agent`, otherwise the provider's own).
  For Pi/OpenAI use an exact qualified model such as `openai/gpt-5.5`; see Providers.
- `--agent <name>` — named agent definition (exclusive with `--system-prompt`)
- `--alias <name>` — workspace-scoped handle; never changes agent behaviour
- `--system-prompt <txt>`, `--system-prompt-mode append|replace` (default append)
- `--prompt <txt|-|@file>` — initial prompt, sent once the provider is ready. Omitted = none
- `--cwd <dir>` (default: cwd), `--workspace <w>` (default: git toplevel of cwd)
- `--worktree [--branch <b>]` — fresh git worktree as cwd (`<repo>/.orc/worktrees/<id>`, branch
  `orc/<label>/<id>`); requires a git repo
- `--no-wait` — return once the actor has started; the initial prompt is queued and delivered when
  ready

Without `--no-wait`, spawn returns after the provider is ready (≤ 60 s) and the initial prompt was
sent. A spawn that fails before ready leaves nothing behind (record, session dir, worktree).

### send

| phase | meaning | exit |
| --- | --- | --- |
| `acknowledged` | the provider accepted the turn | 0 |
| `queued` | durably in the inbox; not acked within 10 s (busy turn, waking, or `--no-wake`); delivered later | 0 |
| `unknown` | cut before the provider acked it (crash/stop); **never re-sent by orc** | 3 |
| `failed` | failed before any ack, or dropped because the session was stopped | 1 |

- `--idempotency-key K` sets the message id (letters/digits first, then `._-`, ≤ 128). Same K +
  same text → `replayed: true`, nothing new is sent. Same K + different text → error.
- A suspended session is woken first (unless `--no-wake`). A killed or taken-over session refuses
  with an error that names `orc resume`.
- On exit 3: inspect `orc read <sel>` and any external effects. Absence of a reply does not prove
  the instruction was never executed. Issue a new instruction with a **new** key only after
  resolving that uncertainty or deliberately accepting its consequences.

### state and status

`state` (from the journal): `starting` (provider initialising) · `running` (turn open or message
queued) · `done` (yielded; ready for input — not "succeeded") · `waiting` (permission request; orc
denies it) · `failed` (last turn failed, or not live). An interrupted last turn is `done`.

`status` (is there an actor): `running` (live lease) · `suspended` (actor gone without a stop;
resumable; the next send wakes it) · `spawning` (just reserved by a spawn; `state` reads
`starting`) · `dead` (killed, taken over, historical Codex/tmux record, or no
runtime state; sticky). Taken-over sessions are `dead` with `stoppedBy: "takeover"` on the record.

| `state --json` | means |
| --- | --- |
| `state: failed, stopped: true` | killed / taken over (`status: dead`); `orc resume` for retained Pi/Claude sessions; migrate historical Codex records |
| `state: failed, suspended: true` | crash / reboot / provider exit (`status: suspended`); `orc send` or `orc resume` wakes it |
| `state: failed, live: true` | the last turn failed: `lastTurn.error` |
| `lastTurn` | `{messageId, outcome: completed\|failed\|interrupted, at?, error?, reason?, result?}` |
| `openTurn` | `{messageId, intentAt, startedAt?}` while a turn is open |

`wait` returns on the first observation in the `--for` set (no debounce). On timeout it prints the
last state and exits 1. After 3 consecutive failed starts a session is no longer auto-woken
(`send` returns `queued`) until `orc resume`.

### read, attach, takeover, kill, prune, list

- `read`: default = latest parsed turn of the provider transcript (conversation + one-line tool
  summaries); `--full` all turns; `--index N` zero-based turn; `--raw` the session journal (JSONL;
  not combinable with the others). No transcript yet → the journal rendered as text (stderr note).
- `attach`: follows the journal as text until the session stops/suspends or Ctrl-C. Read-only
  (`--read-only` is accepted and ignored).
- `takeover`: stops the actor (sticky), waits for the provider to exit, prints
  `cd <cwd> && <provider resume command>`. Retained Pi/Claude sessions can be handed back with
  `orc resume <id>`. Historical Codex harness sessions can continue in native Pi only; see
  Removed-provider migration.
- `kill`: sticky stop; drops queued messages; keeps the record and journal (`read` still works).
  `--purge` removes the record and session dir; `--worktree` removes the worktree (not the branch).
- `prune`: removes `dead` records and their session dirs. Keeps `running` and `spawning` (< 10
  min); keeps `suspended` unless `--suspended` (stopped first, under the session lock, so a racing
  `orc resume` either wins or finds nothing); keeps taken-over sessions unless `--taken-over` (the
  human's resume command uses their system prompt file).
- `list`: default = current workspace, `running` + `suspended` + `spawning`. `--all` = every
  workspace incl. dead; `--dead` adds dead; `--run ID` = sessions of a run tree (implies `--all`).
  Use the full/short ID for stopped or historical records, since aliases resolve active sessions.

## Workflows

| command | notes |
| --- | --- |
| `orc workflow run <file.ts> [--detach] [--json] [--max-concurrency N]` | foreground streams events; exit 0 iff the run is `done` (143 if the runner got SIGTERM). `--detach`: returns the runId at once (`--json` `{runId, logPath}`), output in `~/.orc/runs/<runId>/runner.log` |
| `orc workflow list [--json]` | runs, newest first |
| `orc workflow status <runId> [--json]` | per-step state + attempts; a `running` run whose owner died → `orphaned` |
| `orc workflow attach <runId> [--json]` | follow a `--detach` run's runner.log until it ends; `--json` `{runId, logPath, runner}` |
| `orc workflow logs <runId> [--step id] [--raw] [--json]` | parsed transcript per step; `--raw` each step session's last 200 journal entries; `--json` `{step, turns}[]` / `{step, provider, journal}[]` |
| `orc workflow resume <runId> <file> [--detach] [--json]` | skips successes, adopts in-flight steps whose instruction reached a resumable session. `<file>` required locally (over `--host`: defaults to the run's recorded file). `--detach --json`: `{runId, logPath, action: "resume"}` |
| `orc workflow retry <runId> [--step id] <file> [--detach] [--json]` | new attempts for failed/incomplete steps (or `--step` and its descendants); history kept. `<file>` as for resume. `--detach --json`: `{runId, logPath, action: "retry"}` |
| `orc workflow cancel <runId> [--cascade] [--json]` | idempotent; `--cascade` kills only sessions owned by the run |
| `orc workflow cleanup <runId> [--sessions] [--worktrees] [--json]` | removes owned sessions/worktrees only |

- Run status: `running | done | failed | orphaned | cancelled`. Attempt phases:
  `queued|spawning|dispatched|running|verifying|succeeded|failed|waiting|cancelled|abandoned`
  (+ `blocked`, `skipped` from the scheduler).
- A `WorkflowDef` is a plain default-exported `{ name, steps[], maxConcurrency?, policy? }`
  (no import needed). Step success: `done(ctx)` predicate, portable `verify` descriptor, or — for a
  `worktree` step with neither — `state === 'done' && commitsAhead >= 1`. A bare yield is
  `unverified` and fails unless `allowUnverified: true`. See `assets/workflow-template.ts`.
- `ExecutionPolicy`: `maxDepth`, `maxSessions`, `maxConcurrentSessions` (live actors), `deadlineMs`,
  `canDelegate`; fail-closed. Token/cost budgets are not enforced.
- Step sessions stay alive after the run; `cleanup --sessions --worktrees` when done.
- A step whose session a human took over is never relaunched by `resume`: the attempt fails as
  `taken_over`; `orc resume <id>`, then `orc workflow retry <runId> --step <id>`.
- Each attempt transition is emitted once, forward only.

## Named agents

`orc spawn --agent <name>` resolves a definition:

- **claude**: native `--agent` — `./.claude/agents/<name>.md` then `~/.claude/agents/<name>.md`
- **pi**: the Claude Markdown locations; ORC passes the body as its system prompt. Claude-specific
  frontmatter model aliases do not apply. Pass `--model` or use Pi's configured default;
  `--agent` bypasses the ordinary ORC `[models]` fallback.

Move former Codex TOML `developer_instructions` or prompt bodies into these Markdown files.
ORC no longer discovers `.codex/agents`, `.codex/prompts` or `CODEX_HOME` for new sessions.

## Providers

Use only `pi` and `claude` as new ORC execution providers. Both use their native CLI: Claude
stream-json with `--permission-mode bypassPermissions`; Pi RPC with `-a`. Pi owns its model/tool
loop, compaction, model discovery and authentication. ORC owns detached actors, delivery receipts
and workflow durability. ORC removes the embedded Codex harness and does not add pi-durable.

For OpenAI/Codex models through Pi (reference CLI version **1.2.0**):

1. Install Pi on the execution host (Node >=22.19.0 for npm). `npm install --global --ignore-scripts
   @earendil-works/pi-coding-agent@1.2.0` pins the CLI package, not its transitive dependencies;
   use a lockfile or the corresponding pinned upstream release artifacts for reproducibility.
2. Launch `pi` interactively, run `/login openai`, and choose **Sign in with ChatGPT**, or export
   `OPENAI_API_KEY` where the actor runs. Pi's stored credential takes precedence over the
   environment key; use Pi `/logout` to remove it when switching to the key. ORC does not import
   its old credentials or refresh them.
3. List chat models with `pi --list-models` and use, for example,
   `orc spawn -p pi -m openai/gpt-5.5 --prompt "reply READY"`.

Qualified `provider/model-id[:thinking]` selections bind Pi's provider explicitly. ORC checks the
selected identity and Pi's available model list before dispatch; configure custom IDs in Pi's
`models.json`. The list establishes configured authentication, not live account entitlement.
Bare aliases keep Pi's resolution; no override uses Pi's own default. Pi `openai-codex` is a
distinct legacy backend/auth route, never an automatic alias for `openai`.

System prompts go through an ORC-owned file, never prompt text on argv or a file in the worktree.
Claude `/compact` and `/goal <condition>` work through `orc send` (verified, Claude 2.1.300);
interactive pickers and `/login` do not. Pi slash commands through ORC remain unverified.

## Removed-provider migration

- Treat new `provider: "codex"`, `provider = "codex"` and `[models].codex` as actionable errors.
  Change callers/settings/workflow definitions to `pi` and an explicit `openai/<model-id>`.
  `orc login`, `orc login status` and `orc logout` are removed-command errors; authenticate in Pi.
- Preserve existing records, journals, transcripts and credentials. Historical Codex sessions
  still support `orc read --full` / `--raw` and `orc kill`; `send` and `resume` refuse them.
- For a matching harness Pi v3 transcript, `orc takeover <id>` stops the old actor/provider,
  validates its identity and prints `pi --session <file> --provider openai --model <saved-model>`
  with the original cwd and system-prompt file/mode. Restore a missing persona file before retrying.
  Continue in native Pi; the historical ORC session cannot be handed back to ORC. Use a reviewed
  summary in a fresh Pi session when metadata/transcript compatibility prevents native continuation.
- Older Codex app-server rollouts remain under `~/.codex/sessions`; there is no Pi importer.
  Do not rewrite stored provider fields or automatically replay queued/uncertain deliveries.
- Existing Codex workflow plans and attempts remain readable, but cannot resume through the
  removed harness. Inspect status/logs, preserve verified outputs, migrate the source definition,
  then start a new run for unfinished work. Do not edit stored plans to bypass their digest check.
- Keep ORC's existing session/workflow storage: pi-durable was evaluated and skipped because its
  embedded model/tool harness does not replace retained Pi RPC/Claude ownership or delivery semantics.

Full instructions and evidence: [migration guide](https://github.com/thehumanworks/orc/blob/main/docs/MIGRATION-pi.md)
and [durability decision](https://github.com/thehumanworks/orc/blob/main/docs/decisions/pi-durable.md).

## Daemon & remote hosts

| command | purpose |
| --- | --- |
| `orc daemon [--port 8787] [--bind <ip>] [--insecure]` | HTTP API on the host's tailscale IP; refuses `0.0.0.0` without `--insecure` |
| `orc remote add\|list\|rm <host> [--port P]` | trusted peers (`~/.orc/peers.json`) |
| `orc --host <h> <command>` | `list`/`spawn`/`send`/`read`/`wait`/`state`/`kill`/`workflow` against a peer, with local output and `--json` except: `state --json` is only `{id, state, status, suspended, stopped}`; `list` takes only `--workspace`/`--all`/`--dead` and its rows have no `lineage`; `workflow resume`/`retry` take no `--detach`. `attach` / `workflow attach` print `tailscale ssh <h> orc attach <id>` / `… orc workflow attach <runId>`. `resume`/`takeover`/`prune`/`daemon`/`remote`/`settings` are host-local (error). A default host (`ORC_HOST`, settings `host`) routes the same commands — see Settings |
| `orc list --all-hosts` | local + every peer, with a `host` column; an unreachable peer is a stderr warning |

Auth is fail-closed: allowlisted tailnet identity (all scopes), `Authorization: Bearer` (client
`ORC_DAEMON_TOKEN`; server `ORC_DAEMON_TOKENS` JSON token→scopes), or legacy `x-orc-secret` =
`ORC_DAEMON_SECRET`. 401 = no/invalid credentials; 403 = missing scope (`sessions:read|write`,
`workflows:read|write`, `admin`). `GET /health` → `{ok, version, host, api: 2, mcp: "/mcp"}`.

Other daemon errors (`{"error"}`): 400 invalid request · 403 execution policy forbids a spawn/wake
· 404 unknown session or run · 409 stopped session (`orc resume` first), idempotency-key conflict,
legacy session, or run state (cancelled / live owner) · 502 provider failed to start · 500 other.
`--host` also works against a v1 (pre-actor) daemon (`submitted` send = success; `pane` reads).

## MCP server

| command | purpose |
| --- | --- |
| `orc mcp [--wait-timeout SEC]` | MCP over stdio (host-local). Tools: `guide spawn send wait read state list kill resume prune settings workflow_run workflow_list workflow_status workflow_logs workflow_resume workflow_retry workflow_cancel workflow_cleanup`; each runs `orc <cmd> … --json` (spawn `--no-wait`, workflow run/resume/retry `--detach`) and returns its JSON. `host` on remote-capable tools = `--host`. `wait` returns within SEC (default 45) |
| `orc daemon [--mcp-allow-host H]…` | also serves the tools at `/mcp` (Streamable HTTP, stateless), run on the daemon host (`--local`; absolute paths; no `host`). Same auth; each tool needs its REST scope (`wait`/`read`/`state`/`list`/`settings`: `sessions:read`; `spawn`/`send`/`resume`: `sessions:write`; workflow reads/writes: `workflows:read`/`workflows:write`; `kill`/`prune`/`workflow_cancel`/`workflow_cleanup`: `admin`). `tools/list` shows only allowed tools. `Host`/`Origin` must name the daemon (403 otherwise) |

The server instructions and the `guide` tool teach the lead the team method; not exposed:
`attach`, `workflow attach`, `takeover`, `daemon`, `remote`, `mcp`, `help`.
Daemon credentials (`ORC_DAEMON_SECRET`/`ORC_DAEMON_TOKENS`/`ORC_DAEMON_TOKEN`) never reach the
CLI children, except the client ones on an explicit `host` call.

## Settings: `ORC_HOST`, `settings.toml`, `--local`

```toml
host = "studio"        # default remote target: host or host:port (as --host)
provider = "pi"        # default spawn --provider
[models]               # default --model per provider (spawn + workflow steps)
pi = "openai/gpt-5.5"
claude = "haiku"
```

- Global `$ORC_HOME/settings.toml`; local = the **nearest** `<dir>/.orc/settings.toml` from the
  current directory's realpath (not `--cwd`) up to the git toplevel (nearest dir holding `.git`);
  outside a repo the cwd only. One local file; a local candidate that is the global file is
  skipped. Local beats global per key (`[models]` per provider).
- Unknown keys/tables: one stderr warning per file (`orc: warning: <file>: unknown setting(s)
  ignored: …`). Bad types/values or bad TOML: exit 1 naming the file and key. An invalid
  `ORC_HOST` refuses only commands it would route (not with `--local`/`--host`).
- The removed `provider = "codex"` and `[models].codex` fail explicitly; they are not ignored
  keys or automatic mappings. Change them using Removed-provider migration.

| key | precedence (first wins) |
| --- | --- |
| host | `--local` > `--host` > `ORC_HOST` (set, non-empty; `""` = no default host) > local > global > run here |
| provider | `--provider` > local > global > error |
| model | `--model` > local `[models].<p>` > global `[models].<p>` > provider default; `--agent` bypasses `[models]` (Claude native agent model, Pi explicit model or native default) |

- A default host applies to `list`/`spawn`/`send`/`read`/`wait`/`state`/`kill`/`attach`/`workflow`
  (not `list --all-hosts`) and prints `orc: → <host> (from ORC_HOST|<file>)` on **stderr** (also
  with `--json`). Host-local commands (`daemon`, `remote`, `resume`, `takeover`, `prune`,
  `settings`, `help`) ignore it and never error because of it; explicit `--host` on them
  stays an error. `--local` may appear anywhere in argv.
- **Safety rules.** (1) A `host` from a LOCAL file must be a trusted peer (`orc remote add`; host +
  port, default 8787) or your own global settings `host`, or the command fails: `orc remote add
  <host>`, `--local` or `--host`.
  `ORC_HOST`, `--host` and the global file are not restricted. (2) Inside an orc session (env has
  `ORC_PARENT_SESSION_ID`, or `ORC_DEPTH` ≥ 1 — every agent orc spawns does) `ORC_HOST` and
  settings `host` are ignored: a subagent's `orc` runs on its own host unless it passes `--host`.
  provider/model defaults still apply. (3) `ORC_HOST` is stripped from actor and provider env.
  (4) Detached workflow runners always run with `--local`.
- spawn defaults resolve client-side and are sent explicitly (also over `--host`). Local workflow
  runs fix `defaultModels` at start (recorded on the run); `resume`/`retry` and detached runners use
  the record, never settings. Over `--host` the daemon applies no `[models]` (also `--detach`).
- SDK: `loadSettings({cwd, env, fs})` → effective values + sources; `agent()`/`runWorkflow()` read
  no settings (pass `model` / `defaultModels` explicitly).

## SDK (TypeScript)

```ts
import { agent, getSession, listSessions, runWorkflow } from 'orc';

const s = await agent({ provider: 'claude', worktree: true, prompt: 'reply READY' });
await s.waitFor({ until: ['done'], timeoutMs: 120_000 });   // returns the AgentState
const d = await s.stateDetail();                              // same shape as `orc state --json`
const r = await s.send('next step', { messageId: 'k2' });    // {phase, messageId, replayed}
console.log(await s.readParsed());                            // Turn[]
console.log(s.journal({ tail: 50 }));                         // JournalEntry[]
await s.kill({ removeWorktree: true });
```

`waitForResult()` adds `settled`; `send()` throws `SessionNotControllableError` (`code`
`ORC_SESSION_STOPPED` | `ORC_MESSAGE_CONFLICT` | `ORC_SESSION_LEGACY` | `ORC_SESSION_UNKNOWN`).
Removed-provider errors also carry `ORC_SESSION_LEGACY` and migration instructions.
Also: `interrupt()`, `takeover()`, `resume()`, `attach({signal})`,
`pruneSessions({suspended, takenOver})`. `SessionStatus` = `running|suspended|spawning|dead`.
Use the SDK when orchestration logic is non-trivial or reused (loops, fan-out, branching); use the
CLI for quick steering.

## State & files

- Everything lives under `~/.orc` (`ORC_HOME` overrides — use a temp dir for throwaway experiments;
  its `settings.toml` comes with it).
  Owner-only: dirs 0700, files 0600.
- `~/.orc/sessions/<sid>/journal.jsonl` is the source of truth for state (`read --raw`, `attach`);
  the provider transcript (what `read` parses) persists after `kill`.
- `~/.orc/runs/<runId>.json` holds the run record, including step prompts.
- Pi owns its auth/settings directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`). ORC
  does not read the old `ORC_AUTH_DIR` or `ORC_CODEX_*` harness settings.
- Historical Codex `~/.orc/auth/chatgpt.json`, device identity, model cache and
  `~/.orc/sessions/<sid>/codex-session.jsonl` remain on disk untouched by this migration.
