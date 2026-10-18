---
name: orc
description: >-
  Act as the orchestrator of a fleet of coding subagents to deliver a task, using the `orc`
  CLI/SDK (it runs Pi and Claude agents as durable, detached sessions you can steer, read,
  wait on and resume). Use this whenever the user prefixes a task with /orc, OR asks to
  orchestrate / delegate / parallelize / fan out work across multiple agents, run a multi-step or
  repeatable agent workflow (code review, migration, release, large refactor), spin up
  specialized or reusable subagents, get a second opinion from a different model, or do broad
  codebase work that benefits from several agents in parallel worktrees — even if they don't say
  the word "orchestrate". When triggered, YOU become the orchestrator: decompose the task, spawn
  subagents (preferring diverse providers), steer them, verify their work, and clean up every
  session and worktree when done.
---

# orc — orchestrate a fleet of coding subagents

## The mindset

When this skill is active, **you are an orchestrator, not the implementer.** The task that follows
(`/orc <task>`, or whatever the user asked) is delivered by *coordinating subagents through `orc`* —
spawning them, steering them, verifying their work — not by doing all the work yourself in this
session. Your leverage is decomposition, parallelism, diverse perspectives, and judgment about when
work is actually done.

You still do the *thinking*: scope the task, decide the structure, write specs, review diffs, make
the merge calls. You delegate the *doing*.

**Right-size first.** Orchestration earns its keep on work that is parallelizable, multi-step, or
diversity-sensitive. If the coordination overhead would exceed the task's value — a typo fix, a
one-line change, a quick lookup — just do it directly (or hand it to a single subagent). Match the
machinery to the task.

Run agents through ORC's two production integrations, `pi` and `claude`. One actor process per
session drives the native CLI over a structured protocol. For OpenAI/Codex models, use
`--provider pi --model openai/<model-id>`; authenticate on the execution host in Pi with
`/login openai` → **Sign in with ChatGPT**, or `OPENAI_API_KEY`. Pi owns models, tools and
authentication; ORC retains its mailbox, journal, actor ownership and workflow durability.
There is no separate Codex executor or pi-durable dependency. Read each subagent's transcript
or follow its journal at any time; sessions outlive the client. Exact flags, exit codes and JSON shapes:
**`references/orc-cli.md`**. The essentials:

```
orc spawn -p <claude|pi> [-m MODEL] [--prompt P|-|@file] [--agent NAME] [--alias NAME] [--worktree] [--cwd DIR] --json
orc send  <id|@alias> [PROMPT|-|@file] [--idempotency-key K]  # steer; exit 3 = delivery unknown
orc state <id|@alias> --json         # starting|running|done|waiting|failed (+ stopped/suspended)
orc wait  <id|@alias> [--for done|settled] [--timeout SEC]  # BLOCK until it settles
orc read  <id|@alias> [--full|--index N|--raw]  # latest parsed turn; --full transcript; --raw journal
orc list  [--all] --json             # running + suspended here; --all adds dead + other workspaces
orc kill  <id|@alias> [--worktree] [--purge]; orc prune [--worktree] [--suspended] [--taken-over]
orc resume <id|@alias>; orc takeover <id|@alias>   # hand back / hand to a human
orc workflow run <file.ts> [--detach] [--max-concurrency N]; orc workflow logs <runId> [--step id]
```

