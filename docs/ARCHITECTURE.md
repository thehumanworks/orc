# orc / orc — Architecture (v1)

`orc` is a multi-agent orchestration tool. Its core primitive is `agent()`: it launches a
coding-agent CLI (`claude`, `codex`, or `pi`) as an **interactive TUI** inside a **detached,
reattachable, readable** session, optionally in a fresh git worktree, in yolo mode by default.
Subagent sessions outlive the parent and can be reattached/inspected by the human — work is never
opaque. Ships as a TypeScript SDK (Bun) and a CLI `orc`. Both are consumed mostly by AI agents, so
every surface is scriptable and `--json`-capable.

See `docs/RESEARCH.md` for the verified primitives behind every decision here.

## Stack
- Runtime: **Bun 1.3.14** (TypeScript, ESM, `"type": "module"`).
- Driver: **tmux 3.6a** (v1). Behind a `Driver` interface; a future `bun-pty` driver (via
  `Bun.Terminal`) can slot in without touching `agent()`. tmux gives detach + reattach + read-only
  view + scrollback for free.
- No heavyweight deps. Use Bun built-ins (`Bun.spawn`, `Bun.file`, `Bun.$`) and node:fs/os/path.
  CLI arg parsing: `util.parseArgs` (node built-in) — no commander/yargs.

## Layout
```
orc/
  package.json            # type:module, bin: { orc: "./src/cli/index.ts" }, engines bun
  tsconfig.json
  README.md
  docs/{RESEARCH.md,ARCHITECTURE.md}
  src/
    index.ts              # SDK public entry — re-exports agent(), Session, list/get/kill, types
    types.ts              # Provider, AgentOptions, SessionRecord, PaneInfo, ...
    paths.ts              # ~/.orc home, sessions dir, registry path
    agent.ts              # the agent() primitive (orchestrates provider+driver+worktree+registry+boot)
    session.ts            # Session handle class (send/capture/transcript/attachCommand/kill/status)
    registry.ts           # persist + reconcile session records; workspace association
    worktree.ts           # git worktree create/remove + collision-safe naming
    agentdefs.ts          # resolve claude/codex agent .md (project .claude/agents → user ~/.claude/agents)
    drivers/
      driver.ts           # Driver interface + factory
      tmux.ts             # TmuxDriver
    providers/
      provider.ts         # ProviderAdapter interface + registry/factory
      claude.ts
      codex.ts
      pi.ts
    cli/
      index.ts            # `orc` dispatcher (parseArgs), --json everywhere, stdin support for prompts
      output.ts           # human + json renderers
  test/                   # bun:test — unit tests for pure logic (naming, slug/glob, argv build, parsing)
```

## Public SDK API (`src/index.ts`)
```ts
export type Provider = 'claude' | 'codex' | 'pi';

export interface AgentOptions {
  provider: Provider;
  model?: string;
  /** Name of an existing agent definition (claude/codex, project- or user-scoped). */
  agentName?: string;
  /** System prompt text. INVALID to pass together with agentName (validation error). */
  systemPrompt?: string;
  /** 'append' (default) augments the CLI's built-in prompt; 'replace' overrides it. */
  systemPromptMode?: 'append' | 'replace';
  /** Initial prompt sent after the session boots (multi-line safe). */
  prompt?: string;
  /** Base working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Logical workspace key; defaults to git toplevel of cwd, else cwd. */
  workspace?: string;
  /** Create a fresh git worktree for this agent and use it as cwd. */
  worktree?: boolean | { branch?: string; path?: string };
  /** Driver name; default 'tmux'. */
  driver?: string;
  /** Wait for boot before resolving (default true). */
  waitForReady?: boolean;
}

export async function agent(opts: AgentOptions): Promise<Session>;
export async function listSessions(filter?: { workspace?: string; all?: boolean }): Promise<Session[]>;
export async function getSession(idOrName: string): Promise<Session | null>;
```

