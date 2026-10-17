# orc / orc — Research Brief (verified)

> **Historical.** This is the research log for the original tmux-based runtime (pre-actor). Its
> tmux driver decision (§F.16c) is superseded by [`DESIGN-runtime.md`](DESIGN-runtime.md); orc no
> longer uses tmux, panes or TUI scraping. Tool versions below are those of the time. For the
> current system see [`ARCHITECTURE.md`](ARCHITECTURE.md).

Every claim below is backed by a command actually run on this machine
(Bun 1.3.14, node v25.9.0, claude 2.1.169, codex-cli 0.137.0, pi 0.79.0,
tmux 3.6a, git 2.50.1, macOS/darwin). Working dir: `/Users/tomasroda/projects/orc`.

> Convention: `<name>` = tmux session name, `<cwd>` = the worktree path, `<sid>` = a UUID we choose.

---

## A. The "yolo" launch command per provider (interactive TUI)

### A.1 codex `--yolo` IS a real (hidden) alias in 0.137.0

The orchestrator's pre-note said there is NO `--yolo`. That is **incorrect** — it is a
hidden alias (absent from `--help`, but accepted by the parser). Proof by differential test:

```
$ codex --yolo --xyzbogus
error: unexpected argument '--xyzbogus' found     # complains about xyzbogus, NOT --yolo
$ codex --bogusflag123
error: unexpected argument '--bogusflag123' found
$ codex --yolo                                    # alone:
Error: stdin is not a terminal                    # parsed OK, tried to launch TUI, no tty
$ codex --yolo --bogus
error: unexpected argument '--bogus' found         # --yolo still accepted
```

So `--yolo` parses fine; it only fails because there's no TTY (expected — we run it inside tmux which provides one).

**Decision:** prefer the *documented* `--dangerously-bypass-approvals-and-sandbox` (present at top level in `--help`) over the hidden `--yolo`. Hidden aliases are unstable across versions; the documented flag is the contract. `--yolo` is noted as a working shorthand but we don't depend on it.

Also note: the user's `~/.codex/config.toml` already sets `approval_policy="never"` and `sandbox_mode="danger-full-access"`, so even a bare `codex` is effectively yolo for this user — but we pass the explicit flag so behavior is independent of user config.

### A.2 claude yolo

`claude --dangerously-skip-permissions` launches interactive yolo. Confirmed by launching it
in a detached tmux pane: the input box rendered showing `⏵⏵ bypass permissions on`. (Flag present in `claude --help`.)

### A.3 pi trust flag

`pi -a` / `--approve` ("Trust project-local files for this run") is the trust flag. Confirmed present in `pi --help`. pi has no sandbox concept like codex; `-a` trusts project-local config/extensions/skills.

### A.4 Exact interactive-launch argv per provider

Interactive (TUI), chosen model, yolo, optional first prompt, fixed session id where supported:

```sh
# claude — supports fixed session id (--session-id <uuid>)
claude --dangerously-skip-permissions --model <model> [--append-system-prompt <p>] \
       --session-id <sid> [<initial prompt>]

# codex — NO session-id preset flag (see E); first prompt is positional [PROMPT]
codex --dangerously-bypass-approvals-and-sandbox -m <model> [<initial prompt>]

# pi — supports --session-id (embedded in transcript filename) and --session-dir
pi -a --model <model> [--append-system-prompt <p>] \
   --session-id <sid> --session-dir <dir> [<initial prompt>]
```

> CAUTION on the positional initial prompt: passing it as argv works, but for
> multi-line prompts the safer path is to launch WITHOUT a prompt and inject via
> tmux paste-buffer after boot (see D.13). Reserve the positional arg for trivial/single-line prompts.

---

## B. agentName resolution

### B.4 claude — agent resolution (confirmed)

Agents live at `~/.claude/agents/*.md` (user) and `.claude/agents/*.md` (project), with YAML
frontmatter (`name:`, `description:`, `model:`, optional `color:`). Confirmed:

```
$ ls ~/.claude/agents/
codebase-recon.md
$ head ~/.claude/agents/codebase-recon.md
---
name: codebase-recon
description: ...
model: opus
color: red
---
```

