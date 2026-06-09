# Task: fix `Session.send()` for large (multi-KB) prompts

## Context
Isolated git worktree of `orc`. `bun install`, then read `src/session.ts` — specifically `send()`,
`pasteProbe()`, and `normalizePane()`. Commit on THIS branch; never `main`.

## The bug (root cause is understood — verify it, then fix)
`send()` does a verify-before-submit: paste the prompt → wait → capture the pane → confirm the prompt
landed in the composer → press Enter; retry up to 3× if not confirmed. The confirmation
(`pasteProbe`) checks that the **FIRST non-empty line** of the prompt is visible in the pane. For a
large multi-line prompt (≳1–2KB), the first line scrolls OFF the top of the composer (only the
BOTTOM/end of the paste, near the cursor, stays visible), so the probe never matches → all 3 attempts
"fail" → each attempt RE-PASTES without clearing (compounding the text) → `send()` throws
`prompt did not appear in the input box after 3 attempts`. This is why orc currently can't deliver a
multi-KB prompt and everything works around it with a file + short pointer (see `scripts/dogfood/run.ts`).

## Fix
1. **Probe the END, not the start.** A composer always shows where the cursor is — the END of the
   pasted text. Change the verify so it confirms a distinctive slice from the **end** of the prompt is
   visible (e.g. the last non-empty line, collapsed; if that line is short, include enough trailing
   context to be distinctive). This works for both small prompts (end ≈ start) and multi-KB prompts.
   Keep matching whitespace-insensitive (`normalizePane`), since the composer wraps/indents.
2. **Don't compound on retry.** If a retry IS still needed, clear the composer before re-pasting so a
   failed attempt can't stack the text 2–3×. Find a SAFE clear for each provider (do NOT send a key
   that could interrupt/exit — e.g. avoid Ctrl-C on pi which exits; prefer select-all+delete or the
   provider's line-kill). If no safe universal clear exists, document it and rely on the end-probe
   making retries rare; never leave the compounding behavior as-is.
3. Keep the existing behavior for the empty/whitespace-prompt case and the ready-gate.

## Constraints
- Bun + TypeScript, ESM, match style, NO new deps. `bun run typecheck` clean, `bun test` green.
- Keep `pasteProbe` (or its replacement) PURE and unit-test it: a single-line prompt, and a 200-line
  prompt → the probe is a slice that would appear at the BOTTOM of a composer, not the top.

## Verification — REQUIRED, real CLIs (gates done)
Throwaway `ORC_HOME`. For claude AND codex (pi if convenient):
1. Build a ~5KB multi-line prompt with a UNIQUE token on its FIRST content line (`STARTTOK_<rand>`)
   and a UNIQUE token on its LAST line (`ENDTOK_<rand>`), instructing the agent to "reply with exactly
   these two tokens separated by a space." Spawn a session and `agi send` (or `agent({prompt})`) it.
2. Assert `send()` SUCCEEDS (no throw) and the agent received the **FULL** prompt — its reply/transcript
   contains BOTH `STARTTOK_<rand>` AND `ENDTOK_<rand>` (proves the whole paste landed, not a truncated
   or tripled copy). Reading via `agi read` (parsed) is the cleanest check.
3. Sanity: a normal short prompt still sends fine.
4. Clean up: kill sessions, remove throwaway ORC_HOME, restore `~/.codex/config.toml`. Inside tmux;
   prefix nested spawns with `TMUX= ` if needed.

## Optional follow-up (note, don't necessarily do)
Once `send()` handles large prompts, `scripts/dogfood/run.ts` could deliver the task inline instead of
via the file+pointer workaround — but leave that change out of this task unless trivial.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
