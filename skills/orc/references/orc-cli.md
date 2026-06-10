# orc — command & SDK reference

The orchestration playbook is in `SKILL.md`; this is the full surface to consult for exact flags.
Most commands accept `--json` (machine-readable; on error, exit non-zero + `{"error": "..."}`).
`--json` is parsed per subcommand, not globally — `help` is the exception (it never emits JSON).

## Sessions

| command | purpose |
| --- | --- |
| `orc spawn -p <claude\|codex\|pi> [opts]` | launch a session (aliases: `agent`, `new`). `--json` prints the record. |
| `orc send <id\|@alias> [PROMPT \| - \| @file]` | send a prompt / slash command (multi-line safe). |
| `orc read <id\|@alias> [--last\|--index N\|--full\|--raw]` | latest parsed conversation turn by default; `--full` = full parsed transcript; `--raw` = full tmux pane. |
| `orc state <id\|@alias>` | classify once → `starting\|running\|done\|waiting\|failed`. |
| `orc wait <id\|@alias> [--for done\|waiting\|failed\|settled] [--timeout SEC]` | block until settled (debounced). default `--for settled`. |
| `orc list [--workspace W \| --all \| --dead \| --all-hosts]` | list sessions (alias `ps`). |
| `orc attach <id\|@alias> [--read-only]` | print the `tmux attach` command (does not exec) — attach to watch live. |
| `orc kill <id\|@alias> [--worktree] [--purge]` | kill; keeps the record (still readable) unless `--purge`; `--worktree` removes the worktree. |
| `orc prune [--worktree]` | drop all dead records (and optionally their worktrees). |

### `spawn` options
- `--provider, -p` `claude|codex|pi` (required)
- `--model, -m <name>`
- `--agent <name>` — named agent definition (mutually exclusive with `--system-prompt`)
- `--alias <name>` — orchestrator-only active-session handle; use `@name` locally or `@workspace:name` from another workspace
- `--system-prompt <txt>` / `--system-prompt-mode append|replace`
- `--prompt <txt | ->` — initial prompt after boot (`-`/`@file`/stdin). Omit for none.
- `--cwd <dir>` — base working dir (default: cwd)
- `--workspace <w>` — logical workspace key (defaults to the git toplevel of cwd)
- `--worktree [--branch <b>]` — create a fresh git worktree and use it as cwd
- `--no-wait` — return immediately; skip the boot wait AND the initial-prompt send

All sessions run in **yolo mode** by default (`claude --dangerously-skip-permissions`,
`codex --dangerously-bypass-approvals-and-sandbox`, `pi -a`) and at a fixed wide pane geometry so
state detection is reliable.

## Named agents (specialized, reusable subagents)
`orc spawn --agent <name>` resolves a definition and injects its body as the system prompt:
- **claude**: native `--agent` — `./.claude/agents/<name>.md` then `~/.claude/agents/<name>.md`
- **codex**: `./.codex/agents/*.toml` by parsed `name` → `$CODEX_HOME/agents/*.toml` (default `~/.codex/agents`) → `./.codex/prompts/<name>.md` → `$CODEX_HOME/prompts/<name>.md` → the claude locations (injected via `AGENTS.md`)
- **pi**: the claude locations (injected via `--append-system-prompt`)

Edit these `.toml` or `.md` files to iterate on a role over time.

## Session aliases
Aliases are workspace-scoped handles for steering active sessions. They do not alter the agent
definition, model, system prompt, worktree label, or provider behavior. A duplicate alias is rejected
only while another session with that alias is active in the same workspace; killed/gone/pruned
sessions free the alias for reuse. Dead transcript records remain addressable by id.

## Workflows
| command | purpose |
| --- | --- |
| `orc workflow run <file.ts> [--detach] [--json]` | run a TS module default-exporting a `WorkflowDef`. `--detach` runs it in a reattachable `orc-wf-<id>` tmux session and returns immediately. |
| `orc workflow list [--json]` | list persisted runs (`~/.orc/runs/`). |
| `orc workflow status <runId> [--json]` | per-step state; a dead detached runner reconciles to `orphaned`. |
| `orc workflow logs <runId> [--step <id>] [--raw] [--json]` | each step's token-efficient transcript. |
| `orc workflow attach <runId> [--read-only]` | print the tmux attach command for a `--detach` runner. |

See `assets/workflow-template.ts` for the `WorkflowDef` shape. A `WorkflowDef` is a plain object
(`{ name, steps: [...] }`) default-exported; the runner validates it (no import required).

## Daemon & remote hosts (drive agents on other machines over tailscale)
| command | purpose |
| --- | --- |
| `orc daemon [--port 8787] [--bind <ip>] [--insecure]` | serve the HTTP API. Binds to the host's tailscale IP by default; refuses `0.0.0.0` without `--insecure`. |
| `orc remote add\|list\|rm <host>` | manage trusted peers (`~/.orc/peers.json`). |
| `orc --host <host> <command>` | run a session/workflow command (`list`/`spawn`/`send`/`read`/`wait`/`state`/`kill`/`attach`/`workflow`) against a remote daemon. Host-local-only actions error. |
| `orc list --all-hosts` | fleet view: aggregate local + every trusted peer. |

Trust is **fail-closed**: a request is allowed only if `tailscale whois` resolves the caller to an
allowlisted peer, or it presents `x-orc-secret == $ORC_DAEMON_SECRET`; otherwise `403`.

## SDK (TypeScript, for scripted orchestration)
```ts
import { agent, listSessions, getSession, runWorkflow, defineWorkflow } from 'orc';

const s = await agent({ provider: 'claude', worktree: true, prompt: 'reply READY' });
console.log(s.id, await s.state());          // 'starting'|'running'|'done'|'waiting'|'failed'
await s.send('next step');
await s.waitFor({ until: ['done'], timeoutMs: 120_000 });
console.log(await s.readParsed());           // token-efficient Turn[]
await s.kill({ removeWorktree: true });
```
Use the SDK when orchestration logic is non-trivial or will be reused (loops, fan-out, branching);
use the CLI for quick interactive steering.

## State & files
- Registry + run records under `~/.orc` (override with `ORC_HOME` — use a temp dir for throwaway experiments).
- A session's on-disk transcript is what `orc read` parses; it persists after `kill` (so post-mortem reads work).
- `orc read` defaults to the latest parsed conversation turn. Use `--full` for the full parsed transcript, `--index N` for a zero-based conversation turn, and `--raw` for the full live pane.
