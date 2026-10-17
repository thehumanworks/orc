/**
 * The daemon's `/mcp` endpoint: MCP Streamable HTTP over the same tools as `orc mcp`, run
 * on the daemon host (`orc --local …`). Loaded lazily by src/daemon/server.ts on the first
 * `/mcp` request, so no other orc command pays for the MCP SDK.
 *
 * Request path: Host/Origin guard (DNS rebinding; 403) → the daemon's own authentication
 * (401; done by the caller) → the stateless SDK handler, which builds one server per
 * request holding only the tools the caller's scopes allow.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { effectiveScopes } from '../daemon/auth.ts';
import type { Principal, Scope } from '../daemon/auth.ts';
import { createCliRunner } from './exec.ts';
import { forbiddenMcpResponse, hostRejection, originRejection } from './hosts.ts';
import { createOrcMcpServer } from './server.ts';

/** POST bodies larger than this are refused (413) before anything is parsed (the SDK's default bound). */
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

export interface DaemonMcpOptions {
  /** Host names (no port) accepted in `Host`, and in `Origin` when a browser sends one. */
  allowedHosts: readonly string[];
  /** `wait`'s default timeout in seconds (default 45). */
  waitTimeoutSec?: number;
  /** argv prefix of the orc CLI the tools run (default: this build). */
  cliArgv?: readonly string[];
  /** Base env of the CLI children (default: the daemon's; daemon credentials are stripped). */
  env?: Record<string, string | undefined>;
  /** Out-of-band SDK errors (reporting only). */
  onerror?: (error: Error) => void;
}

export interface DaemonMcp {
  /** The DNS-rebinding guard: a 403 response, or undefined when the request may proceed. */
  guard(req: Request): Response | undefined;
  /** Serve an authenticated request as `principal`. */
  serve(req: Request, principal: Principal): Promise<Response>;
  close(): Promise<void>;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The body, or null when it is larger than `max` bytes. */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The tool a single `tools/call` request names (batches and other methods: undefined). */
export function toolCallName(body: Uint8Array): string | undefined {
  try {
    const msg = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return undefined;
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    return m.method === 'tools/call' && typeof m.params?.name === 'string' ? m.params.name : undefined;
  } catch {
    return undefined;
  }
}

function principalLabel(p: Principal): string {
  return p.kind === 'identity' ? `identity:${p.node}` : p.kind;
}

export function createDaemonMcp(opts: DaemonMcpOptions): DaemonMcp {
  const allowed = [...opts.allowedHosts];
  const runner = createCliRunner(opts.cliArgv);
  const handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra;
      return createOrcMcpServer({
        mode: 'daemon',
        scopes: (ctx.authInfo?.scopes ?? []) as Scope[],
        callName: typeof extra?.toolCall === 'string' ? extra.toolCall : undefined,
        waitTimeoutSec: opts.waitTimeoutSec,
        runner,
        env: opts.env,
      });
    },
    { onerror: opts.onerror },
  );
  return {
    guard(req) {
      const host = hostRejection(req.headers.get('host'), allowed);
      if (host) return forbiddenMcpResponse(host);
      const origin = originRejection(req.headers.get('origin'), allowed);
      return origin ? forbiddenMcpResponse(origin) : undefined;
    },
    async serve(req, principal) {
      let forward = req;
      let toolCall: string | undefined;
      if (req.method === 'POST') {
        const body = await readBody(req, MAX_MCP_BODY_BYTES);
        if (body === null) return jsonRpcError(413, -32600, `request body larger than ${MAX_MCP_BODY_BYTES} bytes`);
        toolCall = toolCallName(body);
        forward = new Request(req.url, { method: 'POST', headers: req.headers, body });
      }
      // authInfo is ours, never derived from headers by the SDK: the scopes decide which
      // tools this request's server holds. No credential is passed on.
      return handler.fetch(forward, {
        authInfo: {
          token: 'orc-daemon',
          clientId: principalLabel(principal),
          scopes: effectiveScopes(principal.scopes),
          extra: { toolCall },
        },
      });
    },
    close: () => handler.close(),
  };
}
