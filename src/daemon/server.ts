/**
 * The orc daemon — a thin HTTP/JSON layer over the existing SDK plus the trust gate. It
 * adds NO orchestration logic: every route maps 1:1 to a `Session`/`agent`/`runWorkflow`
 * call against the SAME `~/.orc` the local `orc` uses.
 *
 * SECURITY: every route EXCEPT `/health` is behind fail-closed authentication and
 * scoped authorization (`authenticate` + `authorize`). The bind address is decided
 * by `resolveBind` (never `0.0.0.0` by default). The handler is factored out of
 * `Bun.serve` (`createFetch`) so it can be exercised over a live loopback socket in
 * tests with an injectable whois.
 *
 * `/mcp` serves the orc MCP tools (src/mcp/http.ts) behind the same authentication, a
 * Host/Origin guard, and per-tool scopes (each tool needs the scope of its REST route).
 */
import path from 'node:path';
import os from 'node:os';
import { agent, validateOptions } from '../agent.ts';
import { PolicyViolationError } from '../policy.ts';
import { listSessions, getSession } from '../index.ts';
import {
  runWorkflow,
  resumeWorkflow,
  retryWorkflow,
  cancelWorkflow,
  cleanupWorkflow,
  reconcileRun,
  assembleStepLogs,
  validateWorkflowDef,
  resolveContainedWorkflowFile,
} from '../workflow.ts';
import type { WorkflowDef, WorkflowRun, StepResult } from '../workflow.ts';
import { schedulingSummary } from '../workflow-scheduler.ts';
import { readRun, listRuns, FinalizedRunError, LiveOwnerError } from '../runs.ts';
import { launchDetachedRecovery, launchDetachedRun, RunnerSpawnError } from '../workflow-runner.ts';
import type { RunnerSpawner } from '../workflow-runner.ts';
import { selectTurns } from '../transcript.ts';
import type { TurnSelection } from '../transcript.ts';
import type { JournalEntry } from '../runtime/types.ts';
import { VERSION } from '../version.ts';
import { DAEMON_API_VERSION } from './client.ts';

/** Journal entries per step returned by raw run logs. */
const RAW_JOURNAL_TAIL = 200;
import { isAllowlisted } from './trust.ts';
import type { Identity } from './trust.ts';
import {
  authenticate,
  authorize,
  extractBearerToken,
  reportPrincipal,
  routeAuth,
} from './auth.ts';
import type { Principal, Scope } from './auth.ts';
import { whoisIdentity } from './tailscale.ts';
import { peerHosts } from './peers.ts';
import { matchRoute, mapSpawnRequest, mapWaitRequest, mapSendRequest } from './routes.ts';
import type { RouteName } from './routes.ts';
// The MCP endpoint itself (src/mcp/http.ts) is imported lazily: only hosts.ts (no SDK) here.
import { MCP_PATH, mcpAllowedHosts } from '../mcp/hosts.ts';
import type { DaemonMcp } from '../mcp/http.ts';

/**
 * Daemon list/get projection: expose concurrency + scheduling state without
 * plan prompts / task bodies that may hold credentials.
 */
function publicWorkflowRunView(run: WorkflowRun): Record<string, unknown> {
  const sched = schedulingSummary(run.plan, run.attempts, run.steps);
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    schemaVersion: run.schemaVersion,
    revision: run.revision,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    definitionDigest: run.definitionDigest,
    maxConcurrency: sched?.maxConcurrency ?? run.plan?.maxConcurrency ?? 1,
    policy: run.policy,
    // Host-local log path is deliberately not exposed: remote attach follows it ON the
    // host (`tailscale ssh <host> orc workflow attach <runId>`).
    runner: run.runner ? { pid: run.runner.pid, startedAt: run.runner.startedAt } : undefined,
    lease: run.lease
      ? {
          ownerId: run.lease.ownerId,
          expiresAt: run.lease.expiresAt,
        }
      : undefined,
    steps: run.steps.map((s) => ({
      id: s.id,
      provider: s.provider,
      ok: s.ok,
      state: s.state,
      outcome: s.outcome,
      sessionId: s.sessionId,
      commitsAhead: s.commitsAhead,
      worktree: s.worktree,
      branch: s.branch,
      unverified: s.unverified,
    })),
    scheduling: sched
      ? { maxConcurrency: sched.maxConcurrency, steps: sched.steps }
      : undefined,
    attempts: (run.attempts ?? []).map((a) => ({
      attemptId: a.attemptId,
      attemptNumber: a.attemptNumber,
      stepId: a.stepId,
      phase: a.phase,
      sessionId: a.sessionId,
      errorCategory: a.errorCategory,
      errorMessage: a.errorMessage,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    })),
  };
}

