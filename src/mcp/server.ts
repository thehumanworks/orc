/**
 * The orc MCP server: one McpServer with the lead-agent instructions, the orc tools for a
 * mode (filtered by the caller's daemon scopes), the playbook as a resource and an
 * `orchestrate` prompt. Built fresh per stdio connection (`orc mcp`) or per HTTP request
 * (the daemon's `/mcp`, stateless).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { scopeGrants } from '../daemon/auth.ts';
import type { Scope } from '../daemon/auth.ts';
import { VERSION } from '../version.ts';
import { createCliRunner } from './exec.ts';
import type { CliRunner } from './exec.ts';
import { guideText } from './guide.ts';
import { orcInstructions } from './instructions.ts';
import { errorResult } from './shape.ts';
import type { ToolResult } from './shape.ts';
import { toolsForMode } from './tools.ts';
import type { McpMode, OrcTool, ToolEnv } from './tools.ts';

/** `wait`'s default bound (seconds): under the ~60 s tool-call timeouts of common MCP clients. */
export const DEFAULT_WAIT_TIMEOUT_SEC = 45;

export interface OrcMcpServerOptions {
  mode: McpMode;
  /** Daemon mode: the caller's scopes. Tools it lacks the scope for are not registered. */
  scopes?: readonly Scope[];
  /**
   * Daemon mode: the tool a `tools/call` request names. When the caller lacks its scope it
   * is registered anyway, as a refusal, so the call gets a clear error result — it can
   * never show up in a `tools/list` (that request names no tool).
   */
  callName?: string;
  /** `wait`'s default timeout in seconds (default 45). */
  waitTimeoutSec?: number;
  /** How the tools run the CLI (default: this orc build as a child process). */
  runner?: CliRunner;
  /** Base env of the CLI children (default: process.env; daemon credentials are stripped). */
  env?: Record<string, string | undefined>;
  /** The CLI children's default working directory (default: process.cwd()). */
  cwd?: string;
}

/** May a caller with `scopes` call `tool`? (stdio: always; daemon: the tool's scope.) */
export function toolAllowed(tool: OrcTool, mode: McpMode, scopes: readonly Scope[] | undefined): boolean {
  if (mode === 'stdio' || tool.scope === null) return true;
  return scopeGrants(scopes ?? [], tool.scope);
}

/** The tools a caller sees in `tools/list`. */
export function visibleTools(mode: McpMode, scopes?: readonly Scope[]): OrcTool[] {
  return toolsForMode(mode).filter((t) => toolAllowed(t, mode, scopes));
}

function refusal(tool: OrcTool): ToolResult {
  return errorResult(
    `forbidden: '${tool.name}' needs the daemon scope '${tool.scope}', which this caller lacks`,
    'the tools you may call are the ones tools/list shows; ask the user for a token with that scope.',
  );
}

export function createOrcMcpServer(opts: OrcMcpServerOptions): McpServer {
  const env: ToolEnv = {
    mode: opts.mode,
    waitTimeoutSec: opts.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC,
    run: opts.runner ?? createCliRunner(),
    env: opts.env ?? process.env,
    cwd: opts.cwd ?? process.cwd(),
  };
  const server = new McpServer(
    { name: 'orc', title: 'orc — multi-agent orchestration', version: VERSION },
    { instructions: orcInstructions(opts.mode) },
  );

  for (const tool of toolsForMode(opts.mode)) {
    const allowed = toolAllowed(tool, opts.mode, opts.scopes);
    if (!allowed && tool.name !== opts.callName) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description(env),
        inputSchema: tool.schema(env),
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>, ctx): Promise<ToolResult> => {
        if (!allowed) return refusal(tool);
        try {
          return await tool.run(args, { env, signal: ctx.mcpReq.signal });
        } catch (e) {
          return errorResult(`${tool.name} failed: ${(e as Error).message}`);
        }
      },
    );
  }

  server.registerResource(
    'guide',
    'orc://guide',
    {
      title: "The orc lead's playbook",
      description: 'How to lead a team of coding agents with the orc tools (the same text as the guide tool).',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guideText() }] }),
  );

  server.registerPrompt(
    'orchestrate',
    {
      title: 'Lead a team of agents on a task',
      description: 'Start a lead session: the orc team method plus your task.',
      argsSchema: z.object({ task: z.string().describe('what the team should deliver') }),
    },
    ({ task }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `${orcInstructions(opts.mode)}\n\nCall the guide tool first, write down the slices and their teams, then lead them to done.\n\nTask:\n${task}`,
          },
        },
      ],
    }),
  );

  return server;
}
