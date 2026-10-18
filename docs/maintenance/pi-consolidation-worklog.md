# Pi and Claude consolidation — task and decision log

## Scope and baseline

- Request: remove the production Codex harness, route OpenAI/Codex models through Pi,
  retain Claude, and adopt pi-durable only if evidence shows a material maintenance benefit.
- Default branch: `main`, baseline `8fc7548cbac435eefd09ca6ba5bb1c7497311916`.
- Isolated implementation branch: `refactor/pi-claude-integrations`. Baseline verification
  uses a separate detached worktree. No unrelated user changes were present.
- Applicable instructions: root `AGENTS.md`; verify before committing; keep the PR open.

## Workstreams and ownership

| Workstream | Owner | Files / responsibility |
| --- | --- | --- |
| Coordination and compatibility | Coordinator | Shared log, SDK/types, CLI, HTTP, MCP, settings, workflows, registry/session/history compatibility and integration acceptance |
| Integration implementation | Integration agent | Pi runtime/protocol, provider factory, shared provider/model validation, removal of `src/codex/`, narrow Pi regression tests |
| Durability evaluation | Durability agent | Upstream source/version audit and pi-durable decision; architecture/user documentation after agreement |
| Baseline and validation | Validation agent | Baseline, dependency/build/CI/Nix updates, compiled and live verification scripts; independent review of implementation it did not author |

Production edits are separated by file ownership. Findings and dependencies are exchanged
directly among agents; the coordinator reconciles them here. Only the coordinator commits.

## Decisions and material assumptions

1. **Preserve the existing execution interface.** Pi is an external CLI driven by RPC;
   Claude is an external CLI driven by stream-json. ORC's Codex integration is an ORC-owned
   harness built on `@earendil-works/pi-ai` and `pi-agent-core` 1.2.0, not a Codex CLI or
   app-server adapter. The two libraries are imported only by that harness and can be removed.
2. **New selections use `pi` or `claude`.** Reject `codex` as a new execution provider with
   actionable migration guidance instead of silently choosing an authentication route/model.
   OpenAI is a model provider inside Pi, distinct from ORC's execution-provider selection.
3. **Historical state remains historical.** Keep stored Codex records, journals and transcript
   readers. Never rewrite or replay a historical delivery automatically. Provide an explicit
   Pi continuation path for the old harness's Pi-format transcript where supported; older
   incompatible records receive instructions rather than being restarted by the removed harness.
4. **Skip pi-durable.** The [decision](../decisions/pi-durable.md) inspects upstream 1.2.0
   and 1.3.0. Durable exposes an embedded harness, not a persistence layer for Pi RPC. ORC
   would keep ownership, external-process delivery, Claude and workflow responsibilities and
   add storage/process adapters and migration. No material net reduction was demonstrated.
   No new durability dependency, storage format or replay policy is introduced.
5. **Provider verification is honest.** Offline protocol fixtures are not live-provider tests.
   Missing provider credentials, executables or platform environments are reported separately.

6. **Exact Pi model choices are checked by Pi.** Split a qualified selection into Pi
   `--provider` and `--model` arguments. Confirm session identity, selected model and membership
   in Pi's authenticated available-model list before a prompt. This prevents provider fallback
   and acceptance of synthetic metadata for an unconfigured model. Bare Pi aliases retain
   Pi's resolution. Pi owns custom model configuration and authentication.
7. **Continuation is explicit.** New `codex` selections and `[models].codex` fail with migration
   instructions. Stored provider values are retained separately from executable provider types.
   Compatible harness v3 transcripts can continue in native Pi after takeover, with their active
   branch's OpenAI model, cwd and persona. They cannot be handed back to ORC. Unsupported data
   receives actionable errors; old workflow plans/attempts/defaults are never silently converted.
8. **Test the actual pinned Pi release.** Pi CLI 1.2.0's sibling dependencies have version
   ranges. An isolated test installer pins all six scoped siblings to 1.2.0 and verifies them.
   CI runs these local-endpoint contracts on Linux and macOS using Node 24.19.0. Pi remains
   outside ORC's shipped dependency graph.

## Scope audit

- Removed the dedicated runtime factory, `src/codex/` harness, protocol, tools, OAuth/login,
  token refresh, model discovery/cache, transcript writer, hidden CLI dispatch and standalone
  verification gate. Removed its two direct runtime dependencies after checking all importers.
- Updated CLI/SDK/HTTP/MCP provider and model validation, settings, agent definitions, workflow
  launch and recovery, help, shipped workflows, the bundled agent skill, build hooks and Nix.
- Retained Claude's runtime and protocol unchanged. Pi and Claude share the existing actor,
  mailbox, journal, stop, process cleanup and workflow ownership machinery.
- Remaining `codex` references are deliberate: historical record/transcript readers and
  migration errors; regression fixtures; old tmux file cleanup; historical design records;
  OpenAI/Pi model IDs; and Codex CLI configuration as an MCP **client**.
- Lockfile installation decreased from 103 packages to 19; compiled CLI bundling decreased
  from 1,134 modules to 183. These are observed baseline/final build counts, not a claim about
  Pi's separately installed dependency tree.

## Verification ledger (2026-10-18)