export interface DaemonOptions {
  /** Resolved bind address (from `resolveBind`). */
  hostname: string;
  port: number;
  /**
   * Legacy shared secret (`ORC_DAEMON_SECRET` / `x-orc-secret`); null = not configured.
   * When presented and valid, grants all scopes (backward-compatible all-access principal).
   */
  secret?: string | null;
  /**
   * Scoped bearer tokens: token string → scopes. Prefer over the legacy secret for
   * least-privilege clients. Configured via `ORC_DAEMON_TOKENS` JSON at daemon startup.
   * Token values are never logged or returned.
   */
  tokens?: ReadonlyMap<string, readonly Scope[]> | null;
  /**
   * Static allowlist of trusted host names. When omitted, the gate reads `peers.json`
   * fresh per request (so `orc remote add` takes effect without a restart). Tests pass a
   * static list. Allowlisted identity is an all-scopes principal.
   */
  allowlist?: string[];
  /** This host's identity for `/health` + `/whoami` (defaults to os.hostname()). */
  hostName?: string;
  /** orc version string for `/health` (defaults to VERSION: package.json, embedded at build). */
  version?: string;
  /** Resolve a request's source IP. Default uses `server.requestIP`. Injectable for tests. */
  resolveIp?: (req: Request, server: Bun.Server<undefined>) => string | null;
  /** Resolve a source IP to a tailnet identity. Default `whoisIdentity`. Injectable for tests. */
  whois?: (ip: string | null) => Promise<Identity | null>;
  /** Spawner for detached workflow runners. Default `spawnDetached`. Injectable for tests. */
  spawnRunner?: RunnerSpawner;
  /** The MCP endpoint (`/mcp`). */
  mcp?: DaemonMcpConfig;
}

/** Options of the daemon's `/mcp` endpoint. */
export interface DaemonMcpConfig {
  /**
   * Host names (no port) `/mcp` accepts in `Host` (and `Origin`): the DNS-rebinding guard.
   * Default: derived from `hostname` alone (`mcpAllowedHosts`); `orc daemon` adds this
   * node's tailnet names and `--mcp-allow-host` entries.
   */
  allowedHosts?: readonly string[];
  /** `wait`'s default timeout in seconds (default 45). */
  waitTimeoutSec?: number;
  /** argv prefix of the orc CLI the tools run (default: this build). Tests. */
  cliArgv?: readonly string[];
  /** Base env of the tools' CLI children (default: the daemon's, minus daemon credentials). */
  env?: Record<string, string | undefined>;
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
  const tokens: ReadonlyMap<string, readonly Scope[]> = opts.tokens ?? new Map();
  const version = opts.version || VERSION;

  const getAllowlist = async (): Promise<string[]> =>
    opts.allowlist !== undefined ? opts.allowlist : await peerHosts();

  /** Authenticate a request (fail closed): tailnet identity, bearer token, legacy secret. */
  const authRequest = async (req: Request, server: Bun.Server<undefined>) => {
    const ip = resolveIp(req, server);
    const identity = await whois(ip).catch(() => null);
    const presentedSecret = req.headers.get('x-orc-secret');
    const presentedBearer = extractBearerToken(req.headers.get('authorization'));
    const allowlist = await getAllowlist();
    const authn = authenticate({
      identity,
      allowlist,
      presentedSecret,
      configuredSecret,
      presentedBearer,
      tokens,
    });
    return { authn, identity, allowlist };
  };

