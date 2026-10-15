/**
 * The HTTP client behind `orc --host <h> <command>` and `orc list --all-hosts`. A thin
 * 1:1 wrapper over the daemon's JSON API: each method makes one request and returns the
 * parsed body. The CLI feeds the results to the SAME renderers as the local path, so the
 * `--host` output is identical to local (`--json` byte-for-byte).
 */
import type { AgentState, SessionRecord, SessionStatus } from '../types.ts';
import type { JournalEntry } from '../runtime/types.ts';
import type { Turn } from '../transcript.ts';
import type { TurnSelection } from '../transcript.ts';
import type { WorkflowRun } from '../workflow.ts';
import { DEFAULT_DAEMON_PORT } from './peers.ts';

export interface RemoteTarget {
  host: string;
  port: number;
}

/** Parse a `--host` value (`host` or `host:port`) into a target with the default port. */
export function parseHostArg(raw: string, defaultPort = DEFAULT_DAEMON_PORT): RemoteTarget {
  const trimmed = raw.trim();
  // IPv6 literals aren't expected for tailnet MagicDNS names; keep it simple: last colon
  // separates an optional port.
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(trimmed.slice(idx + 1))) {
    const host = trimmed.slice(0, idx);
    const port = Number.parseInt(trimmed.slice(idx + 1), 10);
    return { host, port };
  }
  return { host: trimmed, port: defaultPort };
}

/**
 * Wire version of the session views. v2 (actor runtime): raw/fallback reads and raw run
 * logs carry the session `journal` (normalized JSONL entries) instead of the pre-actor `pane`;
 * session views carry `status` running|suspended|dead plus `state`/`suspended`/`stopped`.
 * `GET /health` reports it as `api`. The v1 (`pane`) shapes are kept in the unions so a
 * v2 client still renders an older daemon's answers.
 */
export const DAEMON_API_VERSION = 2;

/** v2 read shape of `GET /sessions/:id/read` (discriminated; the CLI renders each kind). */
export type ReadResultV2 =
  | { kind: 'parsed'; id: string; turns: Turn[] }
  | { kind: 'fallback'; id: string; journal: JournalEntry[] }
  | { kind: 'raw'; id: string; journal: JournalEntry[] };

/** v1 (pre-actor daemon) raw/fallback reads. */
export type ReadResultV1Pane = { kind: 'fallback' | 'raw'; id: string; pane: string };

export type ReadResult = ReadResultV2 | ReadResultV1Pane;

export type RawStepLog = { step: string; provider: string; journal: JournalEntry[] };
/** v1 (pre-actor daemon) raw step log. */
export type RawStepLogV1 = { step: string; provider: string; pane: string };

export type LogsResult =
  | { kind: 'parsed'; logs: { step: string; provider: string; turns: Turn[] }[] }
  | { kind: 'raw'; logs: (RawStepLog | RawStepLogV1)[] };

/** `GET /sessions` row / `GET /sessions/:id` body. */
export type RemoteSessionView = SessionRecord & {
  status?: SessionStatus;
  state?: AgentState | string;
  suspended?: boolean;
  stopped?: boolean;
};

/** `POST /sessions/:id/send` body. */
export interface RemoteSendResult {
  ok: boolean;
  id: string;
  /** v2 phases; a v1 (pre-actor) daemon may answer `submitted` (written, not yet acked). */
  phase?: 'queued' | 'acknowledged' | 'unknown' | 'failed' | 'submitted';
  messageId?: string;
  replayed?: boolean;
}

/**
 * Detached `run`/`resume`/`retry` response: the run id and the HOST-LOCAL runner log
 * (follow it on the host with `orc workflow attach <runId>`). `action` is set for
 * resume/retry.
 */
export interface DetachedWorkflowLaunch {
  runId: string;
  logPath: string;
  action?: 'resume' | 'retry';
}

export interface WaitResult {
  id: string;
  state: string;
  elapsedMs: number;
  timedOut: boolean;
}

export interface DaemonClientOptions {
  /** Legacy shared secret → `x-orc-secret` (all-scopes principal when valid). */
  secret?: string | null;
  /** Scoped bearer token → `Authorization: Bearer …` (`ORC_DAEMON_TOKEN`). */
  token?: string | null;
}

export class DaemonClient {
  readonly base: string;
  readonly host: string;
  private readonly secret?: string;
  private readonly token?: string;

