# verify-runtime

Live checks for orc's tmux-free actor runtime. Run them on an authenticated macOS or Linux
host.

## One command

```sh
bun scripts/verify-runtime/all.ts --claude-model haiku --codex-model <cheap codex model> --pi-model <provider/cheap-model>
```

Pass a cheap model for every provider you have. A provider without a model flag uses your
own default model, and the run prints a note for each one.

| flag | meaning |
|---|---|
| `--providers claude,codex,pi` | which providers to check (default: all three) |
| `--claude-model M` / `--codex-model M` / `--pi-model M` | model per provider (default: the provider's own default; pass a cheap one) |
| `--keep` | keep the temp root for debugging: each ORC_HOME's registry and workflow runner log, the tmux shim log, and this run's claude transcripts. Sessions are still killed and pruned, so their journals are gone either way. |
| `--claude-bin P` / `--codex-bin P` / `--pi-bin P` | use another executable (a `.ts` file runs with bun), e.g. `--pi-bin test/fixtures/pi-chat-fake.ts` |
| `--no-runtime-gates`, `--no-e2e`, `--no-workflow` | skip those sections |
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
| `e2e read → assistant reply word` | the latest turn in `orc read --json` has an assistant reply containing the word. The prompt doesn't count, and falling back to the journal (no provider transcript) is a FAIL. |
| `e2e send --idempotency-key k2 (+ replay)` | the first send is acknowledged; the same key again returns `replayed: true`; the reply arrives |
| `e2e SIGKILL actor → list shows suspended` | the actor pid comes from `state.json` and is SIGKILLed; `orc list` then reports `suspended` |
| `e2e send wakes it and recalls the codeword` | the next `orc send` wakes the session in resume mode; the reply recalls the codeword from turn 1 |
| `e2e exactly one provider process for the session` | the pre-crash provider is gone and only the new one is live, checked by pid plus start time. For claude and pi, no other live process carries the session id. codex's argv has no session id, so for codex only the identity checks apply. |
| `e2e takeover → resume command; send refused` | `orc takeover` prints `cd … && <provider resume cmd>` and the provider exits; a further `orc send` is refused with an `orc resume` hint |
| `e2e resume → send works` | `orc resume` reports running; a new turn replies |
| `e2e kill → prune` | `orc kill`, then `orc prune` removes the record and the session dir |
| `e2e no orc/provider processes left` | no actor or provider process for the session survives (runs even after a failure, and kills any leak) |
| `workflow run --detach` / `attach follows to done` / `status` / `cleanup` | a detached two-step claude workflow (`--claude-model` is applied through `ANTHROPIC_MODEL`) is followed by `orc workflow attach` to `done`. Both steps must succeed, and cleanup must leave no processes. |
| `tmux never invoked` | a `tmux` shim placed first on PATH for everything above logs its argv and exits 127. Its log must be empty. |

## Safety

Ctrl-C stops what the run started in this order: detached workflow runners first, then the
run's own child processes, then every actor and provider. It then removes the temp root and
this run's claude transcripts.

- Every orc command runs with a temp `ORC_HOME`. Your `~/.orc` is never read or written.
- The working directory is a temp git repo.
- Inherited `ORC_*` lineage and test variables are dropped.
- Provider configs and auth are used as they are and never modified.
- Only processes started by this run are ever signalled.
- The claude transcripts this run creates (under `~/.claude/projects/*orc-verify-all-*`) are removed unless you pass `--keep`.
- Codex rollouts stay in your codex history.
- Residue: claude records a project entry for each temp working directory in `~/.claude.json`. claude writes those itself, and the run doesn't remove them.
- The temp git repos are created with hooks off and commit signing off, passed as `-c` flags. Your git config is read but never written.
- Output and `verify-results.json` never include environment variables, tokens or emails, and home paths are shown as `~`.

## Per-provider runtime gates

These check the runtime layer only, without orc's session layer:

```sh
bun scripts/verify-runtime/claude.ts [--model haiku] [--keep]
bun scripts/verify-runtime/codex.ts  [--model M] [--codex-bin P] [--keep]
bun scripts/verify-runtime/pi.ts     [--model provider/id] [--bin P] [--keep]
```