  // The MCP endpoint, created on its first request (the MCP SDK loads only then).
  const mcpHosts = opts.mcp?.allowedHosts ?? mcpAllowedHosts({ bind: opts.hostname });
  let mcp: Promise<DaemonMcp> | undefined;
  const loadMcp = (): Promise<DaemonMcp> =>
    (mcp ??= import('../mcp/http.ts')
      .then((m) =>
        m.createDaemonMcp({
          allowedHosts: mcpHosts,
          waitTimeoutSec: opts.mcp?.waitTimeoutSec,
          cliArgv: opts.mcp?.cliArgv,
          env: opts.mcp?.env,
        }),
      )
      .catch((e: unknown) => {
        mcp = undefined;
        throw e;
      }));

  /**
   * `/mcp`: the Host/Origin guard first (403: a DNS-rebound browser may carry an allowlisted
   * peer's tailnet identity), then the same authentication as every REST route (401), then
   * the MCP handler, which authorizes each tool by the principal's scopes.
   */
  const serveMcp = async (req: Request, server: Bun.Server<undefined>): Promise<Response> => {
    try {
      const endpoint = await loadMcp();
      const rejected = endpoint.guard(req);
      if (rejected) return rejected;
      const { authn } = await authRequest(req, server);
      if (!authn.ok) return jsonError(authn.status, authn.message);
      return await endpoint.serve(req, authn.principal);
    } catch (e) {
      return jsonError(500, (e as Error).message);
    }
  };

  return async function fetch(req: Request, server: Bun.Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === MCP_PATH) return serveMcp(req, server);
    const match = matchRoute(req.method, url.pathname);
    if (!match) return jsonError(404, `no route for ${req.method} ${url.pathname}`);

    const authReq = routeAuth(match.name);

    // /health is the ONLY unauthenticated route (liveness).
    if (authReq.type === 'public' || match.name === 'health') {
      return json({ ok: true, version, host: hostName, api: DAEMON_API_VERSION, mcp: MCP_PATH });
    }

    // ---- Authn + authz (fail closed) — every other route. ----
    const { authn, identity, allowlist } = await authRequest(req, server);
    if (!authn.ok) {
      return jsonError(authn.status, authn.message);
    }
    const authz = authorize(authn.principal, authReq);
    if (!authz.ok) {
      return jsonError(authz.status, authz.message);
    }

    try {
      return await dispatch(match.name, match.params, req, url, {
        hostName,
        identity,
        allowlist,
        principal: authn.principal,
        version,
        spawnRunner: opts.spawnRunner,
      });
    } catch (e) {
      return jsonError(httpStatusFor(e), (e as Error).message);
    }
  };
}

/**
 * HTTP status for an error escaping a route (documented daemon contract):
 * - 400 invalid request (route validation: HttpError(400))
 * - 403 PolicyViolationError — the execution policy forbids it (spawn / wake)
 * - 404 ORC_SESSION_UNKNOWN — no runtime state (purged / never started)
 * - 409 ORC_SESSION_STOPPED (killed / taken over: `orc resume` first),
 *       ORC_MESSAGE_CONFLICT (idempotency key reused with a different prompt),
 *       ORC_SESSION_LEGACY (pre-actor session: read-only)
 * - 502 ORC_SESSION_START_FAILED — the provider CLI failed to start
 * - 500 anything else
 */
export function httpStatusFor(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof PolicyViolationError) return 403;
  switch ((e as { code?: unknown } | null)?.code) {
    case 'ORC_SESSION_STOPPED':
    case 'ORC_MESSAGE_CONFLICT':
    case 'ORC_SESSION_LEGACY':
      return 409;
    case 'ORC_SESSION_UNKNOWN':
      return 404;
    case 'ORC_SESSION_START_FAILED':
      return 502;
    default:
      return 500;
  }
}

interface DispatchCtx {
  hostName: string;
  identity: Identity | null;
  allowlist: string[];
  principal: Principal;
  version: string;
  spawnRunner?: RunnerSpawner;
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
      return json({ ok: true, version: ctx.version, host: ctx.hostName, api: DAEMON_API_VERSION, mcp: MCP_PATH });

