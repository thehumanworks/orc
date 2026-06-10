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

### 1. Server — `orc daemon [--port 8787] [--bind <ip>]`
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

### 2. Trust gate (all endpoints except `/health`) — MUST FAIL CLOSED
Identity from tailscale: resolve the request's source IP via `tailscale whois <ip>` (subprocess) to a
tailnet node; the node/host must be in the peer allowlist `~/.orc/peers.json`. A shared-secret header
(`x-orc-secret` matching `ORC_DAEMON_SECRET`) is an explicit fallback for when whois is unavailable;
whois is preferred.

**FAIL CLOSED — non-negotiable.** A request is allowed ONLY IF
`(whois resolves the source IP to an ALLOWLISTED node)` OR `(a valid x-orc-secret is presented)`.
In EVERY other case respond `403` — including, explicitly, when `tailscale whois` is unavailable AND
no secret is configured (do NOT degrade to "allow" because no auth mechanism is available). Unknown or
unresolvable identity is DENY, never allow. Keep the decision a PURE function
`(identity|null, allowlist, presentedSecret|null, configuredSecret|null) → boolean` and unit-test the
deny cases EXHAUSTIVELY: whois-unavailable + no secret → deny; whois resolves a non-allowlisted node →
deny; no identity + wrong/absent secret → deny; allowlisted node → allow; valid secret → allow.

### 3. Client mode — `orc --host <host> <command>`
When `--host <h>` is present, the existing CLI commands (`list`, `spawn`, `send`, `read`, `wait`,
`state`, `kill`, `workflow *`) become HTTP calls to `http://<h>:<port>` instead of local SDK calls
(thin client; identical output/`--json`). `orc remote add|list|rm <host>` manages `~/.orc/peers.json`.
`orc list --all-hosts` fans out to every peer + local and aggregates with a `host` column.
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
0. **Bind refusal (the layer-1 safety boundary — locally verifiable, do NOT skip):** assert
   `orc daemon --bind 0.0.0.0 --port <p>` REFUSES to start (non-zero exit, clear error) WITHOUT
   `--insecure`, and that `--bind 127.0.0.1` (loopback) is allowed. Binding to the tailscale IP is the
   real security primitive (WireGuard won't route `100.x` from off-tailnet); a stray public bind must
   be impossible by default.
1. Start `orc daemon --bind 127.0.0.1 --port <p>` (background it). `GET /health` returns ok.
2. Drive a REAL agent THROUGH the API end to end: `orc --host 127.0.0.1:<p> spawn -p claude --prompt
   "use your Bash tool to run: echo REMOTE_OK then say done"`, then `orc --host … wait <id>`,
   `orc --host … read <id>` (assert it shows the Bash summary), `orc --host … kill <id>`. The
   remote-driven lifecycle must match a local one.
3. Run a workflow through the API (`orc --host … workflow run <abs>/orc.workflows/example.ts`) and read
   its run via `/workflows/runs/:id`.
4. Trust gate (fail-closed): a request with no allowlisted identity AND no secret → `403`; with a
   WRONG secret → `403`; with the correct `x-orc-secret` → ok. (On loopback, `tailscale whois` cannot
   resolve `127.0.0.1`, so this exercises the SECRET path + the deny path.)
5. Clean up: stop the daemon, kill sessions, remove throwaway ORC_HOME, restore `~/.codex/config.toml`.
   You run inside tmux; prefix nested spawns with `TMUX= ` if needed.

### Verification ceiling — REPORT HONESTLY (do not rubber-stamp)
Loopback testing covers the plumbing, the secret-path auth, the deny/403 path, and bind-refusal — but
the PRIMARY, recommended trust mechanism (`tailscale whois` + allowlist) gets ZERO live coverage by
construction (whois can't resolve loopback). Your final report AND the commit message must say so
plainly: "plumbing + secret-path + bind-refusal verified on loopback; the whois+allowlist trust path is
NOT exercised and needs a real two-host tailnet test before being relied on." A green loopback run is
NOT "F3 fully works." (This is acceptable to merge ONLY because the gate fails closed by design.)

## When done
1. `bun run typecheck` and `bun test` green.
2. `git add -A && git commit` on this branch with a clear message.
3. Print on its own line exactly `DOGFOOD_COMPLETE`. If blocked, print `DOGFOOD_BLOCKED: <reason>`.