### `Session` (`src/session.ts`)
```ts
class Session {
  readonly id: string;          // short id (first 8 of sessionId), used as the CLI handle
  readonly sessionId: string;   // uuid (claude/pi --session-id; codex: discovered)
  readonly provider: Provider;
  readonly tmuxName: string;     // orc-<agentLabel>-<shortId>
  readonly cwd: string;          // realpath of the launch cwd (== worktree path if worktree)
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly workspace: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly createdAt: string;

  status(): Promise<'running' | 'dead'>;             // reconciled against tmux liveness
  send(prompt: string): Promise<void>;               // boot-ready guard → paste-buffer -p → 200ms → Enter
  capture(opts?: { scrollback?: boolean }): Promise<string>;  // tmux capture-pane
  transcript(): Promise<string | null>;              // path to on-disk JSONL (provider-resolved)
  readTranscript(): Promise<string | null>;          // raw JSONL contents
  readParsed(): Promise<Turn[]>;                      // token-efficient parsed turns (default `orc read`)
  attachCommand(opts?: { readOnly?: boolean }): string;       // `tmux attach [-r] -t <name>`
  kill(opts?: { removeWorktree?: boolean }): Promise<void>;   // kill tmux session (+ optional worktree)
  toJSON(): SessionRecord;
}
```

## Validation rules (in `agent()`)
1. `provider` required, ∈ {claude,codex,pi}.
2. `agentName` and `systemPrompt` are **mutually exclusive** → throw on both (matches spec).
3. `agentName` for `provider=codex|pi`: resolve the agent's markdown body ourselves (see agentdefs);
   if it resolves, feed it as the system prompt for that provider (codex→AGENTS.md;
   pi→--append-system-prompt). If it can't be resolved to a body → throw a clear error:
   `provider=<p> has no native named agents; pass systemPrompt or use provider=claude`.
4. `worktree` requires cwd to be inside a git repo.

## Boot + multi-line send (decided recipe — from research D.13/D.13b)
`agent()` after `driver.spawn`:
1. Poll `capture` every ~250ms (timeout ~30s):
   - if provider.trustDialogMatch(pane) → `driver.sendKeys(name, 'Enter')` (auto-confirm; never edit user config);
   - until provider.readyMatch(pane) (input box rendered).
2. If `opts.prompt`, call `session.send(prompt)`.

`session.send(text)`:
1. ensure ready (poll readyMatch; cheap re-check).
2. strip trailing newline from text.
3. `driver.paste(name, text)` → `tmux set-buffer -- <text>` (server-global, NO -t) then `tmux paste-buffer -p -t <name>`.
4. wait 200ms.
5. `driver.sendKeys(name, 'Enter')`.
(Never `send-keys` a multi-line string without `-l`; bare newline = C-m = premature submit.)

## Provider adapters (`src/providers/*`)
`ProviderAdapter`:
```ts
interface BuildCtx { model?: string; sessionId: string; systemPrompt?: string;
                     systemPromptMode: 'append'|'replace'; agentName?: string;
                     cwd: string; sessionDir: string; }
interface ProviderAdapter {
  name: Provider;
  /** Prepare cwd (e.g. codex writes AGENTS.md). Runs before spawn. */
  prepare(ctx: BuildCtx): Promise<void>;
  /** yolo interactive argv (NO positional prompt — prompt injected post-boot). */
  buildArgv(ctx: BuildCtx): string[];
  readyMatch(pane: string): boolean;
  trustDialogMatch(pane: string): boolean;
  /** Resolve the on-disk transcript path for a launched session. */
  resolveTranscript(rec: SessionRecord): Promise<string | null>;
}
```
Decided argv (research A.4 / RECOMMENDATIONS):
- **claude:** `claude --dangerously-skip-permissions [--model M] [--agent NAME | --append-system-prompt P | --system-prompt P] --session-id SID`
  - agentName → `--agent <bareName>` (native). systemPrompt → append (default) or `--system-prompt` (replace).
  - readyMatch: pane includes `bypass permissions on` or the `❯` box. trustDialog: includes `trust this folder` / `Is this a project you created`.
  - transcript: glob `~/.claude/projects/*/<sid>.jsonl` (do NOT recompute slug).
- **codex:** `codex --dangerously-bypass-approvals-and-sandbox [-m M]`
  - systemPrompt/agentName-body → write `AGENTS.md` into cwd in `prepare()`. No --session-id.
  - readyMatch: pane includes the model line / `›` input box. trustDialog: includes `trust the contents of this directory`.
  - transcript: newest `~/.codex/sessions/Y/M/D/rollout-*.jsonl` whose first-line session_meta.payload.cwd == realpath(cwd) AND mtime > createdAt. Never `--ephemeral`.
