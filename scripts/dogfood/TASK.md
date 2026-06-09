# Task: make `agi read` token-efficient (parsed transcript by default; `--raw` = pane)

## Context
You are an autonomous coding agent working inside an **isolated git worktree** of the `orc`
project — a multi-agent orchestration tool that launches coding-agent CLIs (claude/codex/pi) as
interactive tmux sessions and exposes a Bun/TypeScript SDK plus an `agi` CLI.

First, orient yourself:
- Run `bun install` (this worktree has NO `node_modules` yet — worktrees don't share it).
- Read `README.md`, `docs/ARCHITECTURE.md`, then `src/cli/index.ts` (the `cmdRead` function),
  `src/session.ts`, and `src/providers/{claude,codex,pi}.ts`.

Your cwd is a worktree on a feature branch — commit here; do NOT touch `main`.

## Goal
Today `agi read <id>` captures the raw tmux pane (token-heavy: box-drawing, ANSI, repeated UI
chrome). Change `read` so:

- **Default** `agi read <id>` renders a **token-efficient parsed transcript** read from the
  provider's on-disk JSONL message log: the conversation turns PLUS one-line tool-call summaries.
  NO raw tool outputs, NO reasoning/thinking, NO UI chrome.
- **`agi read <id> --raw`** renders the full tmux pane exactly as tmux shows it (the current
  behavior, WITH scrollback). This is the escape hatch when the transcript isn't enough.
- Keep **`--json`** for the default mode — emit structured parsed turns (an array), not the pane.
- **Retire `--scrollback` and `--transcript`** (pre-release, breaking is fine): `--raw` supersedes
  `--scrollback`; the parsed default supersedes `--transcript`. These flags are referenced in more
  than one place — update ALL of them or `bun test` will fail on stale references: the `cmdRead`
  parser, **`HELP_TEXT` in `src/cli/output.ts`**, the **`agi read` line in `README.md`**, and any
  **tests** that reference the removed flags (e.g. `test/cli.test.ts`).
- **Fallback:** if no on-disk transcript exists yet (just booted / nothing written), fall back to a
  pane capture and note that, so `read` always shows *something*.
- **Mirror in the SDK:** add a `Session` method (e.g. `readParsed(): Promise<Turn[]>`) plus the
  render helper, so SDK consumers get the same token-efficient view. Keep the existing
  `capture()` / `readTranscript()` methods.

## Verified on-disk formats (confirmed live — use these; re-verify if you wish)
- **claude** → `~/.claude/projects/<slug>/<sessionId>.jsonl`. Each line is a JSON object with a
  `type`. Conversational lines are `type:"user"` and `type:"assistant"`, each carrying a `message`
  whose `content` is EITHER a string OR an array of blocks:
  `{type:"text",text}`, `{type:"tool_use",name,input}`, `{type:"tool_result",content}`.
  The resolver already exists (`ClaudeAdapter.resolveTranscript`, globs `rec.sessionId`).
  - **IMPORTANT CORRECTION:** the comment in `src/providers/claude.ts` (around `resolveTranscript`)
    and a note in `README.md` claim an orc-launched *interactive* claude writes ONLY an `ai-title`
    event and the turns are never on disk. That is **OUTDATED / WRONG** — verified: the file
    contains the real `user`/`assistant` turns. Re-verify yourself, then FIX that code comment and
    the README note so they match reality.
- **codex** → `~/.codex/sessions/Y/M/D/rollout-*.jsonl`. Each line has a `type`. The clean
  conversational turns are `type:"event_msg"` with `payload.type:"user_message"` (user text in
  `payload.message`) and `payload.type:"agent_message"` (assistant text in `payload.message`).
  Tool/command activity shows up in other `event_msg` payloads and in `response_item` lines —
  summarize those you can identify as one-liners; ignore `session_meta`/`turn_context`/`token_count`.
  Resolver already exists (`CodexAdapter.resolveTranscript`, matches cwd + mtime).
- **pi** → the `--session-dir` orc already passes; file `*_<sessionId>.jsonl`. Best-effort: inspect a
  real pi transcript if `pi` is installed; otherwise implement to the same normalized shape and add a
  code comment that pi parsing is UNVERIFIED. Do not block on pi.

## Suggested shape (refine as you see fit)
- New `src/transcript.ts` (or a `src/transcript/` dir):
  - `type Turn = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string }`
    (a tool turn's `text` is the one-line summary).
  - `parseTranscript(provider: Provider, jsonl: string): Turn[]` — provider-specific parsing.
  - `renderTurns(turns: Turn[]): string` — compact text, e.g. `<user> …`, `<assistant> …`,
    indented `  [Bash: git status]` for tool turns.
- A tool-call summary is ONE line: tool name + a short single-line arg hint, truncated to ~60 chars,
  e.g. `[Bash: echo hi]`, `[Edit src/x.ts]`, `[Read src/y.ts]`. Never include tool OUTPUT.
- Wire `cmdRead` to use parsed-by-default and `--raw` for the pane; add `readParsed()` to `Session`.

## Constraints
- Bun + TypeScript, ESM, match the surrounding code style and comment density. **No new dependencies.**
- `bun run typecheck` must be clean and `bun test` green.
- Add unit tests with small fixture `.jsonl` files for **claude AND codex** parsing (assert the
  normalized turns and the tool-call summaries). Put fixtures under `test/fixtures/`.

## Verification — REQUIRED, real CLIs, not mocks (this gates "done")
Project rule: verification must use **real** interactive CLI runs. Use a throwaway
`ORC_HOME="$(mktemp -d)/orc"` so you never touch the real `~/.orc`. From your worktree:

1. Spawn a real **claude** session that will invoke a tool, e.g.:
   `ORC_HOME=… bun run src/cli/index.ts spawn -p claude --prompt "use your Bash tool to run the shell command: echo HELLO_DOGFOOD — then reply that you are done" --json`
2. Give it time, then compare:
   `bun run src/cli/index.ts read <id>` (parsed) vs `bun run src/cli/index.ts read <id> --raw` (pane).
   Confirm the parsed output shows the user turn, the assistant text, AND a `[Bash: echo HELLO_DOGFOOD]`
   -style summary, and that it is **dramatically smaller in bytes** than `--raw`. Print both byte sizes.
3. Repeat with **codex** (`-p codex`; prompt: "run `echo HELLO_DOGFOOD` in the shell, then say done").
4. Clean up: kill the sessions (`… kill <id> --worktree --purge`), remove the throwaway `ORC_HOME`,
   and remove any **codex trust entries your test added** to `~/.codex/config.toml` for temp paths
   (leave pre-existing entries intact).

Note: you are running INSIDE a tmux session, so spawning nested sessions should work; if `tmux`
refuses a nested session, prefix the command with `TMUX= ` to detach from the outer server.

## When done
1. Run `bun run typecheck` and `bun test` — both must pass.
2. `git add -A && git commit` on THIS branch with a clear message summarizing the change.
3. As your FINAL output, print on its own line, exactly:

   `DOGFOOD_COMPLETE`

   If you become blocked and cannot proceed, instead print on its own line:

   `DOGFOOD_BLOCKED: <one-line reason>`
