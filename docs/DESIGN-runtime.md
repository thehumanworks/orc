# Design: tmux-free agent runtime — durable session actors over structured provider protocols

Status: **implemented (2026-10-15)**; proposed and judge-reviewed 2026-10-14. Supersedes the tmux
driver decision in `RESEARCH.md` §F.16c and the old `Driver` section of `ARCHITECTURE.md`.
§1–6 are the decision record as reviewed; §7 lists where the build differs and what it added.

## 1. Goal and constraints

- Remove tmux **completely** (no opt-in driver kept).
- Self-contained: everything ships inside the `orc` binary (`bun build --compile`); the only
  external executables are the provider CLIs (`claude`, `codex`, `pi`).
- More reliable and suited to agentic work: **agents hold the reins**. A human needing to type
  into a subagent is a smell, so live interactive TUI attach is *not* a requirement. Humans and
  agents still get full observability.
- Hosts: macOS (arm64) + Linux. No Windows.

## 2. Why the current design is fragile

tmux supplies seven capabilities (PTY, screen capture, input, persistence, liveness, attach,
runner hosting). The reliability problems come from one: **state is inferred by regex-matching
the rendered screen** (`state.ts` `classifyState`; provider `readyMatch` / `busyMatch` /
`trustDialogMatch` / `interstitialMatch` / paste-chip probes; `C-u` clears; 200×50 pinning so
status lines don't wrap). Every provider release can break a matcher, and both CLIs ship
near-daily (claude 2.1.299, codex 0.162.1 today). Delivery acks are heuristic, codex
transcripts are found by cwd+mtime search, and one tmux server crash takes every session down.

## 3. Options considered

| Option | What it is | Verdict |
|---|---|---|
| **A. PTY holder** (zmx/dtach-style process owning `Bun.Terminal` + `@xterm/headless`) | 1:1 tmux replacement; keeps TUIs + screen scraping | Prototyped and works on Linux (screen parity with tmux, survives launcher), but **keeps the fragility** and adds edges: Bun never sets a controlling tty (needs a `bun:ffi` `setsid`+`TIOCSCTTY` shim, unverified on macOS), VT width tables, doubled terminal-query replies. Solves the dependency, not the reliability. |
| **B. Adopt a durable framework** (Rivet Actors, Vercel Workflow SDK, pi-durable, Restate/Temporal/DBOS/Inngest/Absurd) | Framework owns durability | None keeps a *foreign* process alive past its parent. Rivet 2.3 needs a separate ~98 MB engine binary + native addon; Workflow SDK needs a compiler step + HTTP routes and its local world is dev-only (in-memory queue); DBOS/Absurd need Postgres; Restate/Temporal/Inngest are servers; pi-durable is an experimental LLM harness with breaking minors. None fits one offline binary. |
| **C. Structured protocols + orc-native durable actors** *(chosen)* | Drive each CLI over its machine protocol from a small per-session actor with a durable mailbox + journal | Removes screen scraping (explicit turn-complete events, real interrupts, explicit acks), needs **no PTY**, zero new runtime deps (`Bun.spawn` pipes, `node:fs`). Borrows the *ideas* of the three inspirations: actor + mailbox + hibernation (Rivet/Durable Objects), journal of facts (Workflow SDK event log), effect sandwich (pi-durable). |

## 4. Decision

### 4.1 Control plane: one structured protocol per provider

| | claude | codex | pi |
|---|---|---|---|
| Process | `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages` | `codex app-server` (JSON-RPC 2.0, JSONL/stdio; `initialize` → `initialized` first) | `pi --mode rpc` |
| Yolo | `--permission-mode bypassPermissions` | `thread/start {approvalPolicy:"never", sandbox:"danger-full-access"}` | default (no approvals) + `-a` |
| System prompt | `--append-system-prompt-file` / `--system-prompt-file` (file-backed; hidden from `--help` in 2.1.299, asserted by the contract test) | `developerInstructions` / `baseInstructions` (file read by orc, sent over stdio) | `--append-system-prompt <file>` / `--system-prompt <file>` (a path is read as a file) |
| Agent def | `--agent <name>` (validated in print mode) | resolved body → `developerInstructions` (as today) | resolved body → append (as today) |
| Session id | orc-chosen `--session-id` | server-assigned `thread.id`; `thread.path` = rollout file | orc-chosen `--session-id` + `--session-dir` |
| Send | `user` line on stdin | `turn/start` | `prompt` |
| Ack (`turn.started`) | `command_lifecycle{state:"started"}` for our `uuid` (5–95 ms; replay echo is the fallback) | `turn/start` response (`clientUserMessageId` = messageId) | `prompt` response |
| Turn complete | `result` (outcome from `subtype`/`is_error`/`terminal_reason` only) | `turn/completed` (status completed/failed/interrupted) | `agent_settled` (`aborted` flag) |
| Interrupt | `control_request {subtype:"interrupt"}` | `turn/interrupt {threadId, turnId}` | `abort` (resolves after settle) |
| Ready | `initialize` control_response (no `system/init` until the first user line) | `thread/start` / `thread/resume` response | `get_state` response |
| Resume | `--resume <sid>` (never with `--session-id`; only after ≥1 completed turn) | `thread/resume` (only after ≥1 turn — "no rollout found" otherwise) | same flags + same cwd (`--session-id`); empty resumed session is an error |

Rules:
- Raw protocols with small vendored, version-pinned wire types (codex: generated by
  `codex app-server generate-ts`; claude: mirrored from Agent SDK types). No SDK runtime deps.
- Each adapter has a **contract test** pinned to the CLI version it was verified against. The
  claude test asserts `system/init` shows `skills.length > 0`, `agents` present and the expected
  `apiKeySource` — the tripwire for a future `--bare`-by-default `-p`. claude is launched with
  explicit flags, **never `--bare`**, and `--setting-sources user,project,local`.
- Outcome mapping is protocol-driven, never exit codes (claude exits 1 after an interrupted
  last turn, 143 on SIGTERM). claude: `terminal_reason` starting `aborted` → `turn.interrupted`;
  `success ∧ ¬is_error` → `turn.completed`; else `turn.failed`. **An outstanding interrupt never
  changes the outcome** (verified: an interrupt sent right behind a send is reported
  `still_queued` and the turn completes). An interrupt with no open turn is a no-op.
  Per-turn `system/init` re-emission is not a restart; `total_cost_usd` is cumulative per
  process (per-turn cost = delta; unknown for the first turn after resume).
- claude inherits no orc-session identity: inherited `CLAUDE_CODE_*` variables are stripped
  except auth/provider configuration (they change the output format, e.g. partial messages).
- Provider processes do not die with the actor: an orphaned claude finishes its in-flight turn
  (verified). The stale-group kill before any resume (§4.2) is therefore mandatory.
- Inbound permission requests (claude `control_request can_use_tool`, codex approval requests)
  should not occur in yolo; if they do: journal them, report `waiting`, then deny-with-reason
  so the turn ends.
- `ProviderAdapter` loses `readyMatch` / `busyMatch` / `trustDialogMatch` / `interstitialMatch` /
  paste probes / `clearInputKeys` (and `-p` skips trust dialogs) and gains a `Runtime`:
  `start(spec) | resume(spec)`, `send(text, messageId)`, `interrupt()`, `close()`, and an async
  iterator of normalized events (§4.3).

### 4.2 Hosting: one detached actor process per session

- `orc __actor <sessionId>`: orc re-executes itself (compiled: `[process.execPath, '__actor', id]`;
  from source: `[bun, src/cli/index.ts, '__actor', id]`), spawned `detached` (verified: new session,
  no controlling tty, survives parent SIGKILL — no ffi needed), stdio → `actor.log`, `unref()`.
- The actor spawns the provider over **pipes** (no PTY) in **its own process group**, records
  `{providerPid, pgid, pidStartTime}` in `state.json`, and kills `-pgid` when it stops.
- **Single writer.** One lease, in `state.json`: `{pid, pidStartTime, expiresAt}`, heartbeat 5 s,
  expiry 30 s, written tmp+rename, acquired and renewed inside a brief `withLock('actor-<sid>')`.
  Liveness = lease fresh ∧ pid alive ∧ start time matches (pid-reuse safe).
- **No orphan writers.** An actor crash can leave a live provider writing the same session, and
  claude/pi have no write lock (verified: two `--resume` writers both append). Every start /
  resume / wake path first kills a recorded stale provider group (after the start-time check),
  then spawns.
- Per-session processes, not a central daemon: a crash affects one agent; nothing to keep
  version-matched across upgrades. Cost ≈ 15 MB RSS per actor on top of the provider.

### 4.3 Durability: mailbox + journal + effect sandwich

Per session, under `~/.orc/sessions/<sessionId>/` (dir 0700, files 0600):

```
spawn.json      persisted spawn spec: argv template, env (ORC_* lineage, ORC_RESULT_PATH,
                ORC_ATTEMPT_ID…), cwd, prompt/instructions file paths, provider session id
state.json      actor-owned snapshot: phase, lease, provider pid/pgid, seq, inbox cursor
journal.jsonl   append-only facts with monotonic seq (source of truth)
inbox/          durable mailbox: <ULID>.json, written as .tmp-* in the same dir then renamed
actor.log       actor stdout/stderr
```

- **Mailbox.** Clients never talk to a socket; `orc send` writes `inbox/<ULID>.json`
  `{type:"message"|"interrupt"|"stop", messageId, text}`. Messages persist while the actor is
  down. The actor processes strictly in ULID order, one turn at a time (mid-turn messages queue).
  **Polling (250 ms) is the correctness path; `fs.watch` is only a latency hint.** Listing
  filters `^[0-9A-HJKMNP-TV-Z]{26}\.json$`. An inbox file is unlinked only after its outcome is
  journaled; on restart, replay dedupes by ULID against `inbox.accepted`.
- **Journal (v1 vocabulary, kept small):** `actor.started`, `inbox.accepted`, `turn.intent`,
  `turn.started`, `assistant.text`, `interrupt.requested`, `interrupt.acked`, `turn.completed`,
  `turn.failed`, `turn.interrupted`, `permission.requested`, `provider.exited`, `actor.stopped`,
  plus `provider.raw` (verbatim provider events, for debugging). Readers drop a partial last
  line; the actor truncates a torn tail on restart. Intent/outcome entries are fsync'd.
- **Effect sandwich.** `turn.intent{messageId}` is committed *before* writing to the provider;
  the outcome after. On restart, an intent with no outcome → `turn.interrupted` and the delivery
  record → `unknown`: never auto-resubmitted (explicit `retry`, as orc enforces today).
- **Explicit acks.** `orc send` returns `acknowledged` once `turn.started` for its `messageId` is
  journaled (bounded wait), else `queued`. Idempotency keys keep their meaning.
- **Stopped vs suspended.** `orc kill` → `stopped` (sticky, never wakes). Actor crash or host
  reboot → `suspended` (resumable).
- **Wake-on-send (default, agents-first).** `orc send` to a `suspended` session takes the
  `actor-<sid>` lock, re-runs `enforceSpawnPolicy` (maxConcurrentSessions), kills any stale
  provider group, and spawns the actor in resume mode from `spawn.json`; two concurrent senders
  yield one actor. `--no-wake` only queues. `orc resume <id>` and workflow `resume` use the same
  path. "Survives reboots" means *resumable* — nothing resurrects a session without a sender
  (a supervisor is a later seam).
- **Privacy change (stated):** prompt bodies now persist under `~/.orc` (inbox/journal), whereas
  `messages.ts` stores hashes only today. Mitigated by 0600 files and pruning with the session.

### 4.4 State model

`classifyState(pane)` → pure `deriveState(journalTail, liveness)` with the same public states, so
`orc state`, `orc wait --for` and workflow settle logic keep their contracts:

- `starting` — actor up, provider not yet initialised.
- `running` — a turn is open, or the inbox is non-empty.
- `done` — no open turn ∧ inbox empty.
- `waiting` — `permission.requested`, or result envelope says `needs_input`.
- `failed` — last turn failed, or actor not live. JSON adds `suspended: true` when resumable.

Events are authoritative, so the two-poll debounce goes away.

### 4.5 Observability (agents first)

- `orc read` — unchanged contract (parsed provider transcript). `--raw` prints the journal.
  Codex transcript path comes from `thread.path` (no cwd+mtime search).
- `orc attach <id>` — follows the live journal rendered as text (read-only by construction;
  `--read-only` accepted and ignored).
- Escape hatch: `orc takeover <id>` stops the actor cleanly and prints the provider's own resume
  command. Handback = `orc resume <id>`.
- Workflow `StepDoneCtx.capture` keeps its name; it now holds the last assistant message plus a
  short rendering of the final turn (documented semantics change).

### 4.6 Workflow runners

Detached runners (`workflow run --detach`, detached resume/retry, daemon-spawned runs) use the
same `spawnDetached(argv, logPath)` helper — plain detached processes. `runnerTmux` /
`lease.runnerTmux` → `runner: { pid, startTime, logPath, startedAt }`; liveness = lease fresh ∧ same
process alive. Runners heartbeat their lease on a timer (a long step no longer expires it), and
`cancel` sends SIGTERM to a live runner.
`orc workflow attach` follows the runner log. The latent `orc-wf-<runId>` name-collision bug on
re-spawn disappears; the daemon resume path must revert its stamped record if spawn fails.

### 4.7 Storage and migration

- Keep JSON registry/run files, CAS and file locks. `bun:sqlite` only if journal queries grow.
- `SessionRecord`: drop `tmuxName`; add `runtime: "actor"` and `providerSessionId`.
- Legacy records (have `tmuxName`, no `runtime`) normalize to `status: "dead"`, `legacy: "tmux"`:
  readable, prunable, never controlled. Runs with `runnerTmux` normalize to a dead runner
  (→ `orphaned`, resumable as today). Upgrade note: kill live `orc-*` tmux sessions first.

### 4.8 Remote daemon

Routes keep their shape, but the raw views change: `read --raw` / `logs --raw` return a
`journal` field instead of `pane` (`server.ts` ~392–453, `client.ts` ~35–40), with versioned
client types. Remote attach hints become `tailscale ssh <host> orc attach <id>`. Detached runs
use `spawnDetached`.

## 5. What we lose (accepted)

- No live, typeable provider TUI (by design). Takeover = stop → native resume, a few seconds.
- TUI-only slash commands (pickers, `/login`) are unavailable to orc-driven sessions.
- Codex app-server is labelled experimental and claude's control wire is documented only via SDK
  types → mitigated by pinned generated/mirrored types, capability detection and contract tests.

## 6. Delivery plan (vertical slices)

| # | Slice | Depends on | Done when |
|---|---|---|---|
| S1 | **Actor kernel**: spawn spec, state/lease, journal, inbox, `spawnDetached`, `orc __actor`, scripted fake provider | — | tests: survives launcher exit; idempotent inbox; torn tail; crash → `turn.interrupted`; stale-provider kill; two senders → one actor; stop kills the group |
| S2 | **claude runtime** | S1 | live: multi-line prompt, 2 turns, interrupt, SIGKILL actor mid-turn → resume → exactly one provider process → next turn |
| S3 | **codex runtime** | S1 | contract test vs real `codex app-server` here; **live run on an authenticated host** |
| S4 | **pi runtime** | S1 | contract test vs real `pi --mode rpc` here; **live run on an authenticated host** |
| S6a | **Runners on `spawnDetached`**: runner schema, lease/reconcile, CLI + daemon spawn paths | S1 | workflow tests + live detached run |
| S5 | **Cutover**: `agent()`, `Session`, registry, `deriveState`, send/wait/read/attach/kill/prune/resume/takeover, schema normalization, daemon raw views; delete `drivers/`, matchers, pane fixtures | S2, S3, S4, S6a | full suite + live claude end-to-end via CLI with **tmux absent from PATH** |
| S6b | `StepDoneCtx.capture` from journal; live fan-out workflow | S5 | workflow tests + live run |
| S7 | Docs, skill, dogfood, package metadata | S5, S6b | `grep -ri tmux` clean outside history docs |

S2, S3, S4 and S6a run in parallel in separate worktrees after S1. Each slice: Haiku context
gatherer → Opus implementor → Fable judge; the orchestrator integrates. A
`scripts/verify-runtime.ts` script runs the live gates for all three providers so they can be
re-run on any authenticated macOS or Linux host.

## 7. Implementation notes and deviations

### 7.1 Design text vs the build

| # | Design says | Built | Where |
|---|---|---|---|
| 1 | Status "proposed" | Implemented; slices S1–S6b and S7 merged, plus S8 (one-command live verification) | git history of `feat/actor-runtime` |
| 2 | Journal vocabulary includes `provider.raw` (§4.3) | No `provider.raw` event: verbatim protocol lines go to `provider.jsonl` (debug only). Added events: `provider.spawned`, `provider.ready`, `inbox.dropped`, `actor.reopened` | `runtime/types.ts` `JournalEvent`; `runtime/layout.ts` |
| 3 | Lease `{pid, pidStartTime, expiresAt}` (§4.2) | `ActorLease {pid, startTime, token, expiresAt}`; the token identifies the actor incarnation | `runtime/types.ts` |
| 4 | `classifyState(pane)` → `deriveState(journalTail, liveness)` (§4.4) | `deriveState(view)` over a folded journal summary + inbox + `state.json`; `classifyState` / `reduceWait` deleted. An interrupted last turn is `done` (only a failed one is `failed`) | `runtime/derive.ts` |
| 5 | `StepDoneCtx.capture` = last assistant message + short final turn (§4.5) | As designed, bounded to 8000 chars | `workflow.ts`, `journal-render.ts` |
| 6 | `runnerTmux` → `runner {pid, startTime, logPath, startedAt}` (§4.6) | Done. Liveness checks pid **and** start time (pid-reuse safe); a legacy `runnerTmux` is read as `legacyRunnerTmux` (never persisted; such runs reconcile to `orphaned`). Schema 4 → 5 | `run-schema.ts`, `runs.ts`, `workflow-runner.ts` |
| 7 | Daemon raw views return `journal` (§4.8; "server.ts ~392–453, client.ts ~35–40") | Daemon `api: 2` on `GET /health`; `read?raw` → `{kind:'raw', journal}`, logs `--raw` → `{step, provider, journal}`. v1 `pane` shapes stay in the client's types so a v2 client can read an old daemon | `daemon/server.ts` (`sessions.read`, `workflows.runs.logs`), `daemon/client.ts` |
| 8 | One `scripts/verify-runtime.ts` (§6) | `scripts/verify-runtime/{claude,codex,pi}.ts` (runtime gates) + `all.ts` (gates, CLI end-to-end, detached workflow, tmux shim); `bun run verify:live` | `scripts/verify-runtime/README.md` |
| 9 | Two-poll debounce goes away (§4.4) | Done: `waitFor` returns on the first matching observation (250 ms journal poll) | `session.ts` |
| 10 | TUI-only slash commands unavailable (§5) | Verified live (claude 2.1.300, haiku, through `orc send`): `/compact` works over stream-json (`compact_boundary`, the turn completes with an empty result, context survives as a summary) and `/goal <condition>` installs a session Stop hook and the turn runs until the condition holds. Pickers / `/login` remain unavailable. codex/pi slash commands unverified | `skills/orc/SKILL.md` |
| 11 | Takeover = stop, then native resume (§4.5) | As designed: sticky stop → wait (≤ 15 s) for the provider group to exit → `cd <cwd> && <native resume>`; handback `orc resume` | `session.ts` `takeover` / `resume`, `provider-cli.ts` |
| 12 | S7 gate: `grep -ri tmux` clean outside history docs | Remaining mentions are intentional: legacy-record / legacy-run normalisation and errors, tests that shadow `tmux` on PATH, the `verify:live` tmux shim, upgrade notes, and history (`RESEARCH.md`, this design) | — |
| 13 | `spawn.json` holds an "argv template" (§4.3) | It holds the inputs (provider, cwd, env additions, model, agent, system prompt file, provider session id, transcript path); each runtime builds argv per launch | `runtime/spec.ts`, `runtime/types.ts` `SpawnSpec` |

### 7.2 Added during the build

- **Start-failure counter.** `state.json.startFailures` counts consecutive starts that never
  reached `ready`; after 3, auto-wake is refused (`send` only queues, `ensureAwake` throws
  `ORC_SESSION_START_FAILED`) until a forced wake (`orc resume`). Reset on `ready`.
- **`provider.spawned`.** Journaled (fsync'd) from the runtime's `onSpawn` callback right after the
  child exists, so a provider started by an actor that dies before writing `state.json` is still
  found and killed before the next start (`staleProviders`).
- **`inbox.dropped`.** A message still queued when a stop lands is removed with this fact (delivery
  verdict `failed`) instead of waiting forever in a session that will not wake.
- **`actor.reopened` / reopen.** `orc resume` journals it, clears the sticky stop and force-wakes.
  Takeover and kill share the sticky stop, so a send can never start a second writer while a
  human runs the native resume command.
- **Abandoned stops.** An actor that dies mid-stop leaves phase `stopping` with a dead lease; it is
  reported as stopped and the next lock holder finalises it (never woken).
- **Status is three-valued + spawn-pending.** `running | suspended | dead`; a young record without
  `spawn.json` is a spawn in progress (listed, counted against `maxConcurrentSessions`, never
  pruned).
- **Timeouts.** Send ack wait 10 s; `agent()` readiness 60 s (`readyTimeoutMs`); the actor's
  provider-ready bound 120 s (`ORC_ACTOR_READY_TIMEOUT_MS`); claude initialize 60 s
  (`ORC_CLAUDE_READY_TIMEOUT_MS`); actor stop grace 5 s.
- **Detached runners.** Preconditions, then spawn, then stamp `runner` on the run: a failed
  precondition or spawn writes nothing, and a stamp that loses a race stops the new runner. The
  runner heartbeats its owner lease; `cancel` SIGTERMs a live runner (exit 143).
- **Privacy.** Beyond §4.3's 0700/0600 session dirs, every file orc writes under `ORC_HOME`
  (registry, peers, run records, instruction drops, locks, artifacts) is owner-only, with explicit
  chmod; older state is tightened on its next write (`src/private-fs.ts`).