- **pi:** `pi -a [--model M] [--append-system-prompt P | --system-prompt P] --session-id SID --session-dir <orc sessions dir>`
  - no trust dialog. readyMatch: input box. transcript: glob `<sessionDir>/*_<sid>.jsonl`.

## Drivers (`src/drivers/*`)
`Driver`:
```ts
interface PaneInfo { name: string; pid: number; cwd: string; command: string; attached: boolean; }
interface Driver {
  readonly name: string;
  spawn(a: { name: string; cwd: string; argv: string[]; env?: Record<string,string> }): Promise<void>;
  capture(name: string, o?: { scrollback?: boolean }): Promise<string>;
  sendKeys(name: string, keys: string): Promise<void>;   // e.g. 'Enter'
  paste(name: string, text: string): Promise<void>;       // set-buffer + paste-buffer -p
  list(prefix?: string): Promise<PaneInfo[]>;
  isAlive(name: string): Promise<boolean>;
  kill(name: string): Promise<void>;
  attachCommand(name: string, o?: { readOnly?: boolean }): string;
}
```
TmuxDriver implementation notes:
- spawn: `tmux new-session -d -s <name> -c <cwd>` then run argv. Pass argv safely (avoid shell-quoting
  bugs): build the command via `tmux new-session -d -s name -c cwd -- <prog> <args...>` if supported,
  else a carefully quoted single string. Set `set -g extended-keys on` / `focus-events on` on the
  orc tmux server (optional fidelity; pi/claude request it).
- list: `tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{session_attached}'`, filter `session_name` startsWith `orc-`.
- All tmux calls via `Bun.spawn`/`Bun.$` with array argv (no shell interpolation of untrusted text).

## Registry + workspace (`src/registry.ts`, `src/paths.ts`)
- Home: `~/.orc/` (override `ORC_HOME`). Sessions dir: `~/.orc/sessions/` (per-provider on-disk pi
  transcripts go under `~/.orc/transcripts/pi/<sid>/`). Registry: `~/.orc/registry.json`
  (array of SessionRecord) — write atomically (tmp + rename).
- `SessionRecord`: { id, sessionId, provider, model?, agentName?, tmuxName, cwd, worktreePath?, branch?,
  workspace, systemPromptMode?, createdAt }.
- **Workspace** = `opts.workspace` ?? git toplevel of cwd ?? realpath(cwd). Stored on the record.
- `listSessions({workspace, all})`: read registry, reconcile each against `driver.isAlive` /
  `driver.list`; default filter = workspace of process.cwd(); `all` returns every workspace.
  Prune dead records lazily (mark dead, keep for transcript reads; optionally `orc prune`).

## CLI `orc` (`src/cli/index.ts`)
Commands (all accept `--json`; prompts accept `-` / stdin / `@file`):
```
orc spawn  --provider <p> [--model M] [--agent NAME | --system-prompt P] [--prompt TXT|-]
           [--cwd DIR] [--workspace W] [--worktree [--branch B]] [--no-wait] [--json]
           # prints the SessionRecord (human or json). Alias: `orc agent`, `orc new`.
orc send   <id|name> [PROMPT | - | @file] [--json]      # multi-line safe; piped stdin or '-' if PROMPT omitted
orc read   <id|name> [--raw] [--json]                   # parsed transcript (default) or full pane (--raw)
orc list   [--workspace W | --all | --dead] [--json]    # active sessions for a workspace. Alias: `orc ps`.
orc attach <id|name> [--read-only] [--json]             # prints `tmux attach ...` (does not exec by default)
orc kill   <id|name> [--worktree] [--purge] [--json]    # mark session dead (keep record); --purge removes record
orc prune  [--worktree] [--json]                        # drop all dead records (+ optional worktree removal)
orc help
```
Notes for AI consumers: non-zero exit on error with a JSON `{error}` when `--json`; `orc list --json`
returns an array of records with a live `status` field; `orc spawn --json` returns the record so a
caller can immediately `orc send <id>`.

## Verification gate (what "done" means — no mocks substitute)
A real yolo session launched in tmux for BOTH claude and codex; a **multi-line** prompt delivered and
acted on (pane shows it submitted as one message); session listed/filtered by workspace; attach command
valid; worktree created and used as cwd; transcript resolves to a real on-disk JSONL. Unit tests cover
pure logic only (naming, argv build, parsing, glob/match) — they do NOT replace the live runs.
