/**
 * The orc MCP layer, without an MCP transport: the tool registry (names, schemas,
 * annotations, modes, scopes), the CLI argv each tool builds (no shell; --local / --host;
 * forced --no-wait / --detach / --json / --no-color), result and error mapping, the
 * multi-id wait, output bounds, the instructions/description length limits and the guide,
 * the /mcp Host/Origin guard, and the CLI child runner.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_MAX_CHARS,
  EXCLUDED_COMMANDS,
  MAX_WAIT_IDS,
  TOOLS,
  orcArgs,
  toolsForMode,
} from '../src/mcp/tools.ts';
import type { McpMode, OrcTool, ToolEnv } from '../src/mcp/tools.ts';
import { INSTRUCTIONS_MAX_CHARS, orcInstructions } from '../src/mcp/instructions.ts';
import { GUIDE_SECTIONS, guideText, guideTopic } from '../src/mcp/guide.ts';
import { toolAllowed, visibleTools } from '../src/mcp/server.ts';
import { ChildLimiter, childEnv, createCliRunner, parseCliJson, SHARED_CHILD_LIMITER, STRIPPED_ENV_KEYS } from '../src/mcp/exec.ts';
import { MAX_CLI_CHILDREN } from '../src/mcp/limits.ts';
import { InFlightRequests } from '../src/mcp/stdio.ts';
import type { CliCall, CliResult, CliRunner } from '../src/mcp/exec.ts';
import { cliFailure, defaultHostRoute, tailWindow } from '../src/mcp/shape.ts';
import type { ToolResult } from '../src/mcp/shape.ts';
import {
  hostRejection,
  mcpAllowedHosts,
  normalizeAllowedHost,
  originRejection,
} from '../src/mcp/hosts.ts';
import { toolCallName } from '../src/mcp/http.ts';
import { parseStatusSelf } from '../src/daemon/tailscale.ts';
import type { Scope } from '../src/daemon/auth.ts';

const ALL_TOOL_NAMES = [
  'guide',
  'spawn',
  'send',
  'wait',
  'read',
  'state',
  'list',
  'kill',
  'resume',
  'prune',
  'settings',
  'workflow_run',
  'workflow_list',
  'workflow_status',
  'workflow_logs',
  'workflow_resume',
  'workflow_retry',
  'workflow_cancel',
  'workflow_cleanup',
];

const REMOTE_TOOLS = [
  'spawn',
  'send',
  'wait',
  'read',
  'state',
  'list',
  'kill',
  'workflow_run',
  'workflow_list',
  'workflow_status',
  'workflow_logs',
  'workflow_cancel',
  'workflow_cleanup',
];

/** Each tool's daemon scope: the scope of the matching REST route (null: any caller). */
const EXPECTED_SCOPES: Record<string, Scope | null> = {
  guide: null,
  spawn: 'sessions:write',
  send: 'sessions:write',
  resume: 'sessions:write',
  wait: 'sessions:read',
  read: 'sessions:read',
  state: 'sessions:read',
  list: 'sessions:read',
  settings: 'sessions:read',
  kill: 'admin',
  prune: 'admin',
  workflow_run: 'workflows:write',
  workflow_resume: 'workflows:write',
  workflow_retry: 'workflows:write',
  workflow_list: 'workflows:read',
  workflow_status: 'workflows:read',
  workflow_logs: 'workflows:read',
  workflow_cancel: 'admin',
  workflow_cleanup: 'admin',
};

const tool = (name: string): OrcTool => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const BASE_RESULT: CliResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  json: undefined,
  aborted: false,
  timedOut: false,
  overflow: false,
};

type Respond = (call: CliCall) => Partial<CliResult> | Promise<Partial<CliResult>>;

/** A CliRunner that records every call and answers with `respond`. */
function recorder(respond: Respond = () => ({ json: {} })): { calls: CliCall[]; run: CliRunner } {
  const calls: CliCall[] = [];
  return {
    calls,
    run: async (call) => {
      calls.push(call);
      return { ...BASE_RESULT, ...(await respond(call)) };
    },
  };
}

/** The server's directory: real, because directories a CLI child runs in must exist. */
const SERVER_CWD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-mcp-tools-')));
for (const d of ['sub', 'pkg', 'repo']) fs.mkdirSync(path.join(SERVER_CWD, d));
fs.writeFileSync(path.join(SERVER_CWD, 'a-file'), 'x');
afterAll(() => fs.rmSync(SERVER_CWD, { recursive: true, force: true }));
const BASE_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  ORC_HOME: '/home/u/.orc',
  ORC_DAEMON_SECRET: 'sekret',
  ORC_DAEMON_TOKENS: '{"t":["admin"]}',
  ORC_DAEMON_TOKEN: 'bearer-tok',
};

function toolEnv(mode: McpMode, run: CliRunner, waitTimeoutSec = 45): ToolEnv {
  return { mode, waitTimeoutSec, run, env: BASE_ENV, cwd: SERVER_CWD };
}

/** Validate `input` with the tool's schema (defaults applied) and run it. */
async function call(
  name: string,
  input: Record<string, unknown>,
  opts: { mode?: McpMode; run?: CliRunner; waitTimeoutSec?: number; signal?: AbortSignal } = {},
): Promise<ToolResult> {
  const t = tool(name);
  const env = toolEnv(opts.mode ?? 'stdio', opts.run ?? recorder().run, opts.waitTimeoutSec);
  const args = t.schema(env).parse(input) as Record<string, unknown>;
  return t.run(args, { env, signal: opts.signal ?? new AbortController().signal });
}

const text = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

