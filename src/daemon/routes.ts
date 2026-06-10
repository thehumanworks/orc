/**
 * The daemon's route table and request→SDK-arg mapping — PURE, so the routing and the
 * argument translation can be unit-tested without a live socket. The handlers in
 * `server.ts` switch on the `RouteName` this returns and call the matching SDK function.
 */
import type { AgentOptions, Provider, SystemPromptMode } from '../types.ts';
import type { WaitForOptions } from '../session.ts';
import { resolveUntil } from '../state.ts';

export type RouteName =
  | 'health'
  | 'whoami'
  | 'sessions.list'
  | 'sessions.spawn'
  | 'sessions.get'
  | 'sessions.send'
  | 'sessions.wait'
  | 'sessions.read'
  | 'sessions.kill'
  | 'workflows.runs.list'
  | 'workflows.run'
  | 'workflows.runs.get'
  | 'workflows.runs.logs';

interface Route {
  method: 'GET' | 'POST';
  /** Pattern segments; a `:name` segment captures a param. */
  pattern: string;
  name: RouteName;
}

/**
 * Ordered most-specific-first. Segment-count disambiguates most overlaps, but order still
 * matters where a literal and a `:id` share a length (e.g. `/workflows/runs` must precede
 * `/workflows/runs/:id`, and `/sessions/:id/send` must precede `/sessions/:id`).
 */
const ROUTES: Route[] = [
  { method: 'GET', pattern: '/health', name: 'health' },
  { method: 'GET', pattern: '/whoami', name: 'whoami' },
  { method: 'GET', pattern: '/sessions', name: 'sessions.list' },
  { method: 'POST', pattern: '/sessions', name: 'sessions.spawn' },
  { method: 'GET', pattern: '/workflows/runs', name: 'workflows.runs.list' },
  { method: 'POST', pattern: '/workflows/run', name: 'workflows.run' },
  { method: 'GET', pattern: '/workflows/runs/:id/logs', name: 'workflows.runs.logs' },
  { method: 'GET', pattern: '/workflows/runs/:id', name: 'workflows.runs.get' },
  { method: 'POST', pattern: '/sessions/:id/send', name: 'sessions.send' },
  { method: 'POST', pattern: '/sessions/:id/wait', name: 'sessions.wait' },
  { method: 'GET', pattern: '/sessions/:id/read', name: 'sessions.read' },
  { method: 'POST', pattern: '/sessions/:id/kill', name: 'sessions.kill' },
  { method: 'GET', pattern: '/sessions/:id', name: 'sessions.get' },
];

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Match a method + pathname (no query string) against the route table. Returns the route
 * name + captured `:id` params, or null when nothing matches (→ the server replies 404).
 * Pure + synchronous.
 */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  const reqSegs = splitPath(pathname);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patSegs = splitPath(route.pattern);
    if (patSegs.length !== reqSegs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      const p = patSegs[i]!;
      const r = reqSegs[i]!;
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(r);
      } else if (p !== r) {
        ok = false;
        break;
      }
    }
    if (ok) return { name: route.name, params };
  }
  return null;
}

/** The body shape `POST /sessions` accepts (mirrors `orc spawn` flags). */
export interface SpawnRequest {
  provider?: string;
  model?: string;
  agent?: string;
  alias?: string;
  systemPrompt?: string;
  systemPromptMode?: string;
  prompt?: string;
  cwd?: string;
  workspace?: string;
  worktree?: boolean | { branch?: string };
  branch?: string;
  /** `orc spawn --no-wait`: skip the boot wait AND the initial-prompt send. */
  noWait?: boolean;
}

/**
 * PURE map of a `POST /sessions` JSON body to `AgentOptions` for the SDK `agent()`. Mirrors
 * the validation `cmdSpawn` does up front (provider required + valid, system-prompt-mode
 * checked, agent/systemPrompt mutual-exclusion is left to `validateOptions` downstream).
 * Throws a clear Error on a bad request (the server turns it into a 400).
 */
export function mapSpawnRequest(body: SpawnRequest): AgentOptions {
  const provider = body.provider as Provider | undefined;
  if (!provider) throw new Error('provider is required (claude|codex|pi)');

  let mode: SystemPromptMode | undefined;
  if (body.systemPromptMode !== undefined) {
    if (body.systemPromptMode !== 'append' && body.systemPromptMode !== 'replace') {
      throw new Error(`invalid systemPromptMode '${body.systemPromptMode}' (append|replace)`);
    }
    mode = body.systemPromptMode;
  }

  // worktree: accept a boolean (+ optional top-level `branch`) or an object {branch}.
  let worktree: AgentOptions['worktree'];
  if (typeof body.worktree === 'object' && body.worktree !== null) {
    worktree = body.worktree.branch ? { branch: body.worktree.branch } : true;
  } else if (body.worktree) {
    worktree = body.branch ? { branch: body.branch } : true;
  }

  return {
    provider,
    model: body.model,
    agentName: body.agent,
    alias: body.alias,
    systemPrompt: body.systemPrompt,
    systemPromptMode: mode,
    prompt: body.prompt,
    cwd: body.cwd,
    workspace: body.workspace,
    worktree,
    ...(body.noWait ? { waitForReady: false } : {}),
  };
}

/** The body shape `POST /sessions/:id/wait` accepts. */
export interface WaitRequest {
  for?: string;
  timeoutMs?: number;
}

/**
 * PURE map of a `POST /sessions/:id/wait` body to `WaitForOptions`. `for` reuses the CLI's
 * `resolveUntil` so the daemon and CLI agree on the state sets. Throws on an invalid `for`.
 */
export function mapWaitRequest(body: WaitRequest): WaitForOptions {
  const forArg = body.for ?? 'settled';
  const until = resolveUntil(forArg);
  if (!until) throw new Error(`invalid for '${forArg}' (done|waiting|failed|settled)`);
  const opts: WaitForOptions = { until };
  if (body.timeoutMs !== undefined) {
    const ms = Number(body.timeoutMs);
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid timeoutMs '${body.timeoutMs}'`);
    opts.timeoutMs = ms;
  }
  return opts;
}
