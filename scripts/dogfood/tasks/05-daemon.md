# Task: orc daemon — HTTP API + tailscale federation (feature 3)

> Spawn this ONLY after F2b (`--detach`/`logs`) is merged — the daemon exposes the workflow surface.

## Context
Isolated git worktree of `orc`. First `bun install`, then read `README.md`, `docs/DESIGN-daemon.md`
(the design you implement), `src/index.ts` (the SDK you expose: `agent`, `listSessions`, `getSession`,
`pruneSessions`, `Session.*`, `runWorkflow`, `readRun`/`listRuns`), `src/session.ts`, `src/cli/index.ts`.
Commit on THIS branch; never `main`.

## Goal
A daemon so we can drive agents on OTHER orc hosts over the user's **tailscale** network. The daemon is
a thin HTTP/JSON layer over the existing SDK + a trust gate — NOT new orchestration logic.

### 1. Server — `agi daemon [--port 8787] [--bind <ip>]`
`Bun.serve` exposing JSON endpoints that map 1:1 to the SDK (operating on the same `~/.orc`):
```
GET  /health                              → { ok, version, host }   (no auth; liveness)
GET  /whoami                              → { host, peerAllowed }   (trust handshake echo)
GET  /sessions?workspace=&all=&dead=      → list (+ live state from F1)
POST /sessions {provider,model,agent,systemPrompt,prompt,worktree,cwd,workspace} → spawn
GET  /sessions/:id                        → record + state()
POST /sessions/:id/send   {prompt}        → send
POST /sessions/:id/wait   {for,timeoutMs} → waitFor (server-side long-poll; reuse F1)
GET  /sessions/:id/read?raw=              → parsed turns (or raw pane)
POST /sessions/:id/kill   {worktree,purge}
GET  /workflows/runs , GET /workflows/runs/:id            → list/read runs
POST /workflows/run {file?,def?,detach?}                  → run/detach a workflow
GET  /workflows/runs/:id/logs?step=                       → per-step parsed transcripts
```
- **Bind safety (critical):** default bind to the host's **tailscale IP** (discover via
  `tailscale ip -4`, subprocess), NEVER `0.0.0.0`. `--bind` may override for local testing
  (`127.0.0.1`). Refuse to start bound to a non-loopback, non-tailscale address unless `--insecure`.

### 2. Trust gate (all endpoints except `/health`)
Identity from tailscale: resolve the request's source IP via `tailscale whois <ip>` (subprocess) to a
tailnet node; allow only if the node/host is in the peer allowlist `~/.orc/peers.json`. On failure →
`403`. If `tailscale whois` is unavailable, fall back to a shared-secret header
(`x-orc-secret`, value from `ORC_DAEMON_SECRET`) and document that whois is preferred. Keep the gate a
PURE function `(identity, allowlist) → allow/deny` so it is unit-testable.

### 3. Client mode — `agi --host <host> <command>`
When `--host <h>` is present, the existing CLI commands (`list`, `spawn`, `send`, `read`, `wait`,
`state`, `kill`, `workflow *`) become HTTP calls to `http://<h>:<port>` instead of local SDK calls
(thin client; identical output/`--json`). `agi remote add|list|rm <host>` manages `~/.orc/peers.json`.
`agi list --all-hosts` fans out to every peer + local and aggregates with a `host` column.
- Remote `attach`/`read --raw` are host-local: `attach` should print the host + a
  `tailscale ssh <host>` hint instead of a bare local tmux command.

## Constraints
- Bun + TypeScript, ESM, match style. `Bun.serve` only — NO new HTTP deps. `bun run typecheck` clean,
  `bun test` green.
- Unit-test the PURE bits without a live socket: the trust decision `(identity, allowlist)→bool`, the
  request→SDK-arg mapping, and the route table. Integration (a live `Bun.serve` on `127.0.0.1`) may be
  a separate test that starts/stops the server in-process.

## Verification — REQUIRED, real (no mocks); gates done
Bind to `127.0.0.1` (loopback stands in for the tailscale IP locally). Throwaway `ORC_HOME`.
1. Start `agi daemon --bind 127.0.0.1 --port <p>` (background it). `GET /health` returns ok.
2. Drive a REAL agent THROUGH the API end to end: `agi --host 127.0.0.1:<p> spawn -p claude --prompt
   "use your Bash tool to run: echo REMOTE_OK then say done"`, then `agi --host … wait <id>`,
   `agi --host … read <id>` (assert it shows the Bash summary), `agi --host … kill <id>`. The
   remote-driven lifecycle must match a local one.
3. Run a workflow through the API (`agi --host … workflow run <abs>/orc.workflows/example.ts`) and read
   its run via `/workflows/runs/:id`.
4. Trust gate: a request with no/!allowlisted identity (and no secret) → `403`; with the secret → ok.
5. Clean up: stop the daemon, kill sessions, remove throwaway ORC_HOME, restore `~/.codex/config.toml`.
   You run inside tmux; prefix nested spawns with `TMUX= ` if needed.

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