Baseline and final results are recorded below as checks complete. Required gates are derived
from `package.json`, `.github/workflows/`, and the Nix package: tests, typecheck, compiled binary
smokes, platform builds, Nix package checks, and live provider gates where authenticated.

- Baseline: PASS on the exact default-branch commit: `bun test` 957 passed / 27 skipped / 0 failed (10,206 assertions); typecheck PASS; compiled version + original harness smoke PASS. Bun 1.4.2. Tests require normal process visibility; a restricted-process run was stopped and replaced by the native baseline. The optional real-Pi contract is recorded separately from the default suite.
- Optional baseline actual-Pi contract: 11 passed / 1 failed on exact Pi 1.2.0. The existing
  close-open-turn test raced server emission against Pi consuming the first text chunk. It
  now waits for Pi's observed text event and retains the partial-transcript persistence assertion.
- Final combined branch: `ORC_TEST_PI_BIN=<isolated exact Pi 1.2.0> bun test` — **944 passed,
  14 skipped, 0 failed**, 10,393 assertions, 63 files. All remaining suite skips are the
  opt-in authenticated Claude contract. Bun 1.4.2; Node 24.19.0; native Linux x64.
- Final `bun run typecheck`: **PASS**. Final `bun run check:compile`: **7/7 PASS**, including
  both retained adapters, Pi/OpenAI selection, parsed Pi transcript, duplicate/conflicting
  submissions, actor crash/wake, takeover/resume and purge. Compiled daemon/MCP/settings
  and autoload checks also run in the full suite. `git diff --check`: **PASS**.
- Real Pi/local-endpoint tests exercise API-key routing, synthetic stored ChatGPT OAuth
  precedence, Pi's own write tool, rejection before requests, interruption, and linear/branched
  historical session continuation. They do **not** establish live account access or a completed
  OAuth login/refresh against OpenAI.
- Live verification with installed Pi 1.2.0 and Claude 2.1.300, requested models
  `openai/gpt-5.4-mini` and `haiku`: **BLOCKED by missing credentials**. Native non-secret
  preflight reports no Pi credential and no logged-in Claude account. The report is 1 isolation
  pass / 7 skips / 0 failures; no authenticated model request is claimed.
- The updated compiled-smoke cleanup was also exercised with deliberately malformed spawn
  JSON: execution correctly failed, cleanup found sessions absent from the successful-response
  set, and no live fixture actor/provider remained.
- Nix is unavailable locally. The dependency NAR calculation reproduced the baseline hash
  before deriving the updated hash. Actual Nix/platform builds remain hosted CI gates.
- Bundled skill validation (`quick_validate.py`) and local Markdown links: **PASS**. No new
  compiler/build warnings were observed; existing warning-behavior assertions remain.

## Independent review and resolution

| Reviewer / implementation reviewed | Material finding | Resolution and evidence |
| --- | --- | --- |
| Validation agent / coordinator public interfaces and workflows | Detached launch could persist invalid or removed-provider defaults before rejecting them | Shared validation now precedes record creation and runner spawn; zero-write/zero-spawn regression tests pass |
| Integration agent / coordinator recovery and historical sessions | Recovery reconciliation could rewrite an old run before provider rejection | Stored plan/result/attempt/default guards precede reconciliation and owning writes; failed and dead-running records stay byte-identical through SDK/CLI and detached resume/retry |
| Integration agent / coordinator native continuation | Last model change in the file might belong to an inactive Pi branch; missing persona paths become literal Pi prompt text | Active parent-chain metadata selects the model, explicit provider/model flags prevent fallback, missing personas fail; coordinator independently reviewed the implementation, and actual Pi linear/branched continuation tests pass |
| Durability agent / integration agent Pi runtime | Review of explicit selection, readiness, identity, shutdown and protocol mapping | No material finding; compared pinned upstream resolver/RPC source and actual Pi contracts |
| Durability agent / validation agent compiled and CI checks | Replacement smoke needed parsed-transcript coverage and cleanup after malformed spawn output; Pi CI needed an explicit Node runtime | Parsed Pi read is required, cleanup discovers isolated session directories and reports failures, and CI pins Node; all fixes independently reviewed and checked |

All material review findings were resolved before the final combined test run. File ownership
was explicit before edits; only the coordinator integrates and publishes commits.

## Implementation acceptance

- [x] Pi and Claude are the only production execution integrations.
- [x] OpenAI/Codex model selection and supported Pi authentication routes are checked against a pinned version; live account access is explicitly blocked.
- [x] CLI, SDK, HTTP, MCP, settings, agent definitions, workflows, skill and packaging are consistent.
- [x] Historical data and readable history are preserved; continuation/refusal is deliberate.
- [x] The pi-durable skip decision is supported by evidence.
- [x] Focused regression coverage and final combined local checks pass.
- [x] Live checks distinguish available evidence from external blockers.
- [x] Independent review findings are resolved.

## Publication gate

This log records the implementation state prepared for publication. The coordinator publishes
coherent implementation/documentation commits, opens a PR against `main`, checks hosted CI on
the latest commit and resolves introduced failures. Post-publication results are recorded in
the PR description and its GitHub Checks; they are not inferred from local checks. Leave the
PR open for review and do not merge it. Shell Git push credentials are absent in this environment;
the authenticated GitHub connector can publish the same verified commit trees instead.
