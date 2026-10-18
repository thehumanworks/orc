# Migrate the dedicated Codex integration to Pi

ORC now has two production integrations: **Pi** and **Claude**. OpenAI/Codex model execution
runs through Pi's CLI and RPC interface. The separate Claude integration keeps its native
CLI, settings, agent definitions, permission handling and session behaviour.

The removed implementation was ORC's own Responses API harness, built on pi-ai and
pi-agent-core 1.2.0. It was not a Codex CLI or app-server adapter. ORC no longer maintains its
tool loop, custom wire protocol, OAuth/login, token refresh, model catalog/cache or session-file
writer. It also no longer bundles those two Pi libraries.

ORC's mailbox, journal, actor leases and workflow records remain. The
[pi-durable decision](decisions/pi-durable.md) explains why adding that separate embedded
harness would increase maintenance for the retained Pi CLI + Claude architecture.

## Install and authenticate Pi

Install Pi on the **execution host**. For `--host`, that is the daemon host; signing in only on
the client does not authenticate the remote Pi process. The interface used by this change is
Pi CLI **1.2.0**. Other versions are not rejected by version alone; their RPC/model responses
must satisfy the same checks.

```sh
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
pi --version
pi
```

The npm command pins the CLI package, not all transitive dependencies: its 1.2.0 manifest uses
ranges for other Pi packages. Keep a lockfile or use the corresponding upstream pinned release
artifacts when a reproducible Pi installation is required. npm installations require Node
>=22.19.0. ORC's own source/compiled-binary requirements are unchanged.

Choose either route supported by Pi 1.2.0's `openai` provider:

| Authentication | Setup |
| --- | --- |
| Sign in with ChatGPT | Inside Pi run `/login openai`, then choose **Sign in with ChatGPT**, and finish the provider's flow. |
| OpenAI API key | Export `OPENAI_API_KEY` in the environment launching ORC/Pi, or store the key through Pi's `/login`. |

Pi owns credential storage and refresh. Its stored `auth.json` credential takes precedence over
`OPENAI_API_KEY`; use Pi `/logout` to remove that stored credential if you intend to use the
environment key instead. An already valid Pi login can be reused. ORC does not inspect or copy
it into another store.

`orc login`, `orc logout` and `orc login status` now return removed-command errors with Pi
instructions. Existing `$ORC_HOME/auth/chatgpt.json`, the old `ORC_AUTH_DIR`, device identity
and model-cache files are left untouched and unused. Sign in through Pi; do not assume old
ORC and Pi OAuth registrations or refresh-token copies are interchangeable.

The checked source is Pi v1.2.0
([OpenAI provider/auth definitions][openai], [authentication precedence][models]). A supported
authentication route does not establish that every account is eligible for every model. Confirm
access on the host where the agent will run.

## Model selection

List models through Pi, then choose a **chat** model available to your account:

```sh
pi --list-models
pi --list-models gpt
orc spawn --provider pi --model openai/gpt-5.5 --prompt "reply READY"
```

`pi` is the ORC integration. `openai` is a Pi model provider. The model ID after the slash is
provider-specific; use Pi's list rather than blindly prefixing an old model name.

For qualified selections (`provider/model-id`, optionally followed by Pi's supported
`:thinking` suffix), ORC passes the provider and model separately and checks both the selected
model and `get_available_models` before sending any prompt. Typos, unavailable models and
unconfigured custom IDs fail startup. Pi sometimes constructs metadata for an unlisted ID;
ORC deliberately requires the configured available-model list to confirm an explicit choice.
Add custom/new models in Pi's [`models.json`][models] first. Existing bare Pi aliases and
patterns keep Pi's normal resolution; no model override uses Pi's configured default.

The former ORC harness selected the first account-listed model when none was specified. That
default is gone. Set a qualified model explicitly or select/save a default in Pi. Pi
`openai-codex/<model-id>` is a distinct legacy backend with distinct authentication. It remains
usable through the Pi integration when configured, but is never silently substituted for
`openai/<model-id>`.