describe('the tool registry', () => {
  test('stdio and daemon expose the same 19 tools, guide first', () => {
    expect(toolsForMode('stdio').map((t) => t.name)).toEqual(ALL_TOOL_NAMES);
    expect(toolsForMode('daemon').map((t) => t.name)).toEqual(ALL_TOOL_NAMES);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  test('no excluded command is a tool (attach, takeover, login/logout, daemon, remote, mcp, help)', () => {
    for (const cmd of EXCLUDED_COMMANDS) {
      expect(TOOLS.map((t) => t.name)).not.toContain(cmd.replace(' ', '_'));
    }
    expect(EXCLUDED_COMMANDS).toEqual(['attach', 'workflow attach', 'takeover', 'login', 'logout', 'daemon', 'remote', 'mcp', 'help']);
  });

  test('each tool needs the scope of its REST route in daemon mode', () => {
    expect(Object.fromEntries(TOOLS.map((t) => [t.name, t.scope]))).toEqual(EXPECTED_SCOPES);
  });

  test('host is offered on remote-capable tools in stdio mode only', () => {
    for (const t of TOOLS) {
      const stdio = Object.keys(t.schema({ mode: 'stdio', waitTimeoutSec: 45 }).shape);
      const daemon = Object.keys(t.schema({ mode: 'daemon', waitTimeoutSec: 45 }).shape);
      expect([t.name, stdio.includes('host')]).toEqual([t.name, REMOTE_TOOLS.includes(t.name)]);
      expect([t.name, daemon.includes('host')]).toEqual([t.name, false]);
      expect(t.remote).toBe(REMOTE_TOOLS.includes(t.name));
    }
  });

  test('annotations: read-only tools, destructive tools, and explicit hints everywhere else', () => {
    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ['guide', 'list', 'read', 'settings', 'state', 'wait', 'workflow_list', 'workflow_logs', 'workflow_status'].sort(),
    );
    const destructive = TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);
    expect(destructive.sort()).toEqual(['kill', 'prune', 'workflow_cancel', 'workflow_cleanup'].sort());
    const openWorld = TOOLS.filter((t) => t.annotations.openWorldHint === true).map((t) => t.name);
    expect(openWorld.sort()).toEqual(['resume', 'send', 'spawn', 'workflow_resume', 'workflow_retry', 'workflow_run'].sort());
    for (const t of TOOLS) {
      // MCP defaults destructiveHint to true for non-read-only tools: say it explicitly.
      if (t.annotations.readOnlyHint !== true) expect([t.name, typeof t.annotations.destructiveHint]).toEqual([t.name, 'boolean']);
      expect([t.name, typeof t.annotations.openWorldHint]).toEqual([t.name, 'boolean']);
    }
  });

  test('every input schema is a plain JSON object schema clients accept', () => {
    for (const mode of ['stdio', 'daemon'] as const) {
      for (const t of TOOLS) {
        const json = z.toJSONSchema(t.schema({ mode, waitTimeoutSec: 45 }), { io: 'input' }) as Record<string, unknown>;
        expect([t.name, json.type]).toEqual([t.name, 'object']);
        for (const k of ['anyOf', 'oneOf', 'allOf']) expect(json[k]).toBeUndefined();
        for (const prop of Object.keys((json.properties ?? {}) as object)) expect(prop).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      }
    }
  });

  test('unknown arguments are rejected (strict schemas, additionalProperties: false), in both modes', () => {
    for (const mode of ['stdio', 'daemon'] as const) {
      const cfg = { mode, waitTimeoutSec: 45 };
      for (const t of TOOLS) {
        const json = z.toJSONSchema(t.schema(cfg), { io: 'input' }) as Record<string, unknown>;
        expect([t.name, json.additionalProperties]).toEqual([t.name, false]);
        // A key no tool has is a validation error, never silently dropped.
        expect([t.name, t.schema(cfg).safeParse({ no_such_argument: 1 }).success]).toEqual([t.name, false]);
      }
      // camelCase spellings of real parameters: each would otherwise be ignored without a word.
      const bad: Array<[string, Record<string, unknown>]> = [
        ['send', { id: 'abc', prompt: 'x', idempotencyKey: 'k' }],
        ['wait', { ids: ['abc'], timeout: 1 }],
        ['wait', { ids: ['abc'], timeoutSeconds: 1 }],
        ['read', { id: 'abc', maxChars: 2_000 }],
        ['spawn', { provider: 'claude', cwd: '/x', systemPrompt: 'p' }],
        ['workflow_logs', { run_id: 'r', maxChars: 2_000 }],
        ['workflow_run', { file: '/w.ts', cwd: '/x', maxConcurrency: 2 }],
      ];
      for (const [name, args] of bad) {
        const r = tool(name).schema(cfg).safeParse(args);
        expect([name, Object.keys(args).join(','), r.success]).toEqual([name, Object.keys(args).join(','), false]);
        expect(r.error?.issues[0]?.message).toMatch(/Unrecognized key/);
      }
    }
  });

  test('daemon mode requires an absolute cwd for spawn and workflow_run in the schema', () => {
    const d = { mode: 'daemon' as const, waitTimeoutSec: 45 };
    expect(tool('spawn').schema(d).safeParse({ provider: 'claude' }).success).toBe(false);
    expect(tool('workflow_run').schema(d).safeParse({ file: '/w.ts' }).success).toBe(false);
    expect(tool('spawn').schema({ mode: 'stdio', waitTimeoutSec: 45 }).safeParse({}).success).toBe(true);
  });

  test('scope filtering: a caller sees only the tools its scopes allow', () => {
    const names = (scopes: Scope[]) => visibleTools('daemon', scopes).map((t) => t.name);
    expect(names([])).toEqual(['guide']);
    expect(names(['sessions:read'])).toEqual(['guide', 'wait', 'read', 'state', 'list', 'settings']);
    expect(names(['sessions:write'])).toEqual(['guide', 'spawn', 'send', 'resume']);
    expect(names(['workflows:read'])).toEqual(['guide', 'workflow_list', 'workflow_status', 'workflow_logs']);
    expect(names(['workflows:write'])).toEqual(['guide', 'workflow_run', 'workflow_resume', 'workflow_retry']);
    expect(names(['admin'])).toEqual(ALL_TOOL_NAMES);
    expect(visibleTools('stdio').map((t) => t.name)).toEqual(ALL_TOOL_NAMES);
    expect(toolAllowed(tool('kill'), 'stdio', [])).toBe(true);
    expect(toolAllowed(tool('kill'), 'daemon', ['sessions:write', 'sessions:read'])).toBe(false);
  });
});

