/**
 * The orc daemon — a thin HTTP/JSON layer over the existing SDK plus the trust gate. It
 * adds NO orchestration logic: every route maps 1:1 to a `Session`/`agent`/`runWorkflow`
 * call against the SAME `~/.orc` the local `orc` uses.
 *
 * SECURITY: every route EXCEPT `/health` is behind the fail-closed trust gate
 * (`decideTrust`). The bind address is decided by `resolveBind` (never `0.0.0.0` by
 * default). The handler is factored out of `Bun.serve` (`createFetch`) so it can be
 * exercised over a live loopback socket in tests with an injectable whois.
 */
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { agent } from '../agent.ts';
import { listSessions, getSession } from '../index.ts';
import {
  runWorkflow,
  runnerTmuxName,
  reconcileRun,
  assembleStepLogs,
  validateWorkflowDef,
} from '../workflow.ts';
import type { WorkflowDef, WorkflowRun, StepResult } from '../workflow.ts';
import { readRun, listRuns, writeRun } from '../runs.ts';
import { getDriver } from '../drivers/driver.ts';
import { orcHome } from '../paths.ts';
import { selectTurns } from '../transcript.ts';
import type { TurnSelection } from '../transcript.ts';
import { decideTrust, isAllowlisted } from './trust.ts';
import type { Identity } from './trust.ts';
import { whoisIdentity } from './tailscale.ts';
import { peerHosts } from './peers.ts';
import { matchRoute, mapSpawnRequest, mapWaitRequest } from './routes.ts';
import type { RouteName } from './routes.ts';

/** orc version, for `/health`. Read from package.json (best-effort; informational). */
async function readVersion(): Promise<string> {
  try {
    const pkgPath = path.resolve(import.meta.dir, '../../package.json');
    const pkg = (await Bun.file(pkgPath).json()) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface DaemonOptions {
  /** Resolved bind address (from `resolveBind`). */
  hostname: string;
  port: number;
  /** Configured shared secret (`ORC_DAEMON_SECRET`); null = no secret configured. */
  secret?: string | null;
  /**
   * Static allowlist of trusted host names. When omitted, the gate reads `peers.json`
   * fresh per request (so `orc remote add` takes effect without a restart). Tests pass a
   * static list.
   */
  allowlist?: string[];
  /** This host's identity for `/health` + `/whoami` (defaults to os.hostname()). */
  hostName?: string;
  /** orc version string for `/health` (defaults to package.json). */
  version?: string;
  /** Resolve a request's source IP. Default uses `server.requestIP`. Injectable for tests. */
  resolveIp?: (req: Request, server: Bun.Server<undefined>) => string | null;
  /** Resolve a source IP to a tailnet identity. Default `whoisIdentity`. Injectable for tests. */
  whois?: (ip: string | null) => Promise<Identity | null>;
}

/** A handler error carrying an HTTP status; the outer catch maps it to a JSON response. */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** Parse a JSON request body; empty/invalid body => {} (callers validate required fields). */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.trim().length === 0) return {};
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function boolParam(v: string | null): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

function readSelectionFromParams(params: URLSearchParams): TurnSelection {
  const full = boolParam(params.get('full'));
  const last = boolParam(params.get('last'));
  const indexRaw = params.get('index');
  const selectionFlags = [full, last, indexRaw !== null].filter(Boolean).length;
  if (selectionFlags > 1) {
    throw new HttpError(400, 'full, last, and index are mutually exclusive');
  }
  if (indexRaw !== null) {
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0) {
      throw new HttpError(400, `invalid index '${indexRaw}' (non-negative integer)`);
    }
    return { mode: 'index', index };
  }
  if (full) return { mode: 'full' };
  return { mode: 'latest' };
}

/**
 * Build the daemon's `fetch` handler. Pure-ish: all impure edges (whois, IP resolution)
 * are injectable. The returned function is what `Bun.serve` calls and what tests drive
 * over a live loopback socket.
 */
