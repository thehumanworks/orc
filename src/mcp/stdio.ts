/**
 * `orc mcp`: serve the orc tools to a lead agent over MCP stdio. stdout is the protocol
 * channel, so every library's console output goes to stderr. Each connection gets one
 * server (all tools, no scopes: the lead runs as the user who started `orc mcp`); the SDK
 * negotiates the protocol era (2026-07-28 `server/discover`, or a 2025 `initialize`).
 */

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

/** Serve until the client closes stdin; resolves with the exit code. */
export async function runMcpStdio(opts: McpStdioOptions): Promise<number> {
  routeConsoleToStderr();
  const ended = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  const [{ serveStdio }, { createOrcMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'),
    import('./server.ts'),
  ]);
  const handle = serveStdio(() => createOrcMcpServer({ mode: 'stdio', waitTimeoutSec: opts.waitTimeoutSec }), {
    onerror: (e) => {
      process.stderr.write(`orc mcp: ${e.message}\n`);
    },
  });
  await ended;
  await handle.close().catch(() => {});
  return 0;
}
