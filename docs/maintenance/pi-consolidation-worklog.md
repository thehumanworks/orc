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

The implementation and documentation were published as `fb5f40b` and `53d8ee3` in
[PR #4](https://github.com/thehumanworks/orc/pull/4). The repository owner merged that PR
at 2026-10-18 12:30:16 UTC and confirmed the merge in the task conversation. The merge commit
`4b1c2b03a427ff880d5bd473997bb4851870a176` has the same tree as the final verified implementation.
The coordinator did not merge the PR.

### Follow-up from main

At the owner's request, remaining hosted-CI corrections use a new branch, `fix/pi-contract-ci`,
from that merge commit. The follow-up PR must remain open for review. No unrelated local changes
were present when the branch was created.

Hosted checks on the original PR head `53d8ee3` exposed two introduced verification defects:

| Check | Observed result and correction |
| --- | --- |
| [Linux/macOS tests and native binaries](https://github.com/thehumanworks/orc/actions/runs/39127536223) | Linux tests and all four compiled-binary smoke jobs passed. The macOS continuation test passed its history/model/persona assertions, then failed during teardown with `EPERM` while signalling Pi immediately after closing stdin. Give Pi a bounded orderly EOF shutdown before process-group termination; retain the assertions and failing cleanup errors. |
| [Nix on Linux x64/ARM and macOS ARM](https://github.com/thehumanworks/orc/actions/runs/39127536233) | Dependency hashes and ORC compilation succeeded on all three platforms; the new smoke failed. A minimal-PATH reproduction confirmed `git` was missing when session spawn resolves its workspace. Add Git to the smoke inputs and print failure JSON before propagating the nonzero status. |

The validation agent owns `flake.nix`; the integration agent owns the native Pi continuation
test cleanup. The durability agent independently reviews both changes, and the coordinator
owns this log, combined verification and publication. Production provider and process code
remain outside this follow-up's scope. Both fixes passed independent review with no unresolved
material findings. The coordinator also reviewed the complete diff.

Follow-up verification before the next concurrent main update:

- Exact Pi 1.2.0 OpenAI and lifecycle contracts: **17 passed / 0 failed**, 99 assertions.
  Both native continuation cases now also require normal exit code 0. The test deadline allows
  the existing two RPC deadlines and the bounded EOF/termination/pipe-drain cleanup.
- The exact Nix smoke shell fragment, with a minimal PATH: without Git, **exit 1** with both
  provider errors printed and no success marker; adding Git, **7/7 checks passed**, exit 0,
  success marker created and empty stderr. This establishes the dependency and diagnostic
  correction locally; it does not substitute for a hosted Nix build.
- Coordinator's full suite with the exact Pi test install: **944 passed / 14 skipped / 0 failed**,
  **10,395 assertions**, 63 files. The 14 skips remain the opt-in authenticated Claude contract.
- Coordinator's typecheck: **PASS**. Final compiled smoke: **7/7 PASS**; 183 bundled modules.
  `git diff --check`: **PASS**. No new compiler/build warnings were observed.
- Live provider access is still blocked by the credentials limitation recorded above. These
  CI corrections add no model/authentication, provider, storage or replay behavior.

[PR #5](https://github.com/thehumanworks/orc/pull/5) was opened with the exact verified tree.
During publication, the owner also merged [PR #3](https://github.com/thehumanworks/orc/pull/3),
advancing main to `8fb537ec9b5a2c645dcf0a184c1baa1e638c4db6`. That merge includes workflow
customization and overlapping Nix/Pi cleanup corrections. The coordinator incorporated that
main commit into the follow-up branch before requesting fresh CI:

- Preserve all workflow changes from main, including `orc.workflows` in Nix's typecheck sources.
- Resolve the two overlapping files using the reviewed smoke exit-status handling and bounded
  Pi cleanup, including the new clean-exit assertion. The Pi test remains byte-identical to the
  first follow-up's verified version; the Nix smoke fragment also remains unchanged.
- Both resolutions were independently reviewed against both parents, with no material findings.
  Comparison against main confirms that only the intended three follow-up files differ.

Final combined verification after incorporating main's additional production code and tests:
**973 passed / 14 skipped / 0 failed**, **10,562 assertions**, 67 files. Typecheck and all
**7/7 compiled smoke checks passed**; the added workflow-loader module brings the bundle to
184 modules. Whitespace checks pass, and no new compiler/build warnings were observed.
The unchanged Pi contracts and Nix smoke fragment retain their focused evidence above.

The new PR's latest-commit hosted results are recorded in its description and GitHub Checks.
Platform success is never inferred from a local Linux run; macOS and all three Nix jobs must
be checked after publication, and the follow-up PR must remain open.
