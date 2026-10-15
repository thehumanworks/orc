# verify-runtime

Live checks for orc's tmux-free actor runtime. Run them on an authenticated macOS or Linux
host.

## One command

```sh
bun scripts/verify-runtime/all.ts --claude-model haiku
```

| flag | meaning |
|---|---|
| `--providers claude,codex,pi` | which providers to check (default: all three) |
| `--claude-model M` / `--codex-model M` / `--pi-model M` | model per provider (default: the provider's own default; pass a cheap one) |
| `--keep` | keep the temp dir (ORC_HOME, journals, raw logs) for debugging |
| `--claude-bin P` / `--codex-bin P` / `--pi-bin P` | use another executable (a `.ts` file runs with bun), e.g. `--pi-bin test/fixtures/pi-chat-fake.ts` |
| `--no-runtime-gates`, `--no-workflow` | skip those sections |
| `--results FILE` | where to write the JSON (default `verify-results.json` in the repo root, gitignored) |

It exits 1 if any check fails. A provider whose binary is missing is reported as SKIP, not as
a failure. Expect a few cents with haiku. Codex and pi use their default models unless you
pass a model.

## What each row checks

| row | check |
|---|---|
| `preflight` | the provider binary that orc's runtime would use (`$ORC_CLAUDE_BIN` / `$ORC_CODEX_BIN`, else PATH) and its `--version` output |
| `runtime gate` | `scripts/verify-runtime/<provider>.ts` exits 0. Its own table is echoed and saved under `runtimeGates`. |
| `e2e spawn (3-line prompt) → wait done` | `orc spawn --provider P --prompt <3 lines>` creates an actor session; `orc wait` reaches `done` |
| `e2e read → reply word` | `orc read` contains the one-word reply |
| `e2e send --idempotency-key k2 (+ replay)` | the first send is acknowledged; the same key again returns `replayed: true`; the reply arrives |
| `e2e SIGKILL actor → list shows suspended` | the actor pid comes from `state.json` and is SIGKILLed; `orc list` then reports `suspended` |
| `e2e send wakes it and recalls the codeword` | the next `orc send` wakes the session in resume mode; the reply recalls the codeword from turn 1 |
| `e2e exactly one provider process for the session` | the pre-crash provider is gone and only the new one is live |
| `e2e takeover → resume command; send refused` | `orc takeover` prints `cd … && <provider resume cmd>` and the provider exits; a further `orc send` is refused with an `orc resume` hint |
| `e2e resume → send works` | `orc resume` reports running; a new turn replies |
| `e2e kill → prune` | `orc kill`, then `orc prune` removes the record and the session dir |
| `e2e no orc/provider processes left` | no actor or provider process for the session survives (runs even after a failure, and kills any leak) |
| `workflow run --detach` / `attach follows to done` / `status` / `cleanup` | a detached two-step claude workflow (`--claude-model` is applied through `ANTHROPIC_MODEL`) is followed by `orc workflow attach` to `done`. Both steps must succeed, and cleanup must leave no processes. |
| `tmux never invoked` | a `tmux` shim placed first on PATH for everything above logs its argv and exits 127. Its log must be empty. |

## Safety

- Every orc command runs with a temp `ORC_HOME`. Your `~/.orc` is never read or written.
- The working directory is a temp git repo.
- Inherited `ORC_*` lineage and test variables are dropped.
- Provider configs and auth are used as they are and never modified.
- Only processes started by this run are ever signalled.
- The claude transcripts this run creates (under `~/.claude/projects/*orc-verify-all-*`) are removed unless you pass `--keep`.
- Codex rollouts stay in your codex history.
- Output and `verify-results.json` never include environment variables, tokens or emails, and home paths are shown as `~`.

## Per-provider runtime gates

These check the runtime layer only, without orc's session layer:

```sh
bun scripts/verify-runtime/claude.ts [--model haiku] [--keep]
bun scripts/verify-runtime/codex.ts  [--model M] [--codex-bin P] [--keep]
bun scripts/verify-runtime/pi.ts     [--model provider/id] [--bin P] [--keep]
```