Prefer `--json` everywhere (you're a machine consumer). `orc spawn --json` returns the record so
you can immediately `orc send` / `orc wait` by id.

**Or drive orc as MCP tools.** `orc mcp` serves the same commands as MCP tools over stdio (`spawn`,
`send`, `wait`, `read`, … `workflow_*`, plus a `guide` playbook), and `orc daemon` serves them at
`/mcp`. Same semantics as the CLI (each tool runs `orc <cmd> --json`); `spawn` never blocks and
`wait` is bounded (call it again while agents run). If your session has these tools, use them
instead of shelling out.

**Check where commands go: `orc settings`.** The user may have a default host (`ORC_HOST`, or
`host` in `~/.orc/settings.toml` / the project's `.orc/settings.toml`) — then `spawn`, `list`,
`wait`, … run on that host and each prints `orc: → <host> (from …)` on stderr. Pass `--local` to
work here, or `--host <h>` to pick a host. Settings may also default `provider` and the model per
provider (`[models]`), so `orc spawn` without `-p` can work. A project file's `host` must be a
trusted peer (`orc remote add`) or the user's global host, or commands fail — never "fix" that by
adding a peer yourself; ask the user. Agents you spawn ignore default hosts (they run nested), so
their own `orc` calls stay on their host unless told `--host`.

Reject removed Codex inputs deliberately: replace `provider = "codex"` and `[models].codex`
with `pi` and `[models].pi = "openai/<model-id>"`. Use `pi --list-models` for exact IDs.
Do not rewrite historical provider fields or replay old messages. Read the removed-provider
migration section in `references/orc-cli.md` before continuing an old session or workflow.

## The orchestration loop

1. **Decompose.** Break the task into units that can run independently (different files/modules/questions)
   or must run in sequence (implement → review → fix). Independent units → spawn in parallel. Sequential
   units → a pipeline you gate with `orc wait`.
2. **Spawn**, preferring **diverse providers** (see below) and an isolated **`--worktree`** for anything
   that edits code. Deliver long specs as files (see "Delivering large specs").
3. **Steer.** Watch progress with `orc read` / `orc wait`; send corrections with `orc send`; on claude,
   keep a long-running subagent's context lean with `/compact` and give it a durable objective with
   `/goal` (see "Steering").
4. **Verify** — never trust a subagent's self-report. Run its tests, read its diff, ideally have a
   *different-provider* agent review it.
5. **Integrate** — review and merge worktree branches yourself.
6. **Clean up — always.** Kill every session and remove every worktree you created. This is not
   optional; see "Session hygiene".

Keep parallel fan-out to what you can actually **supervise** — a handful of sessions you steer and
verify well beats a dozen you can't track. If a task has more independent units than that, batch them.

`orc wait` is the spine of reliable orchestration: it blocks until an agent reaches `done`/`waiting`/
`failed`, derived from the session journal (a gap between tool calls is never misread as the end of
a turn). After `orc send` returns, the state is `running` until that turn ends, so `send` then
`wait` is race-free — never sleep or guess. Note `done` means "the turn yielded, ready for input" —
NOT necessarily "succeeded"; an agent that asks a question and stops also reads as `done`. So gate
success on a **hard signal** (a commit appeared, tests pass, a file exists), then read the
transcript to confirm.

## Session lifecycle (what the states mean for you)

| you see | meaning | do |
| --- | --- | --- |
| `state: done` | turn yielded | read it; verify; send the next instruction |
| `state: running` | turn open or message queued | `orc wait` |
| `state: waiting` | provider asked for a permission (rare in yolo; orc denies it) | read it; re-instruct |
| `state: starting`, status `spawning`/`running` | provider still booting | `orc wait` |
| `state: failed`, `stopped: false`, `suspended: false` | the last turn failed | read `lastTurn.error`, inspect any effects, then correct the instruction or start a fresh session with a summary |
| `state: failed`, `suspended: true` | actor gone (crash/reboot); status `suspended` | just `orc send` — it wakes and resumes the same conversation |
| `state: failed`, `stopped: true` | killed, taken over or historical; status `dead` | `orc resume <id>` for a retained Pi/Claude session; use the migration path for an old Codex session |

- `orc send` exits **0** when the message was `acknowledged` or durably `queued`, **3** when delivery
  is `unknown` (cut before the provider acked it; orc never re-sends it), **1** on failure. On 3:
  inspect `orc read` and the external result before deciding whether to send a new instruction.
  Transcript persistence does not prove exactly-once effects; an intentional new send needs a new key.
- For sends you may retry (scripts, loops), pass `--idempotency-key <stable-key>`: a repeat with the
  same text is a no-op that returns `replayed: true`.
- `orc takeover <id>` stops orc's actor and prints the provider's own resume command for a human;
  `orc resume <id>` hands a retained Pi/Claude session back. An old Codex harness transcript may
  continue in native Pi after takeover, but its historical ORC record cannot resume or receive
  messages. There is no live TUI to attach to; `orc attach <id>` follows the journal read-only.

## Choose your structure: ad-hoc orchestration vs. a versioned workflow

- **One-off task** (this specific thing, now) → orchestrate ad-hoc: spawn, steer, verify, clean up, by
  hand (or a throwaway SDK script).
- **A multi-step process you'll repeat** (code review, dependency upgrade, release checklist, a
  research→plan→implement→review loop) → **write it as a TypeScript workflow** in `orc.workflows/` and
  run it with `orc workflow run <file> [--detach]`. A workflow is a versioned, reviewable,
  backgroundable definition — far better than re-improvising the steps each time, and its run records
  + per-step logs (`orc workflow logs`) make it inspectable. Start from **`assets/workflow-template.ts`**.

  Rule of thumb: if you'd run this shape of task more than ~twice, make it a workflow. Each step's
  success should gate on a hard signal (`verify`, a `done` predicate, or a worktree commit), not just
  `state === 'done'` — the template shows the pattern. `resume`/`retry` need the workflow file.

## Prefer model diversity

Use different models or model providers for independent perspectives. Distinguish ORC's integration
(`pi` or `claude`) from Pi's model provider (`openai`, `anthropic`, or another configured provider):

- **Implement with one provider, review with another** (e.g. implement with `claude`, adversarially
  review with `pi -m openai/gpt-5.5`). Have an agent that did not author the implementation review it.
- For a hard design question, ask **two providers the same question** and synthesize — disagreement is
  signal.
- Rotate which provider does what across a session so you're not over-relying on one model's habits.

Pi and Claude share ORC's lifecycle. Check which native CLIs and authenticated models are available
on the execution host; do not assume both are installed. Choose exact Pi IDs with `pi --list-models`.
A qualified selection is checked against Pi's selected and available models before prompts.
If only one integration is available, use a different model (`-m`) or persona (`--agent`) for
the review role, so an independent agent still checks the work.

## Specialized, reusable subagents

For a *role* you invoke repeatedly (a strict code reviewer, a test-writer, a security auditor, a
docs-writer), don't re-describe it in a prompt each time — define it once as a **named agent** and
reuse it with `orc spawn --agent <name>`:

- `claude` resolves a named agent natively from `.claude/agents/<name>.md` (project) or
  `~/.claude/agents/<name>.md` (user).
- `pi` resolves the same Markdown locations and receives the body as its system prompt.
  Claude-specific frontmatter model aliases are not applied to Pi. Pass `--model` or configure
  Pi's default; `--agent` bypasses ORC's ordinary `[models]` fallback.
- Move former Codex TOML `developer_instructions` or prompt Markdown into this format. ORC no
  longer discovers `.codex/agents`, `.codex/prompts` or `CODEX_HOME` for new agents.

Treat these definitions as **living artifacts**: when a specialized subagent underperforms, edit its
`.md` and improve it — that's how the fleet gets better over time. A good agent definition states the
role, the standards it holds, what to focus on, and what "done" means for it. (`--agent` and a raw
`--system-prompt` are mutually exclusive; use `--agent` for anything reusable.)

## Steering subagents

Subagents are long-lived conversations, so you can collaborate with them mid-task — this is the
whole point of orc over headless one-shots:

- **`orc send <id> "..."`** — give a correction, answer a question, add a constraint, or redirect.
  Read `orc read <id>` first to see where it is. A message sent while a turn is running is queued
  and delivered when that turn ends.
- **`/compact`** (claude) — when a long-running subagent's context is bloated (lots of exploration,
  big tool outputs), `orc send <id> "/compact"`. Verified through orc: the turn completes with an
  empty result and the earlier conversation survives as a summary. Reach for this before a
  subagent starts going in circles or forgetting earlier decisions.
