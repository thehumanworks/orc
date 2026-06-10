/**
 * The HTTP client behind `orc --host <h> <command>` and `orc list --all-hosts`. A thin
 * 1:1 wrapper over the daemon's JSON API: each method makes one request and returns the
 * parsed body. The CLI feeds the results to the SAME renderers as the local path, so the
 * `--host` output is identical to local (`--json` byte-for-byte).
 */
import type { SessionRecord } from '../types.ts';
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

/** Read shape of `GET /sessions/:id/read` (discriminated; the CLI renders each kind). */
export type ReadResult =
  | { kind: 'parsed'; id: string; turns: Turn[] }
  | { kind: 'fallback'; id: string; pane: string }
  | { kind: 'raw'; id: string; pane: string };

export type LogsResult =
  | { kind: 'parsed'; logs: { step: string; provider: string; turns: Turn[] }[] }
  | { kind: 'raw'; logs: { step: string; provider: string; pane: string }[] };

export interface WaitResult {
  id: string;
  state: string;
  elapsedMs: number;
  timedOut: boolean;
}

export class DaemonClient {
  readonly base: string;
  readonly host: string;
  private readonly secret?: string;

  constructor(target: RemoteTarget, secret = process.env.ORC_DAEMON_SECRET) {
    this.host = target.host;
    this.base = `http://${target.host}:${target.port}`;
    this.secret = secret && secret.length > 0 ? secret : undefined;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
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

  async health(): Promise<{ ok: boolean; version: string; host: string }> {
    return this.get('/health') as Promise<{ ok: boolean; version: string; host: string }>;
  }

  async whoami(): Promise<{ host: string; peerAllowed: boolean; identity: unknown }> {
    return this.get('/whoami') as Promise<{ host: string; peerAllowed: boolean; identity: unknown }>;
  }

  async listSessions(filter?: {
    workspace?: string;
    all?: boolean;
    dead?: boolean;
  }): Promise<(SessionRecord & { status?: 'running' | 'dead' })[]> {
    const q = new URLSearchParams();
    if (filter?.workspace) q.set('workspace', filter.workspace);
    if (filter?.all) q.set('all', '1');
    if (filter?.dead) q.set('dead', '1');
    const qs = q.toString();
    return this.get(`/sessions${qs ? `?${qs}` : ''}`) as Promise<
      (SessionRecord & { status?: 'running' | 'dead' })[]
    >;
  }

  async spawn(body: Record<string, unknown>): Promise<SessionRecord> {
    return this.post('/sessions', body) as Promise<SessionRecord>;
  }

  async getSession(
    id: string,
  ): Promise<SessionRecord & { status?: 'running' | 'dead'; state?: string }> {
    return this.get(`/sessions/${encodeURIComponent(id)}`) as Promise<
      SessionRecord & { status?: 'running' | 'dead'; state?: string }
    >;
  }

  async send(id: string, prompt: string): Promise<{ ok: boolean; id: string }> {
    return this.post(`/sessions/${encodeURIComponent(id)}/send`, { prompt }) as Promise<{
      ok: boolean;
      id: string;
    }>;
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
  }): Promise<WorkflowRun | { runId: string; runnerTmux: string }> {
    return this.post('/workflows/run', body) as Promise<
      WorkflowRun | { runId: string; runnerTmux: string }
    >;
  }
}