describe('instructions, descriptions and the guide', () => {
  test(`instructions stay within ${INSTRUCTIONS_MAX_CHARS} characters in both modes`, () => {
    for (const mode of ['stdio', 'daemon'] as const) {
      expect(orcInstructions(mode).length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    }
  });

  test('instructions carry the loop, the team method and the pointers to guide and settings', () => {
    const s = orcInstructions('stdio');
    for (const needle of [
      'LEAD',
      "orchestrate, don't implement",
      'spawn',
      'wait',
      'read',
      'send',
      'not that it succeeded',
      'vertical slices',
      'context gatherer',
      'implementor',
      'judge',
      'different model or provider',
      'worktree: true',
      'in one call',
      'idempotency_key',
      'kill',
      'Never hand a session to a human',
      'guide',
      'settings',
    ]) {
      expect([needle, s.includes(needle)]).toEqual([needle, true]);
    }
    expect(orcInstructions('daemon')).toContain('absolute cwd');
  });

  test('instructions and guide are model-neutral (no model ids)', () => {
    const modelish = /\b(gpt-?\d|o\d-|haiku|sonnet|opus|gemini|claude-\d|llama|mistral)\b/i;
    expect(orcInstructions('stdio')).not.toMatch(modelish);
    expect(orcInstructions('daemon')).not.toMatch(modelish);
    expect(guideText()).not.toMatch(modelish);
  });

  test('every tool description fits in 1,500 characters, in both modes', () => {
    for (const mode of ['stdio', 'daemon'] as const) {
      for (const waitTimeoutSec of [45, 600]) {
        for (const t of TOOLS) {
          const d = t.description({ mode, waitTimeoutSec });
          expect([t.name, d.length <= 1_500]).toEqual([t.name, true]);
          expect(d.length).toBeGreaterThan(80);
        }
      }
    }
  });

  test('the guide mentions every tool and every excluded command, and serves topics', () => {
    const g = guideText();
    for (const t of TOOLS) expect([t.name, g.includes(`\`${t.name}\``)]).toEqual([t.name, true]);
    for (const cmd of EXCLUDED_COMMANDS) expect([cmd, g.includes(cmd)]).toEqual([cmd, true]);
    expect(g.length).toBeLessThan(40_000);
    const team = guideTopic('team');
    expect(team).toContain('## The team method');
    expect(team).toContain('Judge rubric');
    expect(guideTopic('FAILURES')).toContain('## Failure handling');
    expect(guideTopic('no-such-topic')).toBeNull();
    expect(GUIDE_SECTIONS.map((s) => s.slug)).toContain('excluded');
  });

  test('wait describes its default timeout from the server config', () => {
    expect(tool('wait').description({ mode: 'stdio', waitTimeoutSec: 30 })).toContain('default 30');
    const json = z.toJSONSchema(tool('wait').schema({ mode: 'stdio', waitTimeoutSec: 30 }), { io: 'input' }) as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(json.properties.timeout_seconds?.default).toBe(30);
  });
});

describe('argv building (array argv, never a shell)', () => {
  test('stdio: no --local; --host=<h> only when asked; --no-color and --json always', () => {
    expect(orcArgs('stdio', ['list'])).toEqual(['--no-color', 'list', '--json']);
    expect(orcArgs('stdio', ['list'], 'mini:8787')).toEqual(['--host=mini:8787', '--no-color', 'list', '--json']);
    expect(orcArgs('daemon', ['list'], 'ignored')).toEqual(['--local', '--no-color', 'list', '--json']);
  });

  test('spawn: forced --no-wait, prompt on stdin, values in --name=value form', async () => {
    const rec = recorder(() => ({ json: { id: 'abcd1234', provider: 'claude', cwd: '/w' } }));
    const r = await call(
      'spawn',
      { provider: 'claude', model: '--evil', prompt: 'do the thing\nline 2', alias: 'impl-a', worktree: true, branch: 'feat/x' },
      { run: rec.run },
    );
    expect(r.isError).toBeUndefined();
    expect(rec.calls).toHaveLength(1);
    const c = rec.calls[0]!;
    expect(c.args).toEqual([
      '--no-color',
      'spawn',
      '--provider=claude',
      '--model=--evil',
      '--alias=impl-a',
      '--prompt=-',
      '--worktree',
      '--branch=feat/x',
      '--no-wait',
      '--json',
    ]);
    expect(c.stdin).toBe('do the thing\nline 2');
    expect(c.cwd).toBe(SERVER_CWD);
    expect(text(r)).toContain('next: wait {"ids":["abcd1234"]}');
  });

  test('spawn in daemon mode: --local, absolute cwd required, the child runs in cwd', async () => {
    const repo = path.join(SERVER_CWD, 'repo');
    const rec = recorder(() => ({ json: { id: 'abcd1234', provider: 'pi', cwd: repo } }));
    const ok = await call('spawn', { provider: 'pi', cwd: repo }, { mode: 'daemon', run: rec.run });
    expect(ok.isError).toBeUndefined();
    expect(rec.calls[0]!.args).toEqual(['--local', '--no-color', 'spawn', '--provider=pi', `--cwd=${repo}`, '--no-wait', '--json']);
    expect(rec.calls[0]!.cwd).toBe(repo);
    const rel = await call('spawn', { provider: 'pi', cwd: 'repo' }, { mode: 'daemon', run: rec.run });
    expect(rel.isError).toBe(true);
    expect(text(rel)).toContain('absolute path');
    const ws = await call('spawn', { provider: 'pi', cwd: SERVER_CWD, workspace: 'rel' }, { mode: 'daemon', run: rec.run });
    expect(ws.isError).toBe(true);
    expect(rec.calls).toHaveLength(1);
  });

  test('a cwd that does not exist (or is a file) is a clear error, before any child runs', async () => {
    const rec = recorder();
    const missing = path.join(SERVER_CWD, 'nope');
    const d = await call('spawn', { provider: 'pi', cwd: missing }, { mode: 'daemon', run: rec.run });
    expect(d.isError).toBe(true);
    expect(text(d)).toContain(`cwd '${missing}' does not exist on the daemon host`);
    const s = await call('workflow_run', { file: 'x.ts', cwd: 'nope' }, { run: rec.run });
    expect(text(s)).toContain("cwd 'nope' does not exist");
    const f = await call('settings', { cwd: 'a-file' }, { run: rec.run });
    expect(text(f)).toContain("cwd 'a-file' is not a directory");
    const r = await call('workflow_retry', { run_id: 'r1', file: '/w.ts', cwd: missing }, { mode: 'daemon', run: rec.run });
    expect(text(r)).toContain('does not exist on the daemon host');
    // A path on another host (a host call) is not checked here.
    const remote = await call('spawn', { provider: 'pi', cwd: '/elsewhere', host: 'mini' }, { run: recorder(() => ({ json: { id: 'x', provider: 'pi', cwd: '/elsewhere' } })).run });
    expect(remote.isError).toBeUndefined();
    expect(rec.calls).toHaveLength(0);
  });

  test('spawn rejects branch without worktree before running anything', async () => {
    const rec = recorder();
    const r = await call('spawn', { provider: 'claude', branch: 'b' }, { run: rec.run });
    expect(r.isError).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  test('positional ids never look like options; host is validated', () => {
    const s = tool('send').schema({ mode: 'stdio', waitTimeoutSec: 45 });
    expect(s.safeParse({ id: '--purge', prompt: 'x' }).success).toBe(false);
    expect(s.safeParse({ id: 'a b', prompt: 'x' }).success).toBe(false);
    expect(s.safeParse({ id: '@orc:impl', prompt: 'x' }).success).toBe(true);
    expect(s.safeParse({ id: 'abc', prompt: 'x', host: '-h' }).success).toBe(false);
    expect(s.safeParse({ id: 'abc', prompt: 'x', host: 'mini:8787' }).success).toBe(true);
    expect(tool('workflow_run').schema({ mode: 'stdio', waitTimeoutSec: 45 }).safeParse({ file: '-x.ts' }).success).toBe(false);
  });

  test('send: prompt on stdin with `-`, idempotency key, --no-wake', async () => {
    const rec = recorder(() => ({ json: { ok: true, id: 'abcd1234', phase: 'acknowledged', messageId: 'k1', replayed: false } }));
    await call('send', { id: 'abcd1234', prompt: '--not-a-flag', idempotency_key: 'k1', wake: false }, { run: rec.run });
    expect(rec.calls[0]!.args).toEqual(['--no-color', 'send', 'abcd1234', '-', '--idempotency-key=k1', '--no-wake', '--json']);
    expect(rec.calls[0]!.stdin).toBe('--not-a-flag');
    await call('send', { id: 'abcd1234', prompt: 'p' }, { run: rec.run });
    expect(rec.calls[1]!.args).toEqual(['--no-color', 'send', 'abcd1234', '-', '--json']);
  });

  test('read/state/kill/list map their options', async () => {
    const rec = recorder((c) => ({ json: c.args.includes('list') ? [] : c.args.includes('read') ? [] : { id: 'x', state: 'done', ok: true } }));
    await call('read', { id: 'x', index: 2 }, { run: rec.run });
    await call('read', { id: 'x', full: true, host: 'mini' }, { run: rec.run });
    await call('state', { id: 'x' }, { run: rec.run });
    await call('kill', { id: 'x', worktree: true, purge: true }, { run: rec.run });
    await call('list', { workspace: '/w', dead: true, lineage: true }, { run: rec.run });
    await call('list', {}, { mode: 'daemon', run: rec.run });
    expect(rec.calls.map((c) => c.args)).toEqual([
      ['--no-color', 'read', 'x', '--index=2', '--json'],
      ['--host=mini', '--no-color', 'read', 'x', '--full', '--json'],
      ['--no-color', 'state', 'x', '--json'],
      ['--no-color', 'kill', 'x', '--worktree', '--purge', '--json'],
      ['--no-color', 'list', '--workspace=/w', '--dead', '--lineage', '--json'],
      // daemon mode: the daemon's cwd is arbitrary, so no workspace means every workspace.
      ['--local', '--no-color', 'list', '--all', '--json'],
    ]);
  });

  test('list over host refuses run_id/lineage (the remote CLI does not take them)', async () => {
    const rec = recorder();
    const r = await call('list', { run_id: 'r1', host: 'mini' }, { run: rec.run });
    expect(r.isError).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  test('workflows: run/resume/retry always --detach; paths resolved; daemon paths absolute', async () => {
    const rec = recorder((c) => ({ json: { runId: 'r1', logPath: '/l', ...(c.args.includes('retry') ? { action: 'retry' } : {}) } }));
    await call('workflow_run', { file: 'wf/x.ts', max_concurrency: 2 }, { run: rec.run });
    await call('workflow_run', { file: 'wf/x.ts', cwd: 'sub' }, { run: rec.run });
    await call('workflow_run', { file: '/remote/x.ts', host: 'mini' }, { run: rec.run });
    await call('workflow_resume', { run_id: 'r1', file: 'wf/x.ts' }, { run: rec.run });
    await call('workflow_retry', { run_id: 'r1', file: '/abs/x.ts', step: 'build', cwd: 'sub' }, { run: rec.run });
    expect(rec.calls.map((c) => c.args)).toEqual([
      ['--no-color', 'workflow', 'run', `${SERVER_CWD}/wf/x.ts`, '--detach', '--max-concurrency=2', '--json'],
      ['--no-color', 'workflow', 'run', `${SERVER_CWD}/wf/x.ts`, '--detach', '--json'],
      ['--host=mini', '--no-color', 'workflow', 'run', '/remote/x.ts', '--detach', '--json'],
      ['--no-color', 'workflow', 'resume', 'r1', `${SERVER_CWD}/wf/x.ts`, '--detach', '--json'],
      ['--no-color', 'workflow', 'retry', 'r1', '/abs/x.ts', '--step=build', '--detach', '--json'],
    ]);
    expect(rec.calls[1]!.cwd).toBe(`${SERVER_CWD}/sub`);
    // resume/retry: the detached runner starts in cwd (default: the server's), so steps without one run there.
    expect(rec.calls[3]!.cwd).toBe(SERVER_CWD);
    expect(rec.calls[4]!.cwd).toBe(`${SERVER_CWD}/sub`);
    const withCwd = await call('workflow_run', { file: '/x.ts', cwd: '/c', host: 'mini' }, { run: rec.run });
    expect(withCwd.isError).toBe(true);
    const relDaemon = await call('workflow_run', { file: 'x.ts', cwd: '/c' }, { mode: 'daemon', run: rec.run });
    expect(relDaemon.isError).toBe(true);
    const relResume = await call('workflow_resume', { run_id: 'r1', file: 'x.ts', cwd: SERVER_CWD }, { mode: 'daemon', run: rec.run });
    expect(relResume.isError).toBe(true);
    // On a daemon, resume/retry need cwd (in the schema, and checked when called directly).
    const d = { mode: 'daemon' as const, waitTimeoutSec: 45 };
    expect(tool('workflow_resume').schema(d).safeParse({ run_id: 'r1', file: '/w.ts' }).success).toBe(false);
    expect(tool('workflow_retry').schema(d).safeParse({ run_id: 'r1', file: '/w.ts', cwd: '/c' }).success).toBe(true);
    const noCwd = await tool('workflow_resume').run({ run_id: 'r1', file: '/w.ts' }, { env: toolEnv('daemon', rec.run), signal: new AbortController().signal });
    expect(text(noCwd)).toContain('cwd is required on the daemon');
    const daemonOk = await call('workflow_retry', { run_id: 'r1', file: '/w.ts', cwd: SERVER_CWD }, { mode: 'daemon', run: rec.run });
    expect(daemonOk.isError).toBeUndefined();
    expect(rec.calls.at(-1)!.args).toEqual(['--local', '--no-color', 'workflow', 'retry', 'r1', '/w.ts', '--detach', '--json']);
    expect(rec.calls.at(-1)!.cwd).toBe(SERVER_CWD);
    expect(rec.calls).toHaveLength(6);
  });

  test('settings runs in the requested directory (resolved against the server cwd)', async () => {
    const unset = { value: null, source: 'default' };
    const view = {
      cwd: '/x',
      root: null,
      nested: false,
      host: unset,
      provider: { value: 'claude', source: 'global', from: '/h/.orc/settings.toml' },
      models: { claude: { value: 'model-a', source: 'global', from: '/h/.orc/settings.toml' }, codex: unset, pi: unset },
      files: [],
      warnings: [],
    };
    const rec = recorder(() => ({ json: view }));
    const r = await call('settings', { cwd: 'pkg' }, { run: rec.run });
    expect(r.isError).toBeUndefined();
    expect(rec.calls[0]!.args).toEqual(['--no-color', 'settings', '--json']);
    expect(rec.calls[0]!.cwd).toBe(`${SERVER_CWD}/pkg`);
    expect(text(r)).toContain('provider');
  });

  test('CLI children never get daemon credentials, except the client ones on an explicit host call', async () => {
    const rec = recorder(() => ({ json: [] }));
    await call('list', {}, { run: rec.run });
    await call('list', { host: 'mini' }, { run: rec.run });
    await call('list', {}, { mode: 'daemon', run: rec.run });
    const [local, remote, daemon] = rec.calls.map((c) => c.env);
    for (const k of STRIPPED_ENV_KEYS) {
      expect(local![k]).toBeUndefined();
      expect(daemon![k]).toBeUndefined();
    }
    expect(remote!.ORC_DAEMON_TOKEN).toBe('bearer-tok');
    expect(remote!.ORC_DAEMON_SECRET).toBe('sekret');
    expect(remote!.ORC_DAEMON_TOKENS).toBeUndefined();
    expect(local!.ORC_HOME).toBe('/home/u/.orc');
    expect(childEnv({ A: 'a', B: undefined, ORC_DAEMON_TOKENS: 'x' })).toEqual({ A: 'a' });
  });
});

describe('results and errors', () => {
  test('a CLI {error} becomes isError with the message and a hint', async () => {
    const rec = recorder(() => ({ code: 1, json: { error: "no session found for 'nope'" } }));
    const r = await call('read', { id: 'nope' }, { run: rec.run });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("no session found for 'nope'");
    expect(text(r)).toContain('hint: list the sessions');
    expect(r.structuredContent).toMatchObject({ error: "no session found for 'nope'" });
  });

  test('unauthorized after a default-host route: the hint says to pass host (calls without host carry no credentials)', async () => {
    const routed = { code: 1, json: { error: 'mini: unauthorized: authentication required' }, stderr: 'orc: → mini (from ORC_HOST)\n' };
    expect(defaultHostRoute(routed.stderr)).toEqual({ host: 'mini', from: 'ORC_HOST' });
    const r = await call('list', {}, { run: recorder(() => routed).run });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('followed the default host mini (from ORC_HOST)');
    expect(text(r)).toContain('pass host: "mini" explicitly');
    // An explicit host call (no route notice) keeps the trust/token hint.
    const direct = cliFailure({ ...BASE_RESULT, code: 1, json: { error: 'mini: unauthorized: invalid credentials' } }, 'orc list');
    expect(String(direct.structuredContent?.hint)).toContain('orc remote add on that host');
    expect(String(direct.structuredContent?.hint)).not.toContain('pass host');
    // The hint survives in a multi-id wait where every id failed that way.
    const w = await call('wait', { ids: ['a', 'b'] }, { run: recorder(() => routed).run });
    expect(w.isError).toBe(true);
    expect(text(w)).toContain('pass host: "mini" explicitly');
  });

  test('send: exit 3 (unknown delivery) is an error that says not to blindly retry', async () => {
    const rec = recorder(() => ({ code: 3, json: { ok: false, id: 'abcd1234', phase: 'unknown', messageId: 'k', replayed: false } }));
    const r = await call('send', { id: 'abcd1234', prompt: 'x' }, { run: rec.run });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('NEW idempotency_key');
    expect(r.structuredContent).toMatchObject({ phase: 'unknown' });
  });

  test('send: a replayed key is success and says nothing was re-sent', async () => {
    const rec = recorder(() => ({ json: { ok: true, id: 'abcd1234', phase: 'acknowledged', messageId: 'k', replayed: true } }));
    const r = await call('send', { id: 'abcd1234', prompt: 'x', idempotency_key: 'k' }, { run: rec.run });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('nothing re-sent');
  });

  test('non-JSON output, a spawn failure, a cancelled call', async () => {
    const garbage = await call('state', { id: 'x' }, { run: recorder(() => ({ code: 1, stdout: 'boom', stderr: 'fatal: something broke\n' })).run });
    expect(garbage.isError).toBe(true);
    expect(text(garbage)).toContain('exit code 1');
    expect(text(garbage)).toContain('fatal: something broke');
    const nospawn = await call('state', { id: 'x' }, { run: recorder(() => ({ code: null, spawnError: 'ENOENT' })).run });
    expect(text(nospawn)).toContain('could not run orc state: ENOENT');
    const cancelled = await call('state', { id: 'x' }, { run: recorder(() => ({ code: null, aborted: true })).run });
    expect(text(cancelled)).toContain('cancelled');
  });

  test('state explains what the state means for the lead', async () => {
    const mk = (d: Record<string, unknown>) => recorder(() => ({ json: { id: 'x', status: 'running', ...d } })).run;
    expect(text(await call('state', { id: 'x' }, { run: mk({ state: 'done' }) }))).toContain('not necessarily success');
    expect(text(await call('state', { id: 'x' }, { run: mk({ state: 'failed', suspended: true }) }))).toContain('send wakes it');
    expect(text(await call('state', { id: 'x' }, { run: mk({ state: 'failed', stopped: true }) }))).toContain('call resume');
    expect(text(await call('state', { id: 'x' }, { run: mk({ state: 'failed' }) }))).toContain('lastTurn.error');
  });

  test('list wraps the CLI array (structuredContent is an object) and renders one line per session', async () => {
    const rows = [{ id: 'abcd1234', sessionId: 'abcd1234-0', provider: 'claude', cwd: '/w', workspace: '/w', createdAt: 't', status: 'running', state: 'done', alias: 'impl' }];
    const r = await call('list', {}, { run: recorder(() => ({ json: rows })).run });
    expect(r.structuredContent).toEqual({ sessions: rows });
    expect(text(r)).toContain('1 session(s):');
    expect(text(r)).toContain('abcd1234  claude [running] done');
  });

  test('read renders turns and keeps the END of long output, saying how to page', async () => {
    const turns = [
      { role: 'user', text: 'first question' },
      { role: 'tool', text: 'Read src/a.ts' },
      { role: 'assistant', text: `${'x'.repeat(3_000)} THE END` },
    ];
    const small = await call('read', { id: 'x' }, { run: recorder(() => ({ json: turns })).run });
    expect(text(small)).toBe(`<user> first question\n  [Read src/a.ts]\n<assistant> ${'x'.repeat(3_000)} THE END`);
    expect(small.structuredContent).toMatchObject({ kind: 'transcript', turns });

    const cut = await call('read', { id: 'x', max_chars: 1_000, full: true }, { run: recorder(() => ({ json: turns })).run });
    const t = text(cut);
    expect(t.startsWith('[cut: showing the last')).toBe(true);
    expect(t).toContain('read one turn with index');
    expect(t.endsWith('THE END')).toBe(true);
    expect(t).not.toContain('first question');
    expect(t.length).toBeLessThan(1_000 + 200);
    expect(cut.structuredContent).toMatchObject({ truncated: true });
    // The structured result explains the cut too (some clients show only structuredContent).
    expect(String(cut.structuredContent!.note)).toContain('[cut: showing the last');
    expect(DEFAULT_MAX_CHARS).toBe(16_000);
  });

  test('read: the journal fallback, the raw journal and a v1 pane', async () => {
    const journal = [
      { seq: 1, ts: 't', type: 'turn.intent', messageId: 'm', text: 'hello' },
      { seq: 2, ts: 't', type: 'assistant.text', messageId: 'm', text: 'echo: hello' },
    ];
    const fb = await call('read', { id: 'x' }, { run: recorder(() => ({ json: { id: 'x', fallback: true, journal } })).run });
    expect(text(fb)).toContain('(no provider transcript yet: the session journal)');
    expect(text(fb)).toContain('echo: hello');
    expect(fb.structuredContent).toMatchObject({ kind: 'fallback', fallback: true });
    const raw = await call('read', { id: 'x', raw: true }, { run: recorder(() => ({ json: { id: 'x', journal } })).run });
    expect(text(raw).split('\n').map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
    const pane = await call('read', { id: 'x', host: 'old' }, { run: recorder(() => ({ json: { id: 'x', pane: 'PANE' } })).run });
    expect(text(pane)).toBe('PANE');
  });

  test('workflow_logs: per-step headings; a cut keeps whole steps in structuredContent', async () => {
    const logs = [
      { step: 'a', turns: [{ role: 'assistant', text: 'A'.repeat(2_000) }] },
      { step: 'b', turns: [{ role: 'assistant', text: 'step b done' }] },
    ];
    const r = await call('workflow_logs', { run_id: 'r1', max_chars: 1_000 }, { run: recorder(() => ({ json: logs })).run });
    expect(text(r)).toContain('### step b\n<assistant> step b done');
    expect(text(r)).toContain('### step a');
    expect(r.structuredContent).toMatchObject({ logs: [logs[1]], truncated: true, omittedSteps: ['a'] });
  });

  test('workflow_cancel returns the public run view (no plan prompts)', async () => {
    const run = {
      id: 'r1',
      name: 'n',
      status: 'cancelled',
      startedAt: 't',
      steps: [],
      plan: { name: 'n', steps: [{ id: 'a', provider: 'claude', prompt: 'SECRET_PROMPT', needs: [] }] },
      attempts: [],
    };
    const r = await call('workflow_cancel', { run_id: 'r1', cascade: true }, { run: recorder(() => ({ json: run })).run });
    expect(JSON.stringify(r)).not.toContain('SECRET_PROMPT');
    expect(r.structuredContent).toMatchObject({ id: 'r1', status: 'cancelled' });
  });

  test('guide: the whole playbook, a topic, or an error listing the topics', async () => {
    const whole = await call('guide', {});
    expect(text(whole)).toBe(guideText());
    // Text only: clients that show structuredContent instead of the text still see the playbook.
    expect(whole.structuredContent).toBeUndefined();
    expect(text(await call('guide', { topic: 'cleanup' }))).toContain('## Cleanup');
    const bad = await call('guide', { topic: 'nope' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('topics: principles');
  });
});

describe('wait over many ids', () => {
  /** A runner whose `wait` children settle per id after a delay; `state` answers snapshots. */
  function waitRunner(plan: Record<string, { after: number; state: string; timedOut?: boolean; error?: string }>) {
    return recorder(async (c) => {
      const id = c.args[c.args.indexOf('wait') + 1] ?? c.args[c.args.indexOf('state') + 1]!;
      if (c.args.includes('state')) return { json: { id, state: 'running', status: 'running' } };
      const p = plan[id]!;
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), p.after);
        c.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (aborted) return { code: null, aborted: true };
      if (p.error) return { code: 1, json: { error: p.error } };
      return { code: p.timedOut ? 1 : 0, json: { id, state: p.state, elapsedMs: p.after, timedOut: p.timedOut === true } };
    });
  }

  test('mode all: waits for every id; a timeout is not an error; pending ids are named', async () => {
    const rec = waitRunner({ a: { after: 10, state: 'done' }, b: { after: 30, state: 'running', timedOut: true } });
    const r = await call('wait', { ids: ['a', 'b', 'a'] }, { run: rec.run });
    expect(r.isError).toBeUndefined();
    expect(rec.calls.map((c) => c.args)).toEqual([
      ['--no-color', 'wait', 'a', '--for=settled', '--timeout=45', '--json'],
      ['--no-color', 'wait', 'b', '--for=settled', '--timeout=45', '--json'],
    ]);
    expect(r.structuredContent).toMatchObject({ for: 'settled', mode: 'all', reached: ['a'], pending: ['b'] });
    expect(text(r)).toContain('1 of 2 reached settled');
    expect(text(r)).toContain('call wait again for b');
    expect(rec.calls[0]!.timeoutMs).toBe(45_000 + 30_000);
  });

  test('mode any: returns at the first settled id, stops the others and snapshots their state', async () => {
    const rec = waitRunner({ fast: { after: 20, state: 'done' }, slow: { after: 10_000, state: 'done' } });
    const started = Date.now();
    const r = await call('wait', { ids: ['fast', 'slow'], mode: 'any', for: 'done', timeout_seconds: 30 }, { run: rec.run });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.structuredContent).toMatchObject({ mode: 'any', reached: ['fast'], pending: ['slow'] });
    expect(rec.calls.some((c) => c.args.includes('state') && c.args.includes('slow'))).toBe(true);
    const slow = (r.structuredContent!.sessions as { id: string; state: string }[]).find((e) => e.id === 'slow');
    expect(slow?.state).toBe('running');
  });

  test('every id failing is an error; one failing id is reported but not fatal', async () => {
    const allBad = await call('wait', { ids: ['x', 'y'] }, { run: waitRunner({ x: { after: 1, state: '', error: "no session found for 'x'" }, y: { after: 1, state: '', error: "no session found for 'y'" } }).run });
    expect(allBad.isError).toBe(true);
    const oneBad = await call('wait', { ids: ['x', 'ok'] }, { run: waitRunner({ x: { after: 1, state: '', error: "no session found for 'x'" }, ok: { after: 1, state: 'done' } }).run });
    expect(oneBad.isError).toBeUndefined();
    expect(text(oneBad)).toContain("x  error: no session found for 'x'");
  });

  test(`ids are bounded (${MAX_WAIT_IDS}) and the timeout too`, () => {
    const s = tool('wait').schema({ mode: 'stdio', waitTimeoutSec: 45 });
    expect(s.safeParse({ ids: Array.from({ length: MAX_WAIT_IDS + 1 }, (_, i) => `s${i}`) }).success).toBe(false);
    expect(s.safeParse({ ids: [] }).success).toBe(false);
    expect(s.safeParse({ ids: ['a'], timeout_seconds: 601 }).success).toBe(false);
    expect(s.safeParse({ ids: ['a'], for: 'succeeded' }).success).toBe(false);
  });

  test('a cancelled request stops the wait children', async () => {
    const rec = waitRunner({ a: { after: 10_000, state: 'done' } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await call('wait', { ids: ['a'] }, { run: rec.run, signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('cancelled');
  });
});

describe('bounded rendering', () => {
  test('tailWindow keeps whole items from the end, then the tail of one more', () => {
    const items = ['aaaa', 'bbbb', 'cccc'];
    expect(tailWindow(items, (s) => s, 100)).toMatchObject({ truncated: false, text: 'aaaa\nbbbb\ncccc' });
    const w = tailWindow(items, (s) => s, 9);
    expect(w.text).toBe('bbbb\ncccc');
    expect(w.items).toEqual(['bbbb', 'cccc']);
    const big = tailWindow(['x'.repeat(500)], (s) => s, 100);
    expect(big.text.length).toBeLessThanOrEqual(100);
    expect(big.text.startsWith('…')).toBe(true);
  });
});

describe('/mcp Host and Origin guard', () => {
  test('allowed hosts: loopback, tailnet (name, label, IPs), wildcard, extras', () => {
    expect(mcpAllowedHosts({ bind: '127.0.0.1' })).toEqual(['127.0.0.1', 'localhost', '[::1]']);
    expect(mcpAllowedHosts({ bind: '::1' })).toEqual(['[::1]', 'localhost', '127.0.0.1']);
    const tailnet = { dnsName: 'mini.taila038d5.ts.net', ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'] };
    expect(mcpAllowedHosts({ bind: '100.64.0.7', tailnet })).toEqual([
      '100.64.0.7',
      'mini.taila038d5.ts.net',
      'mini',
      '[fd7a:115c:a1e0::7]',
    ]);
    // A tailnet that does not own the bound address adds nothing.
    expect(mcpAllowedHosts({ bind: '192.168.1.5', tailnet })).toEqual(['192.168.1.5']);
    expect(mcpAllowedHosts({ bind: '0.0.0.0', tailnet })).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'mini.taila038d5.ts.net',
      'mini',
      '100.64.0.7',
      '[fd7a:115c:a1e0::7]',
    ]);
    expect(mcpAllowedHosts({ bind: '127.0.0.1', extra: ['Orc.Example.COM.', 'proxy:8443', 'fd00::1'] })).toEqual([
      '127.0.0.1',
      'localhost',
      '[::1]',
      'orc.example.com',
      'proxy',
      '[fd00::1]',
    ]);
    expect(() => normalizeAllowedHost('http://x/y')).toThrow(/invalid host/);
    expect(() => normalizeAllowedHost(' ')).toThrow(/invalid host/);
  });

  test('Host must name the daemon (port ignored); a trailing dot or case does not matter', () => {
    const allowed = ['127.0.0.1', 'localhost', '[::1]', 'mini'];
    expect(hostRejection('127.0.0.1:8787', allowed)).toBeNull();
    expect(hostRejection('LOCALHOST', allowed)).toBeNull();
    expect(hostRejection('[::1]:8787', allowed)).toBeNull();
    expect(hostRejection('mini.:8787', allowed)).toBeNull();
    expect(hostRejection('evil.example:8787', allowed)).toBe('Invalid Host: evil.example');
    expect(hostRejection(null, allowed)).toBe('Missing Host header');
    expect(hostRejection('a b', allowed)).toMatch(/Invalid Host header/);
  });

  test('Origin: absent passes; present must be an http(s) origin naming the daemon', () => {
    const allowed = ['127.0.0.1', 'localhost'];
    expect(originRejection(null, allowed)).toBeNull();
    expect(originRejection('', allowed)).toBeNull();
    expect(originRejection('http://localhost:6274', allowed)).toBeNull();
    expect(originRejection('https://evil.example', allowed)).toBe('Invalid Origin: evil.example');
    expect(originRejection('null', allowed)).toMatch(/Invalid Origin header/);
    expect(originRejection('chrome-extension://abc', allowed)).toMatch(/Invalid Origin/);
  });

  test('tailscale status --json: Self DNS name and IPs', () => {
    expect(parseStatusSelf(JSON.stringify({ Self: { DNSName: 'Mini.taila038d5.ts.net.', TailscaleIPs: ['100.64.0.7'] } }))).toEqual({
      dnsName: 'mini.taila038d5.ts.net',
      ips: ['100.64.0.7'],
    });
    expect(parseStatusSelf('{}')).toBeNull();
    expect(parseStatusSelf('not json')).toBeNull();
    expect(parseStatusSelf(JSON.stringify({ Self: { DNSName: '', TailscaleIPs: [] } }))).toBeNull();
  });

  test('toolCallName: the tool of a single tools/call request', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(toolCallName(enc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kill' } }))).toBe('kill');
    expect(toolCallName(enc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBeUndefined();
    expect(toolCallName(enc([{ method: 'tools/call', params: { name: 'kill' } }]))).toBeUndefined();
    expect(toolCallName(new TextEncoder().encode('{nope'))).toBeUndefined();
  });
});

describe('the CLI child runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-mcp-exec-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-orc.ts');
  fs.writeFileSync(
    script,
    `const args = process.argv.slice(2);
if (args.includes('sleep')) { await Bun.sleep(30_000); }
if (args.includes('nap')) { await Bun.sleep(300); }
const stdin = args.includes('-') ? await Bun.stdin.text() : null;
if (args.includes('fail')) { process.stderr.write('bad things\\n'); process.stdout.write(JSON.stringify({ error: 'it failed' }) + '\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env.MARK ?? null }, null, 2) + '\\n');
`,
  );
  const run = createCliRunner([process.execPath, script]);

  test('argv as an array (shell metacharacters stay literal), stdin, cwd and env', async () => {
    const r = await run({ args: ['send', '$(touch /tmp/pwned)', '-', '; rm -rf /'], stdin: 'hello\nworld', cwd: dir, env: { ...process.env, MARK: 'm' } as Record<string, string> });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ args: ['send', '$(touch /tmp/pwned)', '-', '; rm -rf /'], stdin: 'hello\nworld', cwd: fs.realpathSync(dir), env: 'm' });
  });

  test('an {error} document and exit code 1 are captured with stderr', async () => {
    const r = await run({ args: ['fail'], env: process.env as Record<string, string> });
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ error: 'it failed' });
    expect(r.stderr).toContain('bad things');
  });

  test('abort and timeout kill the child', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    const aborted = await run({ args: ['sleep'], env: process.env as Record<string, string>, signal: ac.signal });
    expect(aborted.aborted).toBe(true);
    const timedOut = await run({ args: ['sleep'], env: process.env as Record<string, string>, timeoutMs: 100 });
    expect(timedOut.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('children are capped: calls beyond the limit queue, and an abort while queued cancels without spawning', async () => {
    const limiter = new ChildLimiter(1);
    const limited = createCliRunner([process.execPath, script], { limiter });
    const env = process.env as Record<string, string>;
    const started = Date.now();
    const first = limited({ args: ['nap'], env });
    const second = limited({ args: ['nap'], env });
    await Bun.sleep(20);
    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(1);
    const ac = new AbortController();
    const third = limited({ args: ['nap'], env, signal: ac.signal });
    await Bun.sleep(20);
    expect(limiter.queued).toBe(2);
    ac.abort();
    const t = await third;
    expect(t.aborted).toBe(true);
    expect(t.code).toBeNull();
    expect(limiter.queued).toBe(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // One at a time: the second child started after the first exited.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * 300);
    expect(limiter.running).toBe(0);
    expect(SHARED_CHILD_LIMITER.max).toBe(MAX_CLI_CHILDREN);
    expect(MAX_CLI_CHILDREN).toBe(32);
    expect(() => new ChildLimiter(0)).toThrow();
  });

  test('a missing working directory is named, not reported as a posix_spawn ENOENT', async () => {
    const r = await run({ args: ['x'], cwd: path.join(dir, 'missing'), env: process.env as Record<string, string> });
    expect(r.spawnError).toBe(`working directory '${path.join(dir, 'missing')}' does not exist`);
  });

  test('a NUL byte in an argument is refused; JSON parsing falls back to the last line', async () => {
    const r = await run({ args: ['a\0b'], env: process.env as Record<string, string> });
    expect(r.spawnError).toContain('NUL');
    expect(parseCliJson('warning: x\n{"a":1}\n')).toEqual({ a: 1 });
    expect(parseCliJson('')).toBeUndefined();
    expect(parseCliJson('nope')).toBeUndefined();
  });
});

describe('orc mcp stdio: requests in flight', () => {
  test('a request is in flight from receipt until its response is sent', async () => {
    const f = new InFlightRequests();
    f.received({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    f.received({ jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    f.received({ jsonrpc: '2.0', method: 'notifications/initialized' }); // a notification: nothing to answer
    f.received({ jsonrpc: '2.0', id: 9, result: {} }); // a response from the client: not ours to answer
    expect(f.size).toBe(2);
    let idle = false;
    const done = f.idle().then(() => (idle = true));
    f.answered({ jsonrpc: '2.0', id: 1, result: {} });
    f.answered({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
    await Bun.sleep(5);
    expect(idle).toBe(false);
    f.answered({ jsonrpc: '2.0', id: 'a', error: { code: -1, message: 'x' } });
    await done;
    expect(f.size).toBe(0);
    await f.idle(); // already idle: resolves at once
  });
});
