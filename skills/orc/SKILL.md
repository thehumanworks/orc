---
name: orc
description: >-
  Act as the orchestrator of a fleet of coding subagents to deliver a task, using the `orc`
  CLI/SDK (it launches claude/codex/pi agents as detached, reattachable tmux sessions). Use this
  whenever the user prefixes a task with /orc, OR asks to orchestrate / delegate / parallelize /
  fan out work across multiple agents, run a multi-step or repeatable agent workflow (code review,
  migration, release, large refactor), spin up specialized or reusable subagents, get a second
  opinion from a different model, or do broad codebase work that benefits from several agents in
  parallel worktrees — even if they don't say the word "orchestrate". When triggered, YOU become
  the orchestrator: decompose the task, spawn subagents (preferring diverse providers), steer them,
  verify their work, and clean up every session and worktree when done.
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
one-line change, a quick lookup — just do it directly (or hand it to a single subagent). Don't spin
up a worktree, a reviewer, and a cleanup pass for negative value. Match the machinery to the task.

`orc` drives real coding-agent CLIs (`claude`, `codex`, `pi`) as **interactive, detached, reattachable**
tmux sessions, so a subagent's work is never opaque — you (or the user) can read or attach to any
session at any time, and sessions outlive this one. Full command surface: **`references/orc-cli.md`**
(read it when you need a flag you don't remember). The essentials:

```
orc spawn -p <claude|codex|pi> [--prompt P|-|@file] [--agent NAME] [--alias NAME] [--worktree] [--cwd DIR] --json
orc send  <id|@alias> [PROMPT|-|@file] # follow-up / steer (multi-line safe)
orc state <id|@alias>                # starting|running|done|waiting|failed (one shot)
orc wait  <id|@alias> [--for done|settled] # BLOCK until it settles (debounced — reliable)
orc read  <id|@alias> [--full|--index N] # latest parsed turn by default; --full transcript; --raw live pane
orc list  [--all] [--json]           # what's running ( hygiene: audit before you finish )
orc kill  <id|@alias> [--worktree] [--purge]; orc prune [--worktree]
orc workflow run <file.ts> [--detach]; orc workflow logs <runId> [--step id]
```

Prefer `--json` everywhere (you're a machine consumer). `orc spawn --json` returns the record so you
can immediately `orc send`/`orc wait` by id.

## The orchestration loop

1. **Decompose.** Break the task into units that can run independently (different files/modules/questions)
   or must run in sequence (implement → review → fix). Independent units → spawn in parallel. Sequential
   units → a pipeline you gate with `orc wait`.
2. **Spawn**, preferring **diverse providers** (see below) and an isolated **`--worktree`** for anything
   that edits code. Deliver instructions reliably (see "Delivering large prompts").
3. **Steer.** Watch progress with `orc read` / `orc wait`; send corrections with `orc send`; keep a
   subagent's context lean with `/compact` and give it a durable objective with `/goal` (see "Steering").
4. **Verify** — never trust a subagent's self-report. Run its tests, read its diff, ideally have a
   *different-provider* agent review it.
5. **Integrate** — review and merge worktree branches yourself.
6. **Clean up — always.** Kill every session and remove every worktree you created. This is not
   optional; see "Session hygiene".

Keep parallel fan-out to what you can actually **supervise** — a handful of sessions you steer and
verify well beats a dozen you can't track. If a task has more independent units than that, batch them.

`orc wait` is the spine of reliable orchestration: it blocks until an agent reaches `done`/`waiting`/
`failed` (debounced, so a gap between tool calls isn't misread as finished). Sequence steps with it
instead of sleeping or guessing. Note `done` means "the turn yielded, ready for input" — NOT
necessarily "succeeded"; an agent that asks a question and stops also reads as `done`. So gate
success on a **hard signal** (a commit appeared, tests pass, a file exists), then read the transcript
to confirm.

## Choose your structure: ad-hoc orchestration vs. a versioned workflow

- **One-off task** (this specific thing, now) → orchestrate ad-hoc: spawn, steer, verify, clean up, by
  hand (or a throwaway SDK script).
- **A multi-step process you'll repeat** (code review, dependency upgrade, release checklist, a
  research→plan→implement→review loop) → **write it as a TypeScript workflow** in `orc.workflows/` and
  run it with `orc workflow run <file> [--detach]`. A workflow is a versioned, reviewable,
  backgroundable definition — far better than re-improvising the steps each time, and its run records
  + per-step logs (`orc workflow logs`) make it inspectable. Start from **`assets/workflow-template.ts`**.

  Rule of thumb: if you'd run this shape of task more than ~twice, make it a workflow. Each step's
  success should gate on a hard signal, not just `state === 'done'` — the template shows the pattern.

## Prefer provider diversity

Spawn different subagents from **different providers** on purpose. Models from different providers have
genuinely different failure modes, blind spots, and styles — diversity is a feature, not a
coincidence. Concretely:

- **Implement with one provider, review with another** (e.g. implement with `claude`, adversarially
  review with `codex`). A reviewer that didn't write the code catches more.
- For a hard design question, ask **two providers the same question** and synthesize — disagreement is
  signal.
- Rotate which provider does what across a session so you're not over-relying on one model's habits.

All three (`claude`, `codex`, `pi`) drive the same lifecycle; pick by strength and for diversity, not
convenience. But only **one** provider is required to be installed — don't assume all three are on
`PATH` (a spawn fails if that CLI is missing). If only one is available, diversify *within* it: use a
different model (`-m`) or a different persona (`--agent`) for the implement vs. review roles, so a
*different agent* still checks the work.

## Specialized, reusable subagents

For a *role* you invoke repeatedly (a strict code reviewer, a test-writer, a security auditor, a
docs-writer), don't re-describe it in a prompt each time — define it once as a **named agent** and
reuse it with `orc spawn --agent <name>`:

- `claude` resolves a named agent natively from `.claude/agents/<name>.md` (project) or
  `~/.claude/agents/<name>.md` (user).
- `codex` resolves `.codex/agents/*.toml` by parsed `name` first (project, then
  `$CODEX_HOME/agents`, default `~/.codex/agents`), then `.codex/prompts/<name>.md`, then the
  claude locations; `pi` resolves the claude locations. orc injects the agent's body as the system
  prompt.

Treat these definitions as **living artifacts**: when a specialized subagent underperforms, edit its
`.toml` or `.md` and improve it — that's how the fleet gets better over time. A good agent definition states the
role, the standards it holds, what to focus on, and what "done" means for it. (`--agent` and a raw
`--system-prompt` are mutually exclusive; use `--agent` for anything reusable.)

## Steering interactive subagents

Subagents run as **interactive** sessions, so you can collaborate with them mid-task — this is the
whole point of orc over headless one-shots:

- **`orc send <id> "..."`** — give a correction, answer a question, add a constraint, or redirect.
  Read `orc read <id>` first to see where it is.
- **`/compact`** — when a long-running subagent's context is bloated (lots of exploration, big tool
  outputs), send `/compact` to make it summarize and free up room so it keeps reasoning sharply.
  Reach for this before a subagent starts going in circles or forgetting earlier decisions.
- **`/goal <objective>`** — give a subagent a *persistent* objective it keeps working toward across
  turns (the goal holds until met). Good for "keep fixing failures until the suite is green" or
  "iterate on this until the benchmark passes" — the subagent won't stop at the first plausible stop.
- A stuck subagent (no progress, `state` flapping, or `waiting`) is a steer signal: nudge it, give it
  the missing context, or kill it and respawn with a sharper prompt. Don't let it spin.

Deliver a slash command with `orc send <id> "/compact"` — `orc send` just *types* the literal text
into the subagent's interactive session and presses Enter. Whether a given command exists is up to
that subagent's own CLI, not orc: **Claude Code** supports `/compact` and `/goal`; `codex` and `pi`
have their own command sets — so match the command to the provider. The leverage is that you can
drive these interactive commands programmatically, exactly as a human would.

## Verify, don't trust

A subagent reporting "done, all tests pass" is a claim, not a fact — verify it yourself. Run the
tests/build, read the actual diff, check the hard signal you care about. For anything important, have
a **different-provider** agent adversarially review the work before you merge. Verification by a real
run beats any self-report; this is the single biggest determinant of whether orchestration produces
real value or confident slop.

## Worktrees for parallel codebase work

When several subagents touch the **same repo in parallel**, give each its own `--worktree` so they
don't collide — each gets an isolated checkout on its own branch. Then you review each branch's diff
and merge the good ones. Two consequences to remember:

- `--worktree` requires the cwd to be inside a git repo (orc errors otherwise).
- A fresh worktree has no `node_modules`/deps — tell the subagent to install first if it needs to
  build or test.
- **Every worktree is cleanup you owe.** `orc kill <id> --worktree` removes the session's worktree;
  `orc prune --worktree` removes all dead sessions' worktrees. Delete the branch too if it's merged or
  abandoned.

## Session hygiene — clean up when done

Leaving sessions and worktrees lying around is the most common way orchestration turns into a mess:
orphaned tmux sessions, stale worktrees, and (for `codex`) leftover trust entries pile up. So, as a
standing discipline:

- **Audit before you finish:** `orc list --all` — anything you spawned and no longer need is a leak.
- **Kill what you're done with:** `orc kill <id>` (keeps the record so you can still read its
  transcript), or `orc kill <id> --purge` to drop the record entirely.