`--agent <name>` takes the **bare name** (frontmatter `name:` / filename without `.md`). Project
`.claude/agents/` overrides user `~/.claude/agents/` for the same name (standard claude precedence; project dir didn't exist here so only user scope was present). The `--agents <json>` flag also exists for inline ad-hoc agent definitions.

### B.5 codex — NO direct named-agent analog (DEFINITIVE)

codex 0.137.0 has **no claude-style reusable named-agent persona**. Investigated exhaustively:

- `--agent` flag: **does not exist** (`codex --help` / `codex exec --help` have no such flag; "agent" appears only in prose like "the agent should use").
- `--profile <name>` exists but layers `$CODEX_HOME/<name>.config.toml` on top of base config — it's a **config profile** (model, sandbox, approval), NOT a persona/system-prompt. No `*.config.toml` profiles currently exist in `~/.codex/`.
- `~/.codex/` has `rules/` (`default.rules`), `skills/`, `memories/`, `prompts?`, `plugins/` — skills are task instructions (SKILL.md), not personas. `rules/default.rules` is closest to a global persona but is not selectable by name per-invocation.
- The `agent_nickname` / `agent_role` / `agent_path` fields seen in session_meta payloads are codex's **internal multi-agent/subagent system** (`multi_agent_v2` feature), not a user-facing reusable agent you launch by name.
- Project-scope persona = **AGENTS.md** (codex auto-loads it as instructions for the cwd), plus `-c experimental_instructions_file=<path>` / `-c base_instructions=...` config overrides.

**Recommendation for `agentName` when `provider=codex` (v1):**
Treat a claude-style `agentName` as **unsupported for codex in v1, but degrade gracefully**:
1. If the orchestrator has the agent's markdown body (we resolve claude agent files ourselves), inject that body as codex instructions via `-c experimental_instructions_file=<orc-owned path>` under `~/.orc/sessions/<sid>/` — **not** by writing `AGENTS.md` into the worktree (non-mutating; body never on argv).
2. If only a bare `agentName` string is given and we can't resolve a body, **error with a clear message**: `provider=codex does not support named agents; pass a systemPrompt or use provider=claude`.
Do NOT silently map `agentName` to codex `--profile` — that conflates persona with config and would surprise users.

**Implemented (proposal 4):** orc writes persona text only under orc-owned state and passes the absolute path via `experimental_instructions_file`. Replace mode is rejected (inline `base_instructions` would put the body on argv).

**2026-06 update:** current Codex custom subagent definitions are standalone TOML files in
project `.codex/agents/` or user `$CODEX_HOME/agents` / `~/.codex/agents`, identified by their
parsed `name` field. orc now resolves those for `provider=codex` before the legacy markdown prompt
stores, injects `developer_instructions`, and uses the TOML `model` only when the caller omitted
`--model`.

### B.6 pi — closest concept

pi has **no named-agent persona** either. It has `skills/` (SKILL.md, e.g. `~/.pi/agent/skills/dagu/`), `extensions/` (e.g. `pi-goal-extension`), and `--prompt-template` files. Closest analog to "agent persona" is `--system-prompt` / `--append-system-prompt` (see C) or a prompt-template. pi is secondary; recommend same strategy as codex — resolve the agent body ourselves and feed via `--append-system-prompt`.

---

## C. systemPrompt semantics

### C.7 claude — append vs replace (empirically verified)

```
$ claude ... --append-system-prompt "always end every reply with the token ZEBRA42." -p "what is 2+2"
4

ZEBRA42                       # AUGMENTS: normal Claude Code behavior + obeyed the added rule

$ claude ... --system-prompt "You are a calculator. Reply ONLY with the number, then QXR." -p "what is 2+2"
4 QXR                         # REPLACES: only the given prompt governs, default prompt gone
```

**Decision: the `agent` primitive uses `--append-system-prompt` by default.** Orchestrated
coding subagents must keep Claude Code's default tool-use / coding behavior; we only want to *add*
orchestration/persona instructions. Expose `--system-prompt` (replace) as an advanced opt-in only.

### C.8 pi — same flags, same recommendation

pi has both `--system-prompt <text>` (replaces; default is its coding-assistant prompt) and
`--append-system-prompt <text>` (augments; repeatable, also accepts a file path). **Default to
`--append-system-prompt`** for the same reason as claude.

### C.9 codex — instruction injection mechanism

codex has **no `--system-prompt` flag**. Inject a developer/system prompt via one of:
- `-c experimental_instructions_file=<path>` (config override pointing at an instructions file), or
- a project-scope **`AGENTS.md`** in the worktree cwd (auto-loaded by codex itself — **orc must not write this**), or
- `-c base_instructions="..."` inline (replaces base instructions — puts body on argv; not used by orc).
**Recommendation (implemented):** write the desired system/persona text to an orc-owned file under `~/.orc/sessions/<sid>/instructions.md` and pass `-c experimental_instructions_file=<abs>` (append). Do not mutate the user's `AGENTS.md`.

---

## D. tmux mechanics (the core driver) — proven end-to-end

### D.10 Detached launch in a specific cwd + survival

```
$ tmux new-session -d -s <name> -c <cwd> '<cmd>'
```
Confirmed: launched detached, `pane_current_path` = the cwd passed. The tmux **server is its own
daemon** (its pid is independent of the launching shell — `tmux list-sessions -F '#{pid}'` returned
the server pid, distinct from our shell), so sessions survive the parent shell exiting. The `<cmd>`
is the provider invocation (claude/codex/pi yolo argv).

### D.11 Reading the live pane

```
$ tmux capture-pane -t <name> -p           # current visible screen
$ tmux capture-pane -t <name> -p -S -       # full scrollback (-S - = from start of history)
```
Both confirmed returning rendered pane text.

### D.12 Listing sessions / panes with useful fields

```
$ tmux list-sessions -F '#{session_name} created=#{session_created} attached=#{session_attached}'
orctest1 created=1781003597 attached=0

$ tmux list-panes -a -F '#{session_name} pane_pid=#{pane_pid} cwd=#{pane_current_path} cmd=#{pane_current_command}'
orctest1 pane_pid=73550 cwd=/private/tmp/orc-test-cwd cmd=bash
```
`pane_pid`, `pane_current_path` (cwd), `pane_current_command`, `session_attached` all available.
Recommended listing format for `orc`:
`#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{session_attached}`.

### D.13 MULTI-LINE PROMPT INJECTION — the #1 risk — SOLVED

Tested against **real claude, codex, AND pi interactive TUIs** in detached tmux panes, using a
two-phase capture (verify input box BEFORE Enter, then submit). All three behaved identically with
Approach 1 (lines land in the box pre-Enter, submit as one message after Enter).

**Approach 1 — bracketed paste (RECOMMENDED, works for both):**
```sh
prompt="$(printf 'Line one\nLine two\nLine three')"   # strip any trailing newline
tmux set-buffer -- "$prompt"        # NOTE: set-buffer is server-global, NO -t
tmux paste-buffer -p -t <name>      # -p = bracketed paste; target goes HERE
# (small settle, then)
tmux send-keys -t <name> Enter
```

Phase-1 capture (after paste, **before** Enter) for claude:
```
❯ Line one of prompt
  Line two of prompt
  Line three say only the word: ok      # all 3 lines sit in the box, NOT submitted
```
Phase-2 capture (after Enter): submitted as ONE message → claude replied `⏺ ok`.
Identical result for codex: all lines in `›` box pre-Enter, then `• ok` after Enter.
Identical for pi: all 3 lines in the box pre-Enter, then submitted as one message after Enter (the
turn reached the model call — it errored only on a missing bedrock API key for the `sonnet` alias,
which is an auth/provider-mapping issue, NOT an injection issue; the prompt was accepted intact).

> pi extra note: pi prints a startup warning `tmux extended-keys is off. Modified Enter keys may not
> work. Add 'set -g extended-keys on' to ~/.tmux.conf`. Plain `Enter` (submit) worked fine without it;
> the warning only concerns modified-Enter (e.g. Shift+Enter for newline). Optionally set
> `extended-keys on` (and `set -g focus-events on`, which claude also requests) on the orc-managed
> tmux server for best fidelity.

**Approach 2 — `send-keys -l` (negative control):** for BOTH claude and codex it also did NOT
premature-submit, because both TUIs submit on Enter=CR (`C-m`) and treat the LF (`\n` = `C-j`) from
`-l` literal text as a newline-insert. So `-l` happens to work *for these two tools today*. We still
**recommend Approach 1** because bracketed paste is an explicit atomic paste, immune to any TUI that
binds `C-j` to submit and immune to autocomplete/slash-menu popups triggering on typed chars.

> Pitfall to avoid: `tmux send-keys -t <name> -- "$multiline"` WITHOUT `-l` is dangerous — `send-keys`
> interprets a bare newline in the arg as the key `C-m` (Enter), which WOULD premature-submit. Always
> either use `paste-buffer -p`, or `send-keys -l` followed by a separate `Enter`.

**Boot delay — measure, don't guess.** Poll `capture-pane` until the input box renders rather than a
fixed sleep. Observed: both TUIs render their box within a few hundred ms to ~2s, but **both also show
a first-run trust dialog** (see D.13b) that must be dismissed first. Recommended ready-detection:
- claude: pane contains `bypass permissions on` (or the `❯` box) → ready.
- codex: pane contains the `›` input box / model line `gpt-5.5 ... · <cwd>` → ready.
Settle delay between paste and Enter: 100–300ms is ample (we used 300–400ms successfully); 0ms is risky if the bracketed-paste end-sequence is still processing. Recommend **200ms**.

### D.13b CRITICAL GOTCHA — first-run trust dialog

Even with the yolo flag, **claude and codex** show a **workspace-trust prompt** the first time they
run in an untrusted directory (verified by launching each in tmux):
- claude: `Is this a project you created or one you trust? ❯ 1. Yes, I trust this folder` → send `Enter` (default is option 1).
- codex: `Do you trust the contents of this directory? › 1. Yes, continue` → send `Enter`.
- **pi: NO trust dialog** when launched with `-a` (verified — `pi -a` went straight to the input box; no dialog in scrollback). pi is simpler here.

**Recommended handling: auto-confirm the dialog (stateless), do NOT mutate user config.** Poll the
pane → if trust-dialog text present, `send-keys -t <name> Enter` → poll again → once the input box is
ready, inject the prompt via paste-buffer. This is stateless and per-launch.

> Avoid the config-edit approach for codex (appending `[projects."<cwd>"] trust_level = "trusted"` to
> `~/.codex/config.toml`): every agent gets a unique worktree, so this would append a new entry on
> every launch and pollute the user's config unboundedly. Only document it as a *manual* opt-in if a
> user wants to pre-trust a long-lived path. Default = auto-confirm via `Enter`.

### D.14 Attach / reattach (human)

```
$ tmux attach -t <name>       # attach read-write
$ tmux attach -r -t <name>    # -r = read-only view
```
(`attach`/`attach-session` confirmed; `-r` is the documented read-only flag.)

---

## E. Session transcript paths (richer than pane capture)

| provider | transcript path | session-id preset at launch? | how to resolve the file |
|---|---|---|---|
| claude | `~/.claude/projects/<slug>/<session-id>.jsonl` | YES (`--session-id <uuid>`) | **glob `~/.claude/projects/*/<sid>.jsonl`** (don't reproduce the slug) |
| pi | `<session-dir>/<ISO>_<session-id>.jsonl` | YES (`--session-id`+`--session-dir`) | glob `<dir>/*_<id>.jsonl` |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` | **NO** | discover by cwd (+ mtime guard) |

### E.15a claude — resolve by globbing the session-id (don't reproduce the slug)

Because we set `--session-id <uuid>`, the **filename IS the uuid**, so the robust mapping is a glob on
the session-id across all project dirs — mirroring exactly what we do for pi:
```sh
ls ~/.claude/projects/*/<sid>.jsonl     # exactly one match (sid is globally unique)
```
This avoids reproducing claude's slug char-replacement rule, which is only partially characterized.

**Slug rule (informational only — not load-bearing).** Empirically the project dir slug is the
**resolved real cwd** with **both `/` AND `.` replaced by `-`** and a leading `-`:
```
cwd /tmp/orc.dot.test/sub  (real: /private/tmp/orc.dot.test/sub)
→ ~/.claude/projects/-private-tmp-orc-dot-test-sub/<session-id>.jsonl   # exists
```
`/tmp`→`/private/tmp` (realpath) and hidden dirs produce a double-dash
(`-Users-tomasroda--agents-...`, consistent with `.`→`-`). Other punctuation (underscores, etc.) above
the worktree was NOT exhaustively tested — another reason to prefer the glob over recomputing the slug.
Format: JSONL, one event per line (`{"type":"ai-title"...}`, `{"type":"user"...}`, assistant turns, etc.).

### E.15b codex — discover by cwd (no id preset)

codex cannot be given a session-id at launch (only `resume`/`fork` take one). Each rollout file's
**first line** is a `session_meta` event carrying both `id` and `cwd`:
```
$ head -1 rollout-*.jsonl
{"type":"session_meta","payload":{"id":"019e93df-...","cwd":"/Users/tomasroda/projects/SwiftAcp",...}}
```
**Mapping strategy:** record the launch timestamp `T0`. After launch, find the newest
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose `session_meta.payload.cwd` == the worktree
realpath **AND** whose mtime (or `session_meta.timestamp`) > `T0`. The unique worktree gives a unique
cwd; the `> T0` guard prevents matching a *prior* session's rollout if a worktree path is ever reused
or resumed. (Also: `~/.codex/session_index.jsonl` maps `id → thread_name`, useful for display.) Format: JSONL.
Caveat: `codex exec --ephemeral` does NOT persist a session file — never use `--ephemeral` if we want transcript reads.

### E.15c pi — predictable via session-dir + session-id (verified)

```
$ pi -a --session-id 019eaaaa-...-aaaaaaaaaaaa --session-dir /tmp/orc-pi-sessions -p "say hi"
→ /tmp/orc-pi-sessions/2026-06-09T11-25-06-601Z_019eaaaa-...-aaaaaaaaaaaa.jsonl
```
The passed `--session-id` is embedded verbatim as the filename suffix, and `--session-dir` is used
flat (no slug subdir when given explicitly). So pass both → resolve via glob
`<session-dir>/*_<session-id>.jsonl`. Format: JSONL; first line `{"type":"session","version":3,"id":...,"cwd":...}`.

---

## F. Bun-native detached PTY finding

### F.16a Bun 1.3.14 DOES expose a native PTY primitive: `Bun.Terminal`

The user's instinct was right — this is real, not hypothetical:
```
$ bun --eval 'console.log(Object.keys(Bun).filter(k=>/term|pty|tty/i.test(k)))'
[ "Terminal" ]            # Bun.Terminal exists (capital T). Bun.openpty/Bun.terminal(lowercase) do NOT.
```
`Bun.Terminal` is a genuine PTY master. Verified functionally:
```ts
let out = "";
const term = new Bun.Terminal({ cols:80, rows:24, data(_t,d){ out += new TextDecoder().decode(d); } });
const proc = Bun.spawn(["bash"], { terminal: term });   // Bun.spawn accepts { terminal }
term.write("echo HELLO_FROM_PTY; tty; exit\n");
await proc.exited;
// out captured: "echo HELLO_FROM_PTY\r\n...[?25l[>c..." (real PTY: CRLF + ANSI escapes)
```
API (from bundled `bun-types/bun.d.ts`, Bun 1.3.x):
- `new Bun.Terminal({ cols, rows, name, data(term,bytes), exit(term,code,sig), drain(term) })`
- methods: `write(data)`, `resize(cols,rows)`, `setRawMode(bool)`, `close()`, `ref/unref`, termios flag getters/setters (`inputFlags`/`outputFlags`/`localFlags`/`controlFlags`).
- `Bun.spawn(cmd, { terminal })` attaches a child to the PTY; `proc.terminal` returns the Terminal.
- Output is delivered to the **in-process `data` callback** — there is no `readable` stream property; the master fd is owned by the Bun process.
- `node-pty` is also installed globally and loads under Bun (fallback option).
- `node:tty` works under Bun (`ReadStream`, `WriteStream`, `isatty`).

### F.16b Why a detached `Bun.spawn`/`Bun.Terminal` alone CANNOT be "reattachable by the user"

The PTY **master fd and the `data` callback live inside the parent Bun process**. There is no
property exposing the master to another process. So:
- When the parent Bun process exits, the master closes → the child gets SIGHUP/EOF → the session dies.
  A child spawned `detached` survives the parent only if it's reparented AND still has a live
  controlling terminal — but the terminal here is the in-process master, which is gone. So a bare
  detached `Bun.Terminal` process gives you **neither persistence nor reattach**.
- "Reattach by the user in their own terminal" fundamentally requires: (1) a **persistent broker
  daemon** that holds the PTY master open across the launcher's lifetime, and (2) a **client protocol**
  so a human terminal can connect, stream the scrollback, and forward keystrokes back to the master.
  That is exactly what tmux/dtach/abduco implement. Building it on `Bun.Terminal` means
  **reimplementing tmux** (daemon + scrollback buffer + multiplexing + attach protocol).

### F.16c Verdict

**tmux is the correct v1 driver.** It gives detached persistence, human reattach
(`tmux attach`), read-only view (`attach -r`), live pane capture, and scrollback — for free, today,
proven above end-to-end with real claude/codex sessions.

**A future `bun-pty` driver is feasible but is a project, not a flag.** It would need: a long-lived
broker daemon process per session holding `Bun.Terminal` open; a scrollback ring buffer; a unix-socket
attach protocol (stream output to clients, forward client stdin to `term.write`); resize propagation
(`term.resize` on client SIGWINCH); and lifecycle/orphan management. `Bun.Terminal` makes the PTY layer
trivial, but the daemon + attach protocol is the real work. Recommend: ship tmux driver in v1 behind a
`Driver` interface so a `bun-pty` driver can slot in later **without** changing the `agent` primitive.
The decision to prefer Bun is honored — the primitive is real — but it is deferred for the right reason
(reattach requires a broker), not dropped.

---

## G. git worktree association

```
$ git worktree add <path> -b <branch>      # new branch at HEAD
$ git worktree add <path> <existing>        # check out existing branch
$ git worktree list                          # enumerate
$ git worktree remove <path> [--force]       # cleanup
```
Verified, with edge cases (both fatal — handle before calling):
```
$ git worktree add /tmp/.../wt1 -b feature-2   # path already used
fatal: '/tmp/.../wt1' already exists
$ git worktree add /tmp/.../wt3 -b feature-1   # branch already exists
fatal: a branch named 'feature-1' already exists
```
**Implementation notes:** the worktree path must NOT pre-exist; the new branch name must be unique
(or use `git worktree add <path> <existing-branch>` / add `-B` to force-reset). Use a generated,
collision-resistant branch+path per agent (e.g. `orc/<agent>/<short-sid>` and
`<repo>/.orc/worktrees/<short-sid>`). The worktree path (its **realpath**) is the `<cwd>` passed to
`tmux new-session -c <cwd>` and used to compute claude's slug / match codex's session cwd.

---

## RECOMMENDATIONS FOR IMPLEMENTATION (decided)

### Yolo interactive launch argv (per provider)
```sh
# claude
claude --dangerously-skip-permissions --model <model> \
       --append-system-prompt <resolvedSystemPrompt> --session-id <sid>
# (launch WITHOUT positional prompt; inject via paste-buffer after boot)

# codex  (auto-confirm the trust dialog with Enter after boot; do NOT edit user config)
codex --dangerously-bypass-approvals-and-sandbox -m <model>
# (system prompt → orc-owned instructions file + -c experimental_instructions_file=<abs>)

# pi
pi -a --model <model> --append-system-prompt <resolvedSystemPrompt> \
   --session-id <sid> --session-dir <orcSessionDir>
```

### Boot + multi-line send sequence (the decided recipe)
1. `tmux new-session -d -s <name> -c <realpath cwd> '<provider argv>'`
2. Poll `tmux capture-pane -t <name> -p` every ~250ms:
   - if trust-dialog text present → `tmux send-keys -t <name> Enter`, keep polling;
   - until input box ready (claude: `bypass permissions on`; codex: `›`+model line; pi: input box).
3. Inject prompt:
   ```sh
   tmux set-buffer -- "$prompt"            # trailing newline stripped; NO -t on set-buffer
   tmux paste-buffer -p -t <name>          # bracketed paste
   sleep 0.2                                # ~200ms settle
   tmux send-keys -t <name> Enter
   ```
   (Use `paste-buffer -p`, NOT `send-keys` without `-l`. `send-keys -l`+Enter also works for claude/codex today but is less robust.)

### agentName resolution behavior (per provider)
- **claude:** native. `--agent <bareName>`; resolution project `.claude/agents/` → user `~/.claude/agents/` (`name:` frontmatter / filename). We may also resolve the agent .md ourselves to reuse cross-provider.
- **codex:** resolve project/user `.codex/agents/*.toml` by parsed `name` first, then legacy `.codex/prompts/<name>.md`, then claude agent markdown; inject TOML `developer_instructions` or the markdown body via orc-owned `experimental_instructions_file` (not `AGENTS.md`). TOML `model` is used only when the caller omitted `--model`. Never map `agentName` to `--profile`.
- **pi:** no native named agent. Same as codex — feed resolved body via `--append-system-prompt`.

### systemPrompt default
**Append**, not replace. claude `--append-system-prompt`; pi `--append-system-prompt`; codex via
orc-owned `experimental_instructions_file` (augmenting; never mutate user `AGENTS.md`). Expose replace as advanced opt-in for claude/pi (`--system-prompt`); codex replace is rejected (no safe file-backed base_instructions without argv stuffing).

### Transcript path mapping (per provider)
- **claude:** we set `--session-id <sid>`, so **glob `~/.claude/projects/*/<sid>.jsonl`** (one unique match). Do NOT recompute the slug — it's only partially characterized; the glob is robust.
- **pi:** glob `<sessionDir>/*_<sid>.jsonl` (set `--session-dir` + `--session-id`).
- **codex:** no id preset → record launch time `T0`; find newest `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose first-line `session_meta.payload.cwd` == realpath(worktree) AND mtime > `T0`. Unique worktree ⇒ unique match; `T0` guard avoids matching a prior session on a reused path. Never use `--ephemeral`. All three formats are JSONL.

### tmux session naming + listing
- Name: `orc-<agentName>-<shortSid>` (sanitize to `[A-Za-z0-9_-]`; tmux names can't contain `.` or `:`).
- List: `tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{session_attached}'` and filter `session_name` prefix `orc-`.
- Reattach for humans: `tmux attach -t <name>` (read-only: `tmux attach -r -t <name>`).
- Read live state: `tmux capture-pane -t <name> -p` (screen) / `-S -` (full scrollback) — but prefer the on-disk JSONL transcript for parseable history; pane capture is for the live/in-progress view.

### Bun-vs-tmux verdict
**tmux for v1** (proven: detached, survives parent, reattachable, read-only view, capture+scrollback).
`Bun.Terminal` is real in 1.3.14 and is the right foundation for a *future* `bun-pty` driver, but
reattach-by-user requires a persistent broker daemon + attach protocol (i.e. reimplementing tmux), so
it's deferred. Build behind a `Driver` interface so `bun-pty` can be added later without touching the
`agent` primitive.

### Key gotchas to not forget
1. First-run **trust dialog** for claude AND codex even under yolo — **auto-confirm with `Enter`** (stateless; don't mutate user config). pi (`-a`) has no trust dialog.
2. Resolve claude/pi transcripts by **globbing the session-id** (`*/<sid>.jsonl`, `*_<sid>.jsonl`); do NOT recompute claude's slug (only partly characterized — replaces `.` as well as `/`, uses realpath).
3. codex has **no `--session-id`** at launch; map transcripts by **cwd + mtime>launch**.
4. `codex --yolo` is a hidden alias that works, but use the documented `--dangerously-bypass-approvals-and-sandbox`.
5. `tmux set-buffer` is **server-global** (no `-t`); the `-t <name>` goes on `paste-buffer`.
6. Strip trailing newline before `set-buffer` to avoid an accidental extra submit.
