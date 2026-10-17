/**
 * `orc mcp`: serve the orc tools to a lead agent over MCP stdio. stdout is the protocol
 * channel, so every library's console output goes to stderr. Each connection gets one
 * server (all tools, no scopes: the lead runs as the user who started `orc mcp`); the SDK
 * negotiates the protocol era (2026-07-28 `server/discover`, or a 2025 `initialize`).
 *
 * A client may send its last request and close stdin at once. The SDK's stdio transport
 * would then abort whatever is in flight, so stdin reaches the transport through a pipe this
 * module ends only once every request read so far has been answered (bounded by a grace
 * period, or until stdout goes away).
 */
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/server';

export interface McpStdioOptions {
  /** `wait`'s default timeout in seconds. */
  waitTimeoutSec: number;
}

/** Keep stdout protocol-only: console.log/info/debug/warn → stderr. */
export function routeConsoleToStderr(): void {
  const toStderr = (...a: unknown[]): void => {
    process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : Bun.inspect(x))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

/** Requests received but not yet answered (keyed by JSON-RPC id). */
export class InFlightRequests {
  private readonly pending = new Map<string, number>();
  private waiters: Array<() => void> = [];

  private static key(id: unknown): string {
    return `${typeof id}:${String(id)}`;
  }

  get size(): number {
    return this.pending.size;
  }

  /** An inbound message: a request (method + id) starts being in flight. */
  received(msg: unknown): void {
    const m = msg as { method?: unknown; id?: unknown };
    if (typeof m?.method !== 'string' || m.id === undefined || m.id === null) return;
    const k = InFlightRequests.key(m.id);
    this.pending.set(k, (this.pending.get(k) ?? 0) + 1);
  }

  /** An outbound message: a response (result or error for an id) ends it. */
  answered(msg: unknown): void {
    const m = msg as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
    if (m?.method !== undefined || m?.id === undefined || (!('result' in m) && !('error' in m))) return;
    const k = InFlightRequests.key(m.id);
    const n = (this.pending.get(k) ?? 0) - 1;
    if (n > 0) this.pending.set(k, n);
    else this.pending.delete(k);
    if (this.pending.size === 0) {
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w();
    }
  }

  /** Resolves once nothing is in flight. */
  idle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** `inner`, with every request/response pair it carries counted in `inflight`. */
export function countingTransport(inner: Transport, inflight: InFlightRequests): Transport {
  let onmessage: Transport['onmessage'];
  const t: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
      try {
        await inner.send(message, options);
      } finally {
        inflight.answered(message);
      }
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
      inner.onmessage = handler
        ? (message, extra) => {
            inflight.received(message);
            handler(message, extra);
          }
        : undefined;
    },
    get onclose() {
      return inner.onclose;
    },
    set onclose(handler) {
      inner.onclose = handler;
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(handler) {
      inner.onerror = handler;
    },
  };
  return t;
}

/** Serve until the client closes stdin and everything read has been answered; resolves with the exit code. */
export async function runMcpStdio(opts: McpStdioOptions): Promise<number> {
  routeConsoleToStderr();
  const stdinEnded = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  const stdoutGone = new Promise<void>((resolve) => {
    process.stdout.once('error', () => resolve());
    process.stdout.once('close', () => resolve());
  });
  const [{ serveStdio, StdioServerTransport }, { createOrcMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'),
    import('./server.ts'),
  ]);
  // stdin → a pipe we end ourselves, so the transport never sees EOF while requests run.
  const input = new PassThrough();
  process.stdin.pipe(input, { end: false });
  const inflight = new InFlightRequests();
  const transport = countingTransport(new StdioServerTransport(input, process.stdout), inflight);
  const handle = serveStdio(() => createOrcMcpServer({ mode: 'stdio', waitTimeoutSec: opts.waitTimeoutSec }), {
    transport,
    onerror: (e) => {
      process.stderr.write(`orc mcp: ${e.message}\n`);
    },
  });
  await stdinEnded;
  // Let the bytes already read reach the transport, then answer what is in flight. Bounded:
  // a wait call may hold its answer for up to its timeout.
  await Bun.sleep(50);
  const graceMs = (opts.waitTimeoutSec + 15) * 1000;
  await Promise.race([inflight.idle(), stdoutGone, Bun.sleep(graceMs)]);
  input.end();
  await handle.close().catch(() => {});
  return 0;
}