  constructor(
    target: RemoteTarget,
    secretOrOpts: string | null | undefined | DaemonClientOptions = process.env.ORC_DAEMON_SECRET,
  ) {
    this.host = target.host;
    this.base = `http://${target.host}:${target.port}`;
    // Backward compatible: second arg may still be a secret string (or env default).
    if (secretOrOpts && typeof secretOrOpts === 'object') {
      const secret = secretOrOpts.secret ?? process.env.ORC_DAEMON_SECRET;
      const token = secretOrOpts.token ?? process.env.ORC_DAEMON_TOKEN;
      this.secret = secret && secret.length > 0 ? secret : undefined;
      this.token = token && token.length > 0 ? token : undefined;
    } else {
      const secret = secretOrOpts ?? undefined;
      this.secret = secret && secret.length > 0 ? secret : undefined;
      const token = process.env.ORC_DAEMON_TOKEN;
      this.token = token && token.length > 0 ? token : undefined;
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    // Prefer bearer token when set; still send legacy secret if also configured
    // (server accepts either; identity path needs neither).
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    if (this.secret) h['x-orc-secret'] = this.secret;
    return h;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await globalThis.fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`request to ${this.host} failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const msg =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new Error(`${this.host}: ${msg}`);
    }
    return data;
  }

  private get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }
  private post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body ?? {});
  }

  async health(): Promise<{ ok: boolean; version: string; host: string; api?: number }> {
    return this.get('/health') as Promise<{ ok: boolean; version: string; host: string; api?: number }>;
  }

  async whoami(): Promise<{
    host: string;
    peerAllowed: boolean;
    identity: unknown;
    principal?: { kind: string; node?: string; scopes: string[] };
  }> {
    return this.get('/whoami') as Promise<{
      host: string;
      peerAllowed: boolean;
      identity: unknown;
      principal?: { kind: string; node?: string; scopes: string[] };
    }>;
  }

  async listSessions(filter?: {
    workspace?: string;
    all?: boolean;
    dead?: boolean;
  }): Promise<RemoteSessionView[]> {
    const q = new URLSearchParams();
    if (filter?.workspace) q.set('workspace', filter.workspace);
    if (filter?.all) q.set('all', '1');
    if (filter?.dead) q.set('dead', '1');
    const qs = q.toString();
    return this.get(`/sessions${qs ? `?${qs}` : ''}`) as Promise<RemoteSessionView[]>;
  }

  async spawn(body: Record<string, unknown>): Promise<SessionRecord> {
    return this.post('/sessions', body) as Promise<SessionRecord>;
  }

  async getSession(id: string): Promise<RemoteSessionView> {
    return this.get(`/sessions/${encodeURIComponent(id)}`) as Promise<RemoteSessionView>;
  }

  async send(
    id: string,
    prompt: string,
    opts?: { messageId?: string; wake?: boolean },
  ): Promise<RemoteSendResult> {
    const body: Record<string, unknown> = { prompt };
    if (opts?.messageId) body.messageId = opts.messageId;
    if (opts?.wake === false) body.wake = false;
    return this.post(`/sessions/${encodeURIComponent(id)}/send`, body) as Promise<RemoteSendResult>;
  }

  async wait(id: string, body: { for?: string; timeoutMs?: number }): Promise<WaitResult> {
    return this.post(`/sessions/${encodeURIComponent(id)}/wait`, body) as Promise<WaitResult>;
  }

  async read(id: string, opts?: { raw?: boolean; selection?: TurnSelection }): Promise<ReadResult> {
    const q = new URLSearchParams();
    if (opts?.raw) {
      q.set('raw', '1');
    } else if (opts?.selection?.mode === 'full') {
      q.set('full', '1');
    } else if (opts?.selection?.mode === 'index') {
      q.set('index', String(opts.selection.index));
    }
    const qs = q.toString();
    return this.get(
      `/sessions/${encodeURIComponent(id)}/read${qs ? `?${qs}` : ''}`,
    ) as Promise<ReadResult>;
  }

  async kill(
    id: string,
    body: { worktree?: boolean; purge?: boolean },
  ): Promise<{ ok: boolean; id: string; purged: boolean }> {
    return this.post(`/sessions/${encodeURIComponent(id)}/kill`, body) as Promise<{
      ok: boolean;
      id: string;
      purged: boolean;
    }>;
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return this.get('/workflows/runs') as Promise<WorkflowRun[]>;
  }

  async getRun(id: string): Promise<WorkflowRun> {
    return this.get(`/workflows/runs/${encodeURIComponent(id)}`) as Promise<WorkflowRun>;
  }

  async runLogs(id: string, opts?: { step?: string; raw?: boolean }): Promise<LogsResult> {
    const q = new URLSearchParams();
    if (opts?.step) q.set('step', opts.step);
    if (opts?.raw) q.set('raw', '1');
    const qs = q.toString();
    return this.get(
      `/workflows/runs/${encodeURIComponent(id)}/logs${qs ? `?${qs}` : ''}`,
    ) as Promise<LogsResult>;
  }

  async runWorkflow(body: {
    file?: string;
    def?: unknown;
    detach?: boolean;
    /** Positive integer; omit for workflow default (1). */
    maxConcurrency?: number;
  }): Promise<WorkflowRun | DetachedWorkflowLaunch> {
    return this.post('/workflows/run', body) as Promise<WorkflowRun | DetachedWorkflowLaunch>;
  }

  async resumeWorkflow(
    id: string,
    body?: { file?: string; detach?: boolean },
  ): Promise<WorkflowRun | DetachedWorkflowLaunch> {
    return this.post(`/workflows/runs/${encodeURIComponent(id)}/resume`, body ?? {}) as Promise<
      WorkflowRun | DetachedWorkflowLaunch
    >;
  }

  async retryWorkflow(
    id: string,
    body?: { file?: string; step?: string; stepId?: string; detach?: boolean },
  ): Promise<WorkflowRun | DetachedWorkflowLaunch> {
    return this.post(`/workflows/runs/${encodeURIComponent(id)}/retry`, body ?? {}) as Promise<
      WorkflowRun | DetachedWorkflowLaunch
    >;
  }

  async cancelWorkflow(
    id: string,
    body?: { cascade?: boolean },
  ): Promise<WorkflowRun> {
    return this.post(`/workflows/runs/${encodeURIComponent(id)}/cancel`, body ?? {}) as Promise<WorkflowRun>;
  }

  async cleanupWorkflow(
    id: string,
    body?: { sessions?: boolean; worktrees?: boolean },
  ): Promise<{ runId: string; sessions: string[]; worktrees: string[] }> {
    return this.post(
      `/workflows/runs/${encodeURIComponent(id)}/cleanup`,
      body ?? {},
    ) as Promise<{ runId: string; sessions: string[]; worktrees: string[] }>;
  }
}
