# Runtime verification

ORC has two production integrations: Pi RPC and Claude stream-json. OpenAI and Codex models
run through Pi; there is no separate Codex gate or ORC-owned login.

## Live verification

Use an authenticated macOS or Linux host with Bun ≥ 1.3.3. The retained protocols are verified
against Pi 1.2.0 and Claude Code 2.1.300. Choose an inexpensive chat model available to your
account before running the suite:

```sh
pi                              # /login → Sign in with ChatGPT, or configure OPENAI_API_KEY
pi --list-models openai          # choose an available chat model, not a classifier
pi auth check --model openai/gpt-5.4-mini --json --no-refresh
claude auth status --json
bun scripts/verify-runtime/all.ts --claude-model haiku --pi-model openai/gpt-5.4-mini
```

The model above is an example; Pi's available catalog and the account's entitlement decide
which models can run. Authentication is managed by the native provider, including refreshes.
`pi auth check` is called without `--credentials`, and no tokens are printed or copied by ORC.

| Flag | Meaning |
| --- | --- |
| `--providers claude,pi` | Integrations to check; default is both |
| `--claude-model M` / `--pi-model M` | Explicit model for each integration; omitted uses its native default |
| `--claude-bin P` / `--pi-bin P` | Another executable; `.ts` and `.js` files run with Bun, useful for protocol fixtures |
| `--no-runtime-gates`, `--no-e2e`, `--no-workflow` | Skip the corresponding section |
| `--results FILE` | JSON report location; default `verify-results.json` (gitignored) |
| `--keep` | Keep temporary state for diagnosis; processes are still stopped |
| `--help` | Usage |

The removed `--codex-model`, `--codex-bin`, and `--providers codex` options are rejected. Use
`--pi-model openai/<model-id>` instead.

Each row is PASS, FAIL, or SKIP; any FAIL exits 1. A missing executable is SKIP. When the native
status command reports no credentials, preflight records **SKIP: blocked** and skips that
provider's live checks. Pi's native status check requires an explicit model, so pass
`--pi-model` for this preflight. Older/custom binaries without status output are tested by the
runtime gate. Model/configuration errors are not converted into credential skips. Exit 0 with
SKIP rows does not establish live-provider validation: read the rows and report unavailable
credentials or environments as blocked checks.

## What the suite checks

| Row | Required behavior |
| --- | --- |
| `preflight` | Resolve the native executable, version, and supported non-secret authentication readiness |
| `runtime gate` | Fresh start, multiline turn, second turn, interruption, close, resume with history, and post-resume turn |
| `e2e spawn (3-line prompt) → wait done` | Detached actor starts and the initial turn settles |
| `e2e read → assistant reply word` | The provider transcript contains the reply; journal fallback or matching only prompt text fails |
| `e2e send --idempotency-key k2 (+ replay)` | Initial send is acknowledged; replay returns the recorded delivery without another turn |
| `e2e SIGKILL actor → list shows suspended` | An actor crash becomes a suspended session |
| `e2e send wakes it and recalls the codeword` | Next send resumes the native session and retains prior conversational history |
| `e2e exactly one provider process for the session` | Old provider process exits; one replacement remains, checked by PID and start time |
| `e2e takeover → resume command; send refused` | Native takeover command is printed; further sends remain stopped |
| `e2e resume → send works` | Explicit handback restores a usable session |
| `e2e kill → prune` | State and registry entry are removed deliberately |
| `e2e no orc/provider processes left` | Every process the check started is stopped, including after a failure |
| Detached workflow rows | Two-step Claude workflow runs detached, attaches through completion, succeeds, and cleans up |
| `tmux never invoked` | A logging trap placed first on PATH is never called |

Runtime-only gates are also available:

```sh
bun scripts/verify-runtime/claude.ts --model haiku
bun scripts/verify-runtime/pi.ts --model openai/gpt-5.4-mini
```

## Offline and compiled checks

```sh
bun test
bun run typecheck
bun run check:compile
bun scripts/verify-runtime/install-pi-test-tooling.ts /tmp/orc-pi-test
ORC_TEST_PI_BIN=/tmp/orc-pi-test/node_modules/.bin/pi bun test test/runtime-pi-contract.test.ts test/runtime-pi-openai.test.ts
```

`check:compile` builds the standalone binary and runs `compiled.ts`. The smoke compiles the
scripted Pi and Claude fixtures into native executables, then drives them through the supplied
ORC binary. It checks the embedded version, help, settings, cwd autoload isolation, explicit
Pi/OpenAI selection, both adapters, duplicate/conflicting sends, crash/wake, takeover/resume,
and cleanup. Native binary CI and the Nix smoke reuse this check. `test/compiled-cli.test.ts`
additionally validates the compiled daemon `/health`, MCP negotiation and tools, and settings.
These are real compiled ORC processes with **scripted provider protocols**, not authenticated
model requests.

The Pi contract tests run the **real Pi CLI** against local mock model endpoints with isolated
configuration and test credentials. They validate Pi protocol and auth routing without claiming
that a real account or remote model accepted a request. If no actual Pi binary is available,
they register visible skips. Use a consistent Pi release: the validation environment pins all
`@earendil-works/pi-*` sibling packages to 1.2.0 because the CLI package's caret dependencies can
otherwise install newer siblings.
The installer derives that pin from `PI_VERIFIED_VERSION`, checks the installed sibling
versions, and keeps all test tooling outside the ORC checkout. Linux and macOS CI run it
before `bun test`, so these real-Pi/local-endpoint contracts are required checks there.

## Isolation and cleanup

Every ORC command uses a temporary `ORC_HOME` and working directory. User ORC state is not read
or written; inherited `ORC_*` lineage/test values are removed. Native provider configuration and
authentication are reused by live checks; providers may refresh their own credentials. Pi's
session files stay under the temporary ORC state. Claude's transcripts from this run are removed
unless `--keep`; Claude may retain its own project entry in its configuration.

Ctrl-C stops detached workflow runners first, then child checks, then the actor/provider
processes owned by the run. Existing user processes are never targeted. Temporary Git repos
disable hooks and commit signing with per-command flags. Reports contain no tokens, emails, or
environment values, and abbreviate user home paths.

Process tests require normal POSIX PID and process-group visibility. If an execution sandbox
hides spawned PIDs from `ps` or `/proc`, run the checks in a native environment with that
visibility; do not weaken the process-lifecycle assertions to accommodate the sandbox.
