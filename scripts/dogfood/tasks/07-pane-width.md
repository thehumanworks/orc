# Task: make agent state detection robust to pane width (fix a narrow-pane misclassification)

## Context
Isolated git worktree of `orc`. `bun install`, then read `src/drivers/tmux.ts` (`spawn` uses
`tmux new-session -d -s <name> -c <cwd>` with NO size; `capture` uses `capture-pane -t <name> -p`),
`src/session.ts` (`state()`/`waitFor()`/`capture()`), `src/state.ts` (`classifyState`), and
`src/providers/{claude,codex,pi}.ts` (`busyMatch`/`readyMatch`). Commit on THIS branch; never `main`.

## The bug (REAL — reproduced live, then root-caused)
A detached tmux session inherits a NARROW width (observed **48 columns**). At that width the providers'
bottom status line WRAPS, so the busy marker `esc to interrupt` (claude/codex) lands on a wrapped
continuation that `capture-pane` truncates. `busyMatch` then returns false for an agent that is
actively working, so `classifyState` returns **`done`** instead of `running` — and `agi wait` / `agi
state` / any orchestration on top mis-fire. Verified: a 48-col session reported `state=done` while
mid-turn; `tmux resize-window -x 120` made `state` correctly report `running` again. So state
detection is **width-fragile**, which undermines F1's reliability.

## Fix
Make orc's sessions render at a stable, wide size so a status line never wraps:
1. In `tmux.ts spawn`, create the session at a fixed wide size — add `-x <W> -y <H>` to `new-session`
   (e.g. `-x 200 -y 50`). Pick W comfortably wider than the longest status line.
2. Keep it stable so a later (e.g. read-only) `agi attach` from a narrow terminal can't shrink the
   window and reintroduce the bug for subsequent `capture`s: set the session's `window-size` to
   `manual` (e.g. `tmux set-option -t <name> window-size manual`, or `new-session`'s equivalent), OR
   document why it isn't needed. Pin a single source-of-truth constant for the width.
3. (Defense in depth, optional) consider whether `capture()` should request a stable width, but the
   creation-size fix is the primary one.

Do NOT paper over it by loosening `busyMatch` to match a fragment — fix the width so the FULL marker is
always present.

## Constraints
- Bun + TypeScript, ESM, match style, NO new deps. `bun run typecheck` clean, `bun test` green.
- Unit-test that `spawn`'s `new-session` argv includes the width/height flags (assert against the
  built argv — refactor a tiny `buildSpawnArgs(name,cwd,argv)` pure helper if needed so it's testable
  without running tmux).

## Verification — REQUIRED, real CLIs (gates done)
Throwaway `ORC_HOME`. For claude AND codex:
1. Spawn a session; assert its pane width (`tmux display -p -t <name> '#{pane_width}'` or
   `list-panes`) is the wide value (≥120), NOT a narrow inherited width.
2. Send a ~12s tool-run (`for i in $(seq 1 12); do echo t$i; sleep 1; done`). Assert `agi state` reads
   `running` DURING it (this is the case that was broken at 48 cols) and `agi wait --for done` returns
   `done` only after it finishes.
3. (Regression nicety) confirm `agi read` of the session is not wrapped mid-word for the status line.
4. Clean up: kill sessions, remove throwaway ORC_HOME, restore `~/.codex/config.toml`. Inside tmux;
   prefix nested spawns with `TMUX= ` if needed.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