## Configuration and public interfaces

Update both global `$ORC_HOME/settings.toml` and any selected project `.orc/settings.toml`.
The removed `provider = "codex"` and `[models].codex` are actionable errors, not silent aliases
or ignored defaults. ORC does not rewrite these files.

Before:

```toml
provider = "codex"
[models]
codex = "gpt-5.5"
claude = "haiku"
```

After:

```toml
provider = "pi"
[models]
pi = "openai/gpt-5.5"
claude = "haiku"
```

If `[models].pi` already has a value, choose the intended default explicitly. ORC cannot infer
whether to replace it. For hosts serving both old and new clients, update callers as well as the
daemon; a new caller pointed at an old daemon does not upgrade that daemon's implementation.

| Surface | Replacement |
| --- | --- |
| CLI | `orc spawn -p pi -m openai/gpt-5.5` |
| SDK | `agent({ provider: 'pi', model: 'openai/gpt-5.5', prompt: '…' })` |
| HTTP session creation | `{"provider":"pi","model":"openai/gpt-5.5","prompt":"…"}` on the existing session-create route |
| MCP `spawn` | `provider: "pi"`, `model: "openai/gpt-5.5"` |
| Workflow definitions | Change the step's `provider` to `pi`; choose `[models].pi` before starting the run. |

New inputs accept only `pi` and `claude`. Historical `codex` fields in stored records are data
for reading and migration; they do not select a retained executor. Codex CLI MCP client
configuration (for example `codex mcp add orc -- orc mcp`) remains valid because the client can
drive ORC regardless of the integration used for its child agents.

## Agent definitions

ORC no longer discovers `.codex/agents/*.toml`, `.codex/prompts/*.md`, or their `CODEX_HOME`
equivalents for new agents. For Pi, move the old TOML `developer_instructions` or Markdown
prompt body to `<project>/.claude/agents/<name>.md` or `~/.claude/agents/<name>.md`, preserving
the original file if it is also used by another client. For example:

```markdown
---
name: reviewer
description: Review implementation correctness
---
Review the diff, identify correctness regressions, and report evidence for each finding.
```

```sh
orc spawn -p pi --agent reviewer -m openai/gpt-5.5
```

Pi receives the resolved Markdown body as its system prompt. Claude-specific frontmatter
model aliases are not applied to Pi; pass `--model`, or configure Pi's default. `--agent`
continues to bypass the ordinary ORC `[models]` fallback. Claude's native `--agent` resolution
and behaviour are unchanged.

## Environment and runtime behaviour

| Former harness setting | Pi path |
| --- | --- |
| `OPENAI_API_KEY` | Still supported, now consumed by Pi's `openai` provider. |
| `PI_CODING_AGENT_DIR` | Pi's own auth/settings directory; no ORC credential fallback reader. |
| `ORC_AUTH_DIR` | Unused. Authenticate using Pi's own directory and login flow. |
| `ORC_CODEX_THINKING` | Pi's `defaultThinkingLevel` / `modelThinkingLevels`, or a supported model `:thinking` suffix. |
| `ORC_CODEX_MAX_RETRIES` | Pi's retry settings; ORC does not translate the environment variable. |
| `ORC_CODEX_BOOT_TIMEOUT_MS` | Unused. `ORC_ACTOR_READY_TIMEOUT_MS` still bounds provider readiness for all integrations. |
| `CODEX_HOME` | No longer an ORC agent-definition search root. |

See Pi 1.2.0's [settings reference][settings]. Pi supplies its own default tools and compaction;
the former ORC `read/write/edit/bash/ls` implementations and lack of compaction no longer
describe the new execution path. Configure Pi tools/extensions there. ORC still runs the
provider in its own process group and keeps its existing interrupt/stop controls.

## Existing sessions

**Preserve first.** Stop active old Codex actors and workflow runners before replacing an old
binary, using its ordinary `kill`/workflow cancellation commands without purge/cleanup flags.
If already upgraded, `orc kill <id>` still stops a historical actor, and the supported harness
takeover path stops it before offering Pi continuation. Never run two writers on the same
transcript.

