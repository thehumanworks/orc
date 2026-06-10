# Design: orc daemon — connect to orc servers on trusted tailscale hosts (goal-feature 3)

Status: DRAFT — depends on F1 (wait/state, done) and F2 (workflows, in progress). The HTTP surface is
just the existing SDK (`agent`, `listSessions`, `getSession`, `Session.*`, `runWorkflow`) exposed over
the network, so this is mostly a transport + trust layer, not new orchestration logic.

## Requirement (from the user's goal)
A daemon/server process so we can connect to OTHER `orc` servers running on trusted hosts in the
user's **tailscale** network — i.e. list/spawn/read/wait/kill agents and run workflows on remote
machines, not just locally. The point: drive a fleet of coding agents across several machines from one
place.

## Trust model — lean on tailscale, don't reinvent auth
tailscale already gives us a private, mutually-authenticated network (WireGuard) and a stable identity
per node. So:
- The daemon **binds to the tailscale interface only** (the node's `100.x` / tailnet IP), never
  `0.0.0.0`. A misconfig that exposed it publicly is the main risk to prevent — bind explicitly.
- Caller identity comes from tailscale: resolve the source IP with `tailscale whois` (subprocess) to a
  tailnet node/user, and check it against a **peer allowlist** (`~/.orc/peers.json`: tailnet hostnames
  the user has trusted via `orc remote add <host>`). No passwords/tokens to manage; identity is the
  tailnet membership + the explicit allowlist.
- Defense in depth: also accept a per-tailnet shared secret header as a fallback for environments
  where `tailscale whois` isn't available. Recommend whois-first.

## Architecture
- **Server**: `orc daemon [--port 8787]` runs `Bun.serve` bound to the tailscale IP, exposing a small
  JSON/HTTP API that is a 1:1 mapping of the SDK. It operates on the SAME `~/.orc` registry the local
  `orc` uses, so local and remote views are consistent.
- **Client**: `orc --host <tailnet-host> <command>` makes the existing CLI a thin client — when
  `--host` is set, each command becomes an HTTP call to that host's daemon instead of a local SDK
  call. `orc remote add|list|rm <host>` manages the trusted-peer list.
- **Federation**: `orc list --all-hosts` (and `orc ps`) fan out to every trusted peer's daemon +
  local, aggregating sessions with a `host` column. This is the "manage the fleet" view.

## API surface (all JSON; mirrors the SDK + CLI)
```
GET  /sessions?workspace=&all=&dead=     → list (each record gains a live `state` from F1)
POST /sessions   {provider,model,agent,alias,systemPrompt,prompt,worktree,cwd,workspace}  → spawn
GET  /sessions/:id                       → record + state()
GET  /sessions/:id/read?raw=&full=&last=&index=  → selected parsed turns (or raw pane) [reuses readParsed]
POST /sessions/:id/send   {prompt}       → send
POST /sessions/:id/wait   {for,timeoutMs}→ waitFor (long-poll)               [reuses F1]
POST /sessions/:id/kill   {worktree,purge}
GET  /workflows/runs , POST /workflows/run {file|def} , GET /workflows/runs/:id   [reuses F2]
GET  /health , GET /whoami               → daemon identity + version (trust handshake)
```

## Backgrounding ties to F2
A detached workflow (F2b) running on a host's daemon is exactly what a remote peer queries via
`/workflows/runs/:id`. The daemon is the natural home for detached runs: it outlives the CLI invocation
and owns the run records. So F2b's `--detach` and F3's daemon should share the run-record store under
`~/.orc/runs/`.

## Reads/waits over HTTP
`wait` can be long. Start with **server-side long-poll** (the handler runs `waitFor` and responds when
settled or at a timeout the client retries) — simplest, reuses F1 unchanged. SSE/websocket streaming of
live pane/turns can come later; not needed for v1.

## Verification (when built — real, two endpoints, no mocks)
Run a daemon bound to `127.0.0.1` (loopback stand-in for the tailscale IP in CI/local test), spawn a
real agent THROUGH the HTTP API, `wait` on it via the API, read its parsed transcript via the API, and
kill it — asserting the remote-driven lifecycle matches a local one. Then test the trust gate: a
request from a non-allowlisted identity is refused. (On the user's real tailnet, repeat host→host.)

## Open questions (resolve before building)
1. whois-based identity vs shared-secret vs both — recommend whois + allowlist, secret as fallback.
2. Does `orc --host` proxy EVERY command, or only read-ish ones initially? (Recommend all; spawn/kill
   are the point.)
3. Worktrees are host-local paths — remote `read --raw`/`attach` only make sense ON that host;
   `attach` should print the host + `tailscale ssh <host>` hint rather than a bare local tmux command.
4. One daemon per host on a fixed port, or discovery via tailscale MagicDNS names? (Recommend fixed
   port + MagicDNS hostnames in `peers.json`.)