    case 'whoami':
      return json({
        host: ctx.hostName,
        peerAllowed: ctx.identity ? isAllowlisted(ctx.identity, ctx.allowlist) : false,
        identity: ctx.identity,
        principal: reportPrincipal(ctx.principal),
      });

    case 'sessions.list': {
      const sessions = await listSessions({
        workspace: url.searchParams.get('workspace') ?? undefined,
        all: boolParam(url.searchParams.get('all')),
        dead: boolParam(url.searchParams.get('dead')),
      });
      const views = await Promise.all(
        sessions.map(async (s) => {
          const d = await s.stateDetail().catch(() => undefined);
          return { ...s.toJSON(), status: d?.status ?? 'dead', ...(d ? { state: d.state } : {}) };
        }),
      );
      return json(views);
    }

    case 'sessions.spawn': {
      const body = await readJsonBody(req);
      let agentOpts;
      try {
        agentOpts = mapSpawnRequest(body);
        validateOptions(agentOpts); // option-combination errors are 400s, not 500s
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const session = await agent(agentOpts);
      return json(session.toJSON());
    }

    case 'sessions.get': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const d = await session.stateDetail();
      return json({
        ...session.toJSON(),
        status: d.status,
        state: d.state,
        suspended: d.suspended,
        stopped: d.stopped,
      });
    }