Records, journals, provider transcripts, run records, prompts and credentials are not converted
or deleted by installing this change. Existing harness sessions remain inspectable:

```sh
orc list --all
orc read <old-id> --full
orc read <old-id> --raw --json
orc takeover <old-id>
```

For a built-in-harness session with its matching Pi v3 `codex-session.jsonl`, `takeover` stops
its actor and provider group, then prints a native **`pi --session <file> --provider openai
--model <recorded-model>`** command. It restores the model from the active transcript branch,
falling back to the stored spawn model, and preserves the session cwd and explicit
system-prompt file/mode. Model changes on inactive branches do not override that choice.
The explicit provider prevents Pi from choosing a different provider when OpenAI credentials
are missing. Authenticate Pi first and run that printed command to continue the saved
conversation. The transcript retains thinking and message history; choose another OpenAI chat
model in Pi if the saved model is unavailable.

Takeover refuses a mismatched/unsupported transcript header, an unexpected model provider, or
a missing recorded model. It also refuses a missing system-prompt file: restore that original
file before retrying, so its path cannot silently become the prompt text. Preserve the original
artifacts and use a reviewed summary in a fresh Pi session when native continuation is not
possible. These checks do not rewrite the old transcript or infer the outcome of unfinished work.

The old ORC record remains historical. `orc send` and `orc resume` on it fail with migration
guidance; neither a provider field rewrite nor an automatic prompt replay is performed. Native
Pi continuation does not become a new managed ORC session. To continue under ORC management,
start a new `--provider pi` session and supply a reviewed summary or transcript as input. There
is no automatic session import command in this change.

An old actor may have sent a prompt or run a tool before it died. Reading its history cannot
always resolve that uncertainty. Check the external result before issuing a new instruction;
do not infer exactly-once execution from transcript persistence. Queued and uncertain messages
are never migrated into a newly created Pi session automatically.

The even older `codex app-server` rollout format is different. Its records remain historical;
rollouts remain under `~/.codex/sessions`, and there is no Pi importer here. Legacy tmux records
also remain read-only under the existing migration rules. Preserve those original artifacts
and provide a summary to a fresh Pi session when native continuation is unavailable.

## Existing workflows

Saved plans, digests, attempts and session links remain readable. A saved plan containing
`provider: "codex"` is not silently rewritten: changing the definition changes its digest and
execution meaning. Old Codex workflow execution cannot resume through the removed harness.

Inspect `orc workflow status` and `orc workflow logs` first. Cancel a still-running old run if
necessary, preserve its history and outputs, update the source definition to `pi`, and launch a
new run. Carry forward already verified outputs as explicit inputs or narrow the new workflow
to unfinished work. Do not edit persisted run JSON to bypass the plan-digest check or blindly
repeat steps with external effects. Pi/Claude-only runs retain normal resume/retry behaviour.

## Verification after migration

Use isolated state and a suitable low-cost chat model that your Pi account actually lists:

```sh
bun run check:compile
bun scripts/verify-runtime/all.ts --providers claude,pi \
  --claude-model haiku --pi-model openai/gpt-5.4-mini
```

`check:compile` uses scripted Pi and Claude executables to check the real compiled ORC actor
path; it is offline protocol/lifecycle validation. The live script exercises the actual CLIs
with a temporary `ORC_HOME`, including idempotent sends, actor crash/wake, takeover/resume and
cleanup. Missing binaries are SKIP; native status reports of missing credentials are
**SKIP: blocked**. Model/configuration errors and failures during provider execution remain visible. Pi's preflight
uses `pi auth check --model ... --json --no-refresh` without `--credentials`; Claude uses
`claude auth status --json`. Older/custom binaries lacking that interface reach the runtime gate.
Exit 0 with skipped rows, a mocked endpoint, a successful model listing or an installed binary
does not establish a passed authenticated live-provider check.

[openai]: https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/providers/openai.ts
[models]: https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/models.md
[settings]: https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/settings.md