export function createFetch(opts: DaemonOptions): (req: Request, server: Bun.Server<undefined>) => Promise<Response> {
  const resolveIp = opts.resolveIp ?? ((req, server) => server.requestIP(req)?.address ?? null);
  const whois = opts.whois ?? whoisIdentity;
  const hostName = opts.hostName ?? os.hostname();
  const configuredSecret = opts.secret && opts.secret.length > 0 ? opts.secret : null;
  const versionPromise = opts.version ? Promise.resolve(opts.version) : readVersion();

  const getAllowlist = async (): Promise<string[]> =>
    opts.allowlist !== undefined ? opts.allowlist : await peerHosts();

  return async function fetch(req: Request, server: Bun.Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    const match = matchRoute(req.method, url.pathname);
    if (!match) return jsonError(404, `no route for ${req.method} ${url.pathname}`);

    // /health is the ONLY unauthenticated route (liveness).
    if (match.name === 'health') {
      return json({ ok: true, version: await versionPromise, host: hostName });
    }

    // ---- Trust gate (fail closed) — every other route. ----
    const ip = resolveIp(req, server);
    const identity = await whois(ip).catch(() => null);
    const presentedSecret = req.headers.get('x-orc-secret');
    const allowlist = await getAllowlist();
    const allowed = decideTrust(identity, allowlist, presentedSecret, configuredSecret);
    if (!allowed) {
      return jsonError(
        403,
        'forbidden: caller is not an allowlisted tailnet peer and presented no valid secret',
      );
    }

    try {
      return await dispatch(match.name, match.params, req, url, {
        hostName,
        identity,
        allowlist,
        versionPromise,
      });
    } catch (e) {
      if (e instanceof HttpError) return jsonError(e.status, e.message);
      return jsonError(500, (e as Error).message);
    }
  };
}

interface DispatchCtx {
  hostName: string;
  identity: Identity | null;
  allowlist: string[];
  versionPromise: Promise<string>;
}

/** Route a matched request to the SDK and build its JSON response. */
async function dispatch(
  name: RouteName,
  params: Record<string, string>,
  req: Request,
  url: URL,
  ctx: DispatchCtx,
): Promise<Response> {
  switch (name) {
    case 'health':
      return json({ ok: true, version: await ctx.versionPromise, host: ctx.hostName });

    case 'whoami':
      return json({
        host: ctx.hostName,
        peerAllowed: ctx.identity ? isAllowlisted(ctx.identity, ctx.allowlist) : false,
        identity: ctx.identity,
      });

    case 'sessions.list': {
      const sessions = await listSessions({
        workspace: url.searchParams.get('workspace') ?? undefined,
        all: boolParam(url.searchParams.get('all')),
        dead: boolParam(url.searchParams.get('dead')),
      });
      const views = await Promise.all(
        sessions.map(async (s) => ({
          ...s.toJSON(),
          status: (await s.status().catch(() => 'dead')) as 'running' | 'dead',
        })),
      );
      return json(views);
    }

    case 'sessions.spawn': {
      const body = await readJsonBody(req);
      let agentOpts;
      try {
        agentOpts = mapSpawnRequest(body);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const session = await agent(agentOpts);
      return json(session.toJSON());
    }

    case 'sessions.get': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const state = await session.state();
      const status = (await session.status().catch(() => 'dead')) as 'running' | 'dead';
      return json({ ...session.toJSON(), status, state });
    }

    case 'sessions.send': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const body = await readJsonBody(req);
      const prompt = body.prompt;
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new HttpError(400, 'send requires a non-empty `prompt` string');
      }
      await session.send(prompt);
      return json({ ok: true, id: session.id });
    }

    case 'sessions.wait': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const body = await readJsonBody(req);
      let waitOpts;
      try {
        waitOpts = mapWaitRequest(body);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const startedAt = Date.now();
      const result = await session.waitForResult(waitOpts);
      const elapsedMs = Date.now() - startedAt;
      return json({
        id: session.id,
        state: result.state,
        elapsedMs,
        timedOut: !result.settled,
      });
    }

    case 'sessions.read': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      if (boolParam(url.searchParams.get('raw'))) {
        if (
          boolParam(url.searchParams.get('full')) ||
          boolParam(url.searchParams.get('last')) ||
          url.searchParams.has('index')
        ) {
          throw new HttpError(400, 'raw cannot be combined with full, last, or index');
        }
        const pane = await session.capture({ scrollback: true });
        return json({ kind: 'raw', id: session.id, pane });
      }
      const selection = readSelectionFromParams(url.searchParams);
      const turns = await session.readParsed();
      let selected;
      try {
        selected = selectTurns(turns, selection);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (turns.length > 0) return json({ kind: 'parsed', id: session.id, turns: selected });
      // Nothing on disk yet — fall back to the live pane (the CLI does the same).
      const pane = await session.capture();
      return json({ kind: 'fallback', id: session.id, pane });
    }

    case 'sessions.kill': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const body = await readJsonBody(req);
      const purge = body.purge === true;
      await session.kill({ removeWorktree: body.worktree === true, purge });
      return json({ ok: true, id: session.id, purged: purge });
    }

    case 'workflows.runs.list': {
      const runs = await listRuns();
      const reconciled = await Promise.all(runs.map((r) => reconcileRun(r)));
      return json(reconciled);
    }

    case 'workflows.runs.get': {
      const run = await readRun(params.id!);
      if (!run) throw new HttpError(404, `no run found for '${params.id}'`);
      await reconcileRun(run);
      return json(run);
    }

    case 'workflows.runs.logs': {
      const run = await readRun(params.id!);
      if (!run) throw new HttpError(404, `no run found for '${params.id}'`);
      const stepId = url.searchParams.get('step') ?? undefined;
      let selected: StepResult[] = run.steps;
      if (stepId !== undefined) {
        selected = run.steps.filter((s) => s.id === stepId);
        if (selected.length === 0) {
          const have = run.steps.map((s) => s.id).join(', ') || 'none';
          throw new HttpError(404, `run '${run.id}' has no step '${stepId}' (steps: ${have})`);
        }
      }
      if (boolParam(url.searchParams.get('raw'))) {
        const panes: { step: string; provider: StepResult['provider']; pane: string }[] = [];
        for (const s of selected) {
          let pane = '';
          if (s.sessionId) {
            const session = await getSession(s.sessionId);
            if (session) pane = await session.capture({ scrollback: true }).catch(() => '');
          }
          panes.push({ step: s.id, provider: s.provider, pane });
        }
        return json({ kind: 'raw', logs: panes });
      }
      const logs = await assembleStepLogs(selected, async (s) => {
        if (!s.sessionId) return [];
        const session = await getSession(s.sessionId);
        if (!session) return [];
        return session.readParsed().catch(() => []);
      });
      return json({ kind: 'parsed', logs: logs.map((l) => ({ step: l.step, provider: l.provider, turns: l.turns })) });
    }

    case 'workflows.run':
      return runWorkflowRoute(req);
  }
}