- **Remove worktrees and branches:** `orc kill <id> --worktree` per session, or `orc prune --worktree`
  to sweep all dead ones. That removes the *worktree* but leaves the *branch* — delete merged/abandoned
  branches yourself with `git worktree prune && git branch -D <branch>`.
- **End state:** when the task is delivered, `orc list --all` should show nothing you left running by
  accident, and `git worktree list` should be back to just the main checkout.

Make the final cleanup an explicit step of every orchestration, the same way you'd close files you
opened. If you used throwaway state for experiments, set `ORC_HOME` to a temp dir so it never touches
the user's real `~/.orc`.

## Delivering large prompts (gotcha)

A large initial `--prompt` (or `orc send`) can fail to deliver cleanly — e.g. Claude Code collapses a
big multi-line paste into a `[Pasted text]` chip that the send-verifier can't confirm, so the send
errors. For anything large (a detailed spec), **write it to a file and send a short pointer**:
`orc spawn -p claude --worktree` (no prompt) → then
`orc send <id> "Read <abs-path-to-spec.md> in full and carry it out."` Keep the spec OUTSIDE the
worktree so the subagent can't accidentally commit it. Short prompts inline are fine. (The
`orc workflow` runner already file-drops step instructions over ~1KB for exactly this reason.)

## A minimal end-to-end shape

```
# Implement in an isolated worktree, review with a different provider, verify, clean up.
REC=$(orc spawn -p claude --worktree --json)            # capture the whole record
ID=$(echo "$REC" | jq -r .id)
WT=$(echo "$REC" | jq -r .worktreePath)                 # the isolated checkout path
BR=$(echo "$REC" | jq -r .branch)                       # its branch
orc send "$ID" "Read /tmp/spec.md and implement it; commit when done."
orc wait "$ID" --for settled                            # block until it yields
orc read "$ID"                                          # see what it did (token-efficient)
# verify: a SECOND provider reviews the SAME branch (run it IN that worktree)
RV=$(orc spawn -p codex --cwd "$WT" --prompt "Review the diff on this branch for correctness; be adversarial." --json | jq -r .id)
orc wait "$RV" --for settled && orc read "$RV"
# ... you review the diff + merge the branch if it's good ...
orc kill "$ID" --worktree --purge; orc kill "$RV" --purge   # kill sessions + remove the worktree
git worktree prune && git branch -D "$BR" 2>/dev/null       # then remove the (merged/abandoned) branch
```

Whether you orchestrate by hand like this or via `orc workflow`, the same principles hold: decompose,
diversify, steer, verify on a hard signal, and clean up.