    case 'sessions.send': {
      const session = await getSession(params.id!);
      if (!session) throw new HttpError(404, `no session found for '${params.id}'`);
      const body = await readJsonBody(req);
      let mapped;
      try {
        mapped = mapSendRequest(body);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const result = await session.send(mapped.prompt, {
        ...(mapped.messageId ? { messageId: mapped.messageId } : {}),
        ...(mapped.wake === false ? { wake: false } : {}),
      });
      return json({
        ok: result.phase === 'acknowledged' || result.phase === 'queued',
        id: session.id,
        phase: result.phase,
        messageId: result.messageId,
        replayed: result.replayed,
      });
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
        return json({ kind: 'raw', id: session.id, journal: session.journal() });
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
      // No transcript on disk yet — fall back to the session journal (the CLI does the same).
      return json({ kind: 'fallback', id: session.id, journal: session.journal() });
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
      // Public projection: maxConcurrency + scheduling, no plan prompts.
      return json(reconciled.map(publicWorkflowRunView));
    }

    case 'workflows.runs.get': {
      const run = await readRun(params.id!);
      if (!run) throw new HttpError(404, `no run found for '${params.id}'`);
      return json(publicWorkflowRunView(await reconcileRun(run)));
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
        const logs: { step: string; provider: StepResult['provider']; journal: JournalEntry[] }[] = [];
        for (const s of selected) {
          let journal: JournalEntry[] = [];
          if (s.sessionId) {
            const session = await getSession(s.sessionId);
            if (session) journal = session.journal({ tail: RAW_JOURNAL_TAIL });
          }
          logs.push({ step: s.id, provider: s.provider, journal });
        }
        return json({ kind: 'raw', logs });
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
      return runWorkflowRoute(req, ctx);

    case 'workflows.runs.resume': {
      const runId = params.id!;
      const existing = await readRun(runId);
      if (!existing) throw new HttpError(404, `no run found for '${runId}'`);
      if (existing.status === 'cancelled') {
        throw new HttpError(409, `run '${runId}' is cancelled; use retry`);
      }
      if (existing.status === 'running') {
        const live = await reconcileRun(existing);
        if (live.status === 'running' && live.lease) {
          throw new HttpError(409, `run '${runId}' still has a live owner; wait or cancel first`);
        }
      }
      const body = await readJsonBody(req);
      const file =
        typeof body.file === 'string'
          ? body.file
          : existing.sourcePath ?? existing.workflowSourcePath;
      if (!file) {
        throw new HttpError(
          400,
          'resume requires `file` (original workflow path) or a run with sourcePath',
        );
      }
      const { def, absPath } = await importWorkflowFileWithPath(file);
      if (body.detach === true) {
        return detachWorkflowControl('resume', runId, def, absPath, ctx);
      }
      try {
        const run = await resumeWorkflow(runId, def, { sourcePath: absPath });
        return json(run);
      } catch (e) {
        const msg = (e as Error).message;
        if (/digest mismatch|done predicate|no run found|requires the original/.test(msg)) {
          throw new HttpError(400, msg);
        }
        if (/cancelled|live owner|cannot be safely|require.*retry/i.test(msg)) {
          throw new HttpError(409, msg);
        }
        throw e;
      }
    }

    case 'workflows.runs.retry': {
      const runId = params.id!;
      const existing = await readRun(runId);
      if (!existing) throw new HttpError(404, `no run found for '${runId}'`);
      if (existing.status === 'running') {
        const live = await reconcileRun(existing);
        if (live.status === 'running' && live.lease) {
          throw new HttpError(409, `run '${runId}' still has a live owner; wait or cancel first`);
        }
      }
      const body = await readJsonBody(req);
      const file =
        typeof body.file === 'string'
          ? body.file
          : existing.sourcePath ?? existing.workflowSourcePath;
      if (!file) {
        throw new HttpError(
          400,
          'retry requires `file` (original workflow path) or a run with sourcePath',
        );
      }
      const stepId =
        typeof body.step === 'string'
          ? body.step
          : typeof body.stepId === 'string'
            ? body.stepId
            : undefined;
      const { def, absPath } = await importWorkflowFileWithPath(file);
      if (body.detach === true) {
        return detachWorkflowControl('retry', runId, def, absPath, ctx, stepId);
      }
      try {
        const run = await retryWorkflow(runId, def, { sourcePath: absPath, stepId });
        return json(run);
      } catch (e) {
        const msg = (e as Error).message;
        if (/digest mismatch|no step|no run found|requires the original/.test(msg)) {
          throw new HttpError(400, msg);
        }
        if (/live owner|cannot be safely|require.*retry/i.test(msg)) {
          throw new HttpError(409, msg);
        }
        throw e;
      }
    }

    case 'workflows.runs.cancel': {
      const runId = params.id!;
      const existing = await readRun(runId);
      if (!existing) throw new HttpError(404, `no run found for '${runId}'`);
      const body = await readJsonBody(req);
      const run = await cancelWorkflow(runId, { cascade: body.cascade === true });
      return json(run);
    }

    case 'workflows.runs.cleanup': {
      const runId = params.id!;
      const existing = await readRun(runId);
      if (!existing) throw new HttpError(404, `no run found for '${runId}'`);
      const body = await readJsonBody(req);
      try {
        const result = await cleanupWorkflow(runId, {
          sessions: body.sessions === true,
          worktrees: body.worktrees === true,
        });
        return json(result);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
  }
}

/**
 * Parse optional `maxConcurrency` from a daemon JSON body. Returns undefined when
 * absent; throws HttpError(400) on invalid values.
 */
function parseBodyMaxConcurrency(body: Record<string, unknown>): number | undefined {
  if (body.maxConcurrency === undefined && body.max_concurrency === undefined) return undefined;
  const raw = body.maxConcurrency !== undefined ? body.maxConcurrency : body.max_concurrency;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new HttpError(400, `maxConcurrency must be a positive integer (>= 1), got ${String(raw)}`);
  }
  if (raw > 10_000) {
    throw new HttpError(400, `maxConcurrency must be <= 10000, got ${raw}`);
  }
  return raw;
}

/**
 * `POST /workflows/run {file?, def?, detach?, maxConcurrency?}`. Foreground: run a def
 * (inline `def`, or imported from the host-local `file`) to completion and return the
 * `WorkflowRun`. Detach: mint a runId, write an initial `running` record, and launch a
 * detached `orc workflow run <file> --run-id <id>` runner process (the same helper as
 * the CLI `--detach` path) — returns `{ runId, logPath }` immediately. Detach requires
 * `file`.
 */
async function runWorkflowRoute(req: Request, ctx: DispatchCtx): Promise<Response> {
  const body = await readJsonBody(req);
  const file = typeof body.file === 'string' ? body.file : undefined;
  const detach = body.detach === true;
  const maxConcurrency = parseBodyMaxConcurrency(body);

  if (detach) {
    if (!file) throw new HttpError(400, 'workflow run --detach requires a `file` (a host-local path)');
    const def = await importWorkflowFile(file);
    try {
      validateWorkflowDef(maxConcurrency !== undefined ? { ...def, maxConcurrency } : def);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    try {
      const launch = await launchDetachedRun(def, path.resolve(file), {
        maxConcurrency,
        spawn: ctx.spawnRunner,
      });
      return json({ runId: launch.runId, logPath: launch.logPath });
    } catch (e) {
      // The definition was validated above: anything left is a server-side failure.
      const prefix = e instanceof RunnerSpawnError ? 'failed to launch detached runner: ' : '';
      throw new HttpError(500, `${prefix}${(e as Error).message}`);
    }
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
  if (maxConcurrency !== undefined) {
    def = { ...def, maxConcurrency };
  }
  try {
    validateWorkflowDef(def);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const run = await runWorkflow(def, { maxConcurrency });
  return json(run);
}

/** Import a host-local workflow file and return its default-exported def (400 on failure). */
async function importWorkflowFile(file: string): Promise<WorkflowDef> {
  const { def } = await importWorkflowFileWithPath(file);
  return def;
}

async function importWorkflowFileWithPath(
  file: string,
): Promise<{ def: WorkflowDef; absPath: string }> {
  let absPath: string;
  try {
    absPath = await resolveContainedWorkflowFile(file);
  } catch (e) {
    // Fall back to resolve for absolute paths already known on disk (resume sourcePath).
    absPath = path.resolve(file);
    if (!(await Bun.file(absPath).exists())) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  try {
    const mod = (await import(absPath)) as { default?: WorkflowDef };
    if (!mod.default) throw new Error(`workflow file '${file}' has no default export`);
    validateWorkflowDef(mod.default);
    return { def: mod.default, absPath };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `failed to import workflow '${file}': ${(e as Error).message}`);
  }
}

/**
 * Detached resume/retry: the same status preconditions as the foreground paths (a
 * `done` run is never resurrected → 409), then spawn `orc workflow resume|retry <runId>
 * <file> --runner` as a detached process and only THEN stamp the record (D7) — a spawn
 * failure leaves the record untouched. Returns `{ runId, logPath, action }`.
 */
async function detachWorkflowControl(
  mode: 'resume' | 'retry',
  runId: string,
  def: WorkflowDef,
  absPath: string,
  ctx: DispatchCtx,
  stepId?: string,
): Promise<Response> {
  try {
    const launch = await launchDetachedRecovery(mode, runId, def, absPath, {
      stepId,
      spawn: ctx.spawnRunner,
    });
    return json({ runId, logPath: launch.logPath, action: mode });
  } catch (e) {
    if (e instanceof RunnerSpawnError) {
      throw new HttpError(500, `failed to launch detached ${mode}: ${e.message}`);
    }
    if (e instanceof FinalizedRunError || e instanceof LiveOwnerError) {
      throw new HttpError(409, e.message);
    }
    const msg = (e as Error).message;
    if (/no run found/.test(msg)) throw new HttpError(404, msg);
    if (/digest mismatch|done predicate|no step|requires the original/.test(msg)) {
      throw new HttpError(400, msg);
    }
    if (/cancelled/.test(msg)) throw new HttpError(409, msg);
    throw e;
  }
}

/**
 * Start the daemon with `Bun.serve`. CRITICAL: `idleTimeout: 0` — a long-poll `wait` (REST,
 * or the MCP `wait` tool on `/mcp`) or a foreground `workflow run` holds the connection open
 * with no bytes crossing the socket for minutes; Bun's default ~10s idle timeout would
 * reset the connection mid-wait.
 */
export function serveDaemon(opts: DaemonOptions): Bun.Server<undefined> {
  return Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: 0,
    fetch: createFetch(opts),
  });
}
