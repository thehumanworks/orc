# Task: reliable agent state detection + `orc wait`

## Context
You are an autonomous coding agent in an **isolated git worktree** of `orc` — a tool that drives
coding-agent CLIs (claude/codex/pi) as interactive tmux sessions. First: `bun install` (the worktree
has no node_modules), then read `README.md`, `src/session.ts`, `src/providers/{provider,claude,codex,pi}.ts`,
`src/drivers/{driver,tmux}.ts`, and `src/cli/index.ts`. Commit on THIS branch; never touch `main`.

## Goal
Add a reliable way to know what state an interactive agent session is in, and a `wait` that blocks
until the agent stops working. This is the foundation for orchestration, so it must be RELIABLE, not
best-guess.

### Public state model
Add `export type AgentState = 'starting' | 'running' | 'done' | 'waiting' | 'failed';` (in `types.ts`).
Meaning (be precise — these definitions are load-bearing for the orchestration built on top):
- **running** — the assistant is actively working (a turn is in progress).
- **done** — the turn has YIELDED: the composer is idle and ready for input. NOTE: this means
  "ready for your input," NOT "succeeded." It covers both "finished the task" and "asked a
  clarifying question and is waiting for your reply" — those two are **pane-indistinguishable** for
  claude/codex in yolo mode (both render as the idle composer with no working indicator), so a
  conversational question is reported as `done`, not `waiting`. Document this in the code/README.
- **waiting** — blocked specifically on a **TUI modal** that needs a response: trust dialog,
  approval/permission selection, or update interstitial. (A conversational question is `done`, per
  above — we cannot distinguish it from the pane.)
- **failed** — the process/pane is no longer alive. This is crash OR clean exit (e.g. `/exit`) —
  pane-gone cannot distinguish them, so do NOT imply `failed` means "errored"; it means "terminated."
- **starting** — booted but not yet showing a ready composer (transient).

### API
- `ProviderAdapter.busyMatch(pane: string): boolean` — true when the provider's "actively working"
  indicator is present. (New required method on the interface; implement for all three adapters.)
- `Session.state(): Promise<AgentState>` — classify using driver liveness + a single pane capture.
  Order matters (first match wins): not alive → `failed`; a waiting dialog → `waiting`; busy →
  `running`; ready composer → `done`; otherwise → `starting`.
- `Session.waitFor(opts?): Promise<AgentState>` — poll `state()` until it **settles** (reaches a
  non-progressing state: `done`, `waiting`, or `failed`) or times out. RELIABILITY REQUIREMENT:
  debounce — only return `done` after the state has been continuously non-`running`/non-`starting`
  for **2 consecutive polls** (~1s apart), so a sub-second gap between tool calls is never misread as
  end-of-turn. Options: `{ until?: AgentState[]; timeoutMs?: number; pollMs?: number }` (default
  `until` = `['done','waiting','failed']`, `timeoutMs` 600000, `pollMs` 1000). On timeout, return the
  last observed state (do not throw).
- CLI `orc wait <id|name> [--for done|waiting|failed|settled] [--timeout <sec>] [--json]`:
  blocks via `waitFor`, prints the reached state. `--for settled` (default) = any of done/waiting/
  failed. With `--json`: `{ id, state, elapsedMs, timedOut }`. Exit code: 0 if the reached state is
  in the requested set, non-zero on timeout. Add it to `HELP_TEXT` and the README CLI table.

## Verified pane signals (ground truth — captured live; use these exactly)
- **claude**: working indicator is the literal substring **`esc to interrupt`** (bottom bar:
  `⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`). When idle/done it is ABSENT
  (the bar reads `… · ← for agents`). So claude `busyMatch` = pane includes `esc to interrupt`.
  `readyMatch` (already correct) = `bypass permissions on`.
- **codex**: working indicator is **`esc to interrupt`** too (it appears in the line
  `• Working (3s • esc to interrupt)`). When done that line is gone, leaving only the status line
  `gpt-5.5 xhigh · /path`. So codex `busyMatch` = pane includes `esc to interrupt`. `readyMatch`
  (already correct) = the status-line regex. `waiting` = existing `trustDialogMatch` ||
  `interstitialMatch`.
- **pi**: its ready composer is two `────` horizontal borders with an empty line between, and a
  bottom **budget-meter line** like `$0.000 (sub) 0.0%/200k (auto) … grok-composer-2.5-fast`.
  - **BUG to fix:** pi's current `readyMatch` (`pane.includes('│') || '❯' || '>')` does NOT match
    this composer (it has none of those), so `orc send` to pi throws "not ready" and prompts are
    lost. Replace pi `readyMatch` with a match on the budget-meter line, e.g. `/\d+(?:\.\d+)?%\/\d+k/`
    (verify it is ABSENT during early boot and PRESENT once the composer is live).
  - **pi `busyMatch`: you must capture this yourself** (it wasn't observed). Method: after fixing
    readyMatch, spawn a pi session, `orc send` it `run the shell command: for i in $(seq 1 10); do
    echo p-$i; sleep 1; done` and capture `orc read <id> --raw` mid-run; identify the bottom
    indicator pi shows while working (likely an interrupt/"esc" hint) and use it. If you genuinely
    cannot find a reliable pi busy signal, document that clearly and make pi `busyMatch` return false
    (pi then reports done/starting only) — but TRY first.

## Constraints
- Bun + TypeScript, ESM, match surrounding style. No new dependencies.
- `bun run typecheck` clean, `bun test` green. Add unit tests for the classifier: feed canned pane
  strings (use the exact signals above — put representative captures in `test/fixtures/`) to a pure
  classify function and assert the resulting `AgentState`. Keep `state()` thin over that pure fn so it
  is unit-testable without a live session.

## Verification — REQUIRED, real CLIs (this gates done)
Throwaway `ORC_HOME="$(mktemp -d)/orc"`. For **claude AND codex AND pi**:
1. Spawn a session and send a ~12s tool-run (`for i in $(seq 1 12); do echo tick-$i; sleep 1; done`).
2. Assert `orc wait <id> --json` BLOCKS while running and returns `state:"done"` only after the loop
   finishes (measure elapsedMs ≳ the loop duration — proving it didn't return early). Print the JSON.
2b. **Debounce stress test (this is the reliability check — do NOT skip):** send a prompt that runs
   SEVERAL DISTINCT tool calls in sequence, e.g. "run these as three SEPARATE shell commands, one
   after another: first `sleep 4`, then `echo mid`, then `sleep 4`". Assert `orc wait` does NOT
   return `done` during the brief gaps BETWEEN those tool calls — it must only return `done` after the
   whole sequence finishes (elapsedMs ≳ 8s). A single sleep-loop keeps the working indicator
   continuously on and so would pass even with a broken debounce; this multi-call case is what
   actually exercises the 2-poll debounce.
3. Assert `orc state`/`orc wait` on a brand-new session mid-boot is `starting`/`running`, and on a
   killed session is `failed`.
4. For at least one provider, capture a real `waiting` state: spawn codex in a FRESH untrusted dir
   with `--no-wait` (so the boot loop doesn't auto-confirm) and assert `state()` = `waiting` on the
   trust dialog.
5. Clean up: kill sessions, remove throwaway ORC_HOME, and remove any codex trust entries your test
   added to `~/.codex/config.toml` for temp paths (leave pre-existing entries intact). You are running
   inside tmux; if a nested session won't start, prefix with `TMUX= `.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