- **`/goal <condition>`** (claude) — `orc send <id> "/goal all tests in test/ pass"` gives the
  subagent a persistent objective: claude keeps working within that turn until the condition holds,
  then the turn completes (`orc wait` returns). Good for "keep fixing failures until the suite is
  green". Still verify the condition yourself.
- Slash commands reach the provider as the message text. Only claude's `/compact` and `/goal` are
  verified; interactive pickers and `/login` don't work through `orc send`, and Pi slash commands
  are unverified. Sign in using Pi interactively before spawning the ORC session.
- A stuck subagent (no progress across several reads, repeated failed turns, or `waiting`) is a steer
  signal: nudge it, give it the missing context, or kill it and respawn with a sharper prompt. Don't
  let it spin.

## Verify, don't trust

A subagent reporting "done, all tests pass" is a claim, not a fact — verify it yourself. Run the
tests/build, read the actual diff, check the hard signal you care about. For anything important, have
a **different-provider** agent adversarially review the work before you merge. Verification by a real
run beats any self-report; this is the single biggest determinant of whether orchestration produces
real value or confident slop.

## Worktrees for parallel codebase work

When several subagents touch the **same repo in parallel**, give each its own `--worktree` so they
don't collide — each gets an isolated checkout on its own branch. Then you review each branch's diff
and merge the good ones. Things to remember:

- `--worktree` requires the cwd to be inside a git repo (orc errors otherwise).
- A `--worktree` session stays in the repo's workspace, but a session you point at an existing
  worktree with `--cwd` lands in *that worktree's* workspace (invisible to `orc list` / `@alias`
  from the repo). Add `--workspace "$(git rev-parse --show-toplevel)"` (run from the repo) when you
  do that.
- A fresh worktree has no `node_modules`/deps — tell the subagent to install first if it needs to
  build or test.
- **Every worktree is cleanup you owe.** `orc kill <id> --worktree` removes the session's worktree;
  `orc prune --worktree` removes all dead sessions' worktrees. Delete the branch too if it's merged or
  abandoned.

## Session hygiene — clean up when done

Leaving sessions and worktrees lying around is the most common way orchestration turns into a mess:
idle actors and provider processes, stale worktrees and branches pile up.
So, as a standing discipline:

- **Audit before you finish:** `orc list --all --json` — anything you spawned that is `running` or
  `suspended` and no longer needed is a leak (a suspended session wakes on the next send).
- **Kill what you're done with:** `orc kill <id>` (keeps the record and journal so you can still
  read it), or `orc kill <id> --purge` to drop the record and session dir entirely.
- **Remove worktrees and branches:** `orc kill <id> --worktree` per session, or `orc prune --worktree`
  to sweep all dead ones. `orc prune` never removes `suspended` sessions unless `--suspended`, nor
  sessions a human took over unless `--taken-over` (they may still be working in it). Removing
  a worktree leaves the *branch* — delete merged/abandoned branches yourself with
  `git worktree prune && git branch -D <branch>`.
- **End state:** when the task is delivered, `orc list --all` should show nothing you left running by
  accident, and `git worktree list` should be back to just the main checkout.

Make the final cleanup an explicit step of every orchestration, the same way you'd close files you
opened. If you used throwaway state for experiments, set `ORC_HOME` to a temp dir so it never touches
the user's real `~/.orc`.

## Delivering large specs

Prompts of any size and any number of lines are delivered verbatim as ONE message (`orc send <id>
@spec.md` works). For a detailed spec, still prefer **a file and a short pointer**:
`orc spawn -p claude --worktree` (no prompt) → `orc send <id> "Read <abs-path-to-spec.md> in full
and carry it out."` The spec stays reviewable and reusable across agents, and keeping it OUTSIDE the
worktree means the subagent can't accidentally commit it. (The `orc workflow` runner does this
automatically for step prompts over 1 KiB.)

## A minimal end-to-end shape

```
# Implement in an isolated worktree, review with a different provider, verify, clean up.
REC=$(orc spawn -p claude --worktree --json)            # capture the whole record
ID=$(echo "$REC" | jq -r .id)
WT=$(echo "$REC" | jq -r .worktreePath)                 # the isolated checkout path
BR=$(echo "$REC" | jq -r .branch)                       # its branch
orc send "$ID" "Read /tmp/spec.md and implement it; commit when done." --idempotency-key impl-1
orc wait "$ID" --for settled --timeout 1800             # block until it yields (exit 1 = timed out)
orc state "$ID" --json                                  # done? or failed (lastTurn.error)?
orc read "$ID"                                          # see what it did (token-efficient)
# verify: a SECOND provider reviews the SAME branch (run it IN that worktree; --workspace keeps it
# in this repo's workspace — a --cwd inside a linked worktree would otherwise get its own)
REPO=$(git rev-parse --show-toplevel)                    # the main checkout (run from the repo)
RV=$(orc spawn -p pi -m openai/gpt-5.5 --cwd "$WT" --workspace "$REPO" --prompt "Review the diff on this branch for correctness; be adversarial." --json | jq -r .id)
orc wait "$RV" --for settled && orc read "$RV"
# ... you review the diff + merge the branch if it's good ...
orc kill "$ID" --worktree --purge; orc kill "$RV" --purge   # kill sessions + remove the worktree
git worktree prune && git branch -D "$BR" 2>/dev/null       # then remove the (merged/abandoned) branch
```

Whether you orchestrate by hand like this or via `orc workflow`, the same principles hold: decompose,
diversify, steer, verify on a hard signal, and clean up.