/**
 * `POST /workflows/run {file?, def?, detach?}`. Foreground: run a def (inline `def`, or
 * imported from the host-local `file`) to completion and return the `WorkflowRun`. Detach:
 * mint a runId, write an initial `running` record, and launch a detached
 * `orc workflow run <file> --run-id <id>` runner (mirrors the CLI `--detach` path) —
 * returns `{ runId, runnerTmux }` immediately. Detach requires `file`.
 */
async function runWorkflowRoute(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body.file === 'string' ? body.file : undefined;
  const detach = body.detach === true;

  if (detach) {
    if (!file) throw new HttpError(400, 'workflow run --detach requires a `file` (a host-local path)');
    const def = await importWorkflowFile(file);
    try {
      validateWorkflowDef(def);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const runId = randomUUID().slice(0, 8);
    const runnerTmux = runnerTmuxName(runId);
    const run: WorkflowRun = {
      id: runId,
      name: def.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      runnerTmux,
      steps: [],
    };
    await writeRun(run);
    const cliEntry = path.resolve(import.meta.dir, '../cli/index.ts');
    const argv = [process.execPath, cliEntry, 'workflow', 'run', path.resolve(file), '--run-id', runId];
    try {
      await getDriver().spawn({ name: runnerTmux, cwd: process.cwd(), argv, env: { ORC_HOME: orcHome() } });
    } catch (e) {
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      await writeRun(run).catch(() => {});
      throw new HttpError(500, `failed to launch detached runner: ${(e as Error).message}`);
    }
    return json({ runId, runnerTmux });
  }

  // Foreground: resolve the def from `def` or by importing `file`.
  let def: WorkflowDef;
  if (body.def && typeof body.def === 'object') {
    def = body.def as WorkflowDef;
  } else if (file) {
    def = await importWorkflowFile(file);
  } else {
    throw new HttpError(400, 'workflow run requires `file` (a host-local path) or `def` (inline)');
  }
  try {
    validateWorkflowDef(def);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const run = await runWorkflow(def);
  return json(run);
}

/** Import a host-local workflow file and return its default-exported def (400 on failure). */
async function importWorkflowFile(file: string): Promise<WorkflowDef> {
  const abs = path.resolve(file);
  try {
    const mod = (await import(abs)) as { default?: WorkflowDef };
    if (!mod.default) throw new Error(`workflow file '${file}' has no default export`);
    return mod.default;
  } catch (e) {
    throw new HttpError(400, `failed to import workflow '${file}': ${(e as Error).message}`);
  }
}

/**
 * Start the daemon with `Bun.serve`. CRITICAL: `idleTimeout: 0` — a long-poll `wait` or a
 * foreground `workflow run` holds the connection open with no bytes crossing the socket
 * for minutes; Bun's default ~10s idle timeout would reset the connection mid-wait.
 */
export function serveDaemon(opts: DaemonOptions): Bun.Server<undefined> {
  return Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 0,
    fetch: createFetch(opts),
  });
}
