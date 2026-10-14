/**
 * Minimal JSON-RPC 2.0 client for `codex app-server` (stdio JSONL; no `"jsonrpc"` field on
 * the wire). Transport-agnostic: the owner feeds every stdout line to `handleLine()` and
 * supplies `write()` for stdin, so the protocol layer is unit-testable without a process.
 *
 * - Client requests get numeric ids from a private counter and a pending-promise entry
 *   with a mandatory timeout (a timeout always settles the request — nothing hangs).
 * - `onSettled` runs SYNCHRONOUSLY while the response line is dispatched, before any later
 *   line is processed. Callers that must observe a response before the notifications that
 *   follow it on the wire (codex sends the `turn/start` response before `turn/started`)
 *   use it instead of awaiting the promise (whose continuation runs a microtask later).
 * - Server→client requests are handed to `onServerRequest`, which must answer them with
 *   `respond()` / `respondError()`.
 */
import type { RequestId, RpcErrorObject, RpcRequest } from './codex-protocol.ts';

/** The server answered a request with a JSON-RPC error object. */
export class RpcError extends Error {
  readonly code: number;
  readonly method: string;
  readonly data: unknown;
  constructor(method: string, err: RpcErrorObject) {
    super(err.message);
    this.name = 'RpcError';
    this.method = method;
    this.code = err.code;
    this.data = err.data;
  }
}

/** No response arrived within the request's timeout. */
export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`codex ${method} timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** The connection closed (provider exited / stdin unwritable) before a response arrived. */
export class RpcClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcClosedError';
  }
}

export type RpcOutcome<R> = { ok: true; result: R } | { ok: false; error: Error };

export interface RequestOptions<R> {
  timeoutMs: number;
  /** Synchronous settle hook (see file header). Exceptions thrown here are swallowed. */
  onSettled?: (outcome: RpcOutcome<R>) => void;
}

export interface RpcClientOptions {
  /** Write one serialized message (no trailing newline). May throw when the pipe is gone. */
  write: (line: string) => void;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (req: RpcRequest) => void;
  /** A line that is not valid JSON-RPC, or a response for an unknown/expired id. */
  onStray?: (line: string, why: string) => void;
}

interface Pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: RpcOutcome<unknown>) => void;
}

export class JsonRpcClient {
  private nextId = 0;
  private readonly pending = new Map<RequestId, Pending>();
  private closedError: Error | null = null;

  constructor(private readonly opts: RpcClientOptions) {}

  get closed(): boolean {
    return this.closedError !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<R>(method: string, params: unknown, ropts: RequestOptions<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      let done = false;
      const settle = (outcome: RpcOutcome<unknown>): void => {
        if (done) return;
        done = true;
        try {
          ropts.onSettled?.(outcome as RpcOutcome<R>);
        } catch {
          /* a settle hook must never break dispatch */
        }
        if (outcome.ok) resolve(outcome.result as R);
        else reject(outcome.error);
      };
      if (this.closedError) {
        settle({ ok: false, error: new RpcClosedError(`${this.closedError.message} (before ${method})`) });
        return;
      }
      const id = this.nextId++;
      const msg = params === undefined ? { method, id } : { method, id, params };
      const timer = setTimeout(() => {
        if (this.pending.get(id)?.timer !== timer) return;
        this.pending.delete(id);
        settle({ ok: false, error: new RpcTimeoutError(method, ropts.timeoutMs) });
      }, ropts.timeoutMs);
      this.pending.set(id, { method, timer, settle });
      try {
        this.opts.write(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        settle({
          ok: false,
          error: new RpcClosedError(`codex ${method}: write failed: ${(e as Error).message ?? String(e)}`),
        });
      }
    });
  }

  /** Fire-and-forget client notification. Returns false when it could not be written. */
  notify(method: string, params?: unknown): boolean {
    if (this.closedError) return false;
    try {
      this.opts.write(JSON.stringify(params === undefined ? { method } : { method, params }));
      return true;
    } catch {
      return false;
    }
  }

  respond(id: RequestId, result: unknown): boolean {
    return this.writeQuiet({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): boolean {
    return this.writeQuiet({ id, error: { code, message } });
  }

  /** Dispatch one stdout line. Never throws. */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.opts.onStray?.(line, 'not JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.opts.onStray?.(line, 'not an object');
      return;
    }
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (typeof m.method === 'string') {
      try {
        if (hasId) this.opts.onServerRequest({ method: m.method, id: m.id as RequestId, params: m.params });
        else this.opts.onNotification(m.method, m.params);
      } catch {
        /* handler bugs must not kill the reader */
      }
      return;
    }
    if (hasId) {
      const p = this.pending.get(m.id as RequestId);
      if (!p) {
        this.opts.onStray?.(line, 'response for unknown or expired id');
        return;
      }
      this.pending.delete(m.id as RequestId);
      clearTimeout(p.timer);
      if (m.error && typeof m.error === 'object') {
        const e = m.error as Partial<RpcErrorObject>;
        p.settle({
          ok: false,
          error: new RpcError(p.method, {
            code: typeof e.code === 'number' ? e.code : -32603,
            message: typeof e.message === 'string' ? e.message : JSON.stringify(m.error),
            data: e.data,
          }),
        });
      } else {
        p.settle({ ok: true, result: m.result });
      }
      return;
    }
    this.opts.onStray?.(line, 'neither request, notification nor response');
  }

  /** Reject every pending request and refuse new ones. Idempotent. */
  close(reason: Error): void {
    if (this.closedError) return;
    this.closedError = reason;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      p.settle({ ok: false, error: new RpcClosedError(`${reason.message} (during ${p.method})`) });
    }
  }

  private writeQuiet(msg: unknown): boolean {
    if (this.closedError) return false;
    try {
      this.opts.write(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}
