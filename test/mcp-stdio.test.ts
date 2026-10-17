/**
 * `orc mcp` end to end: the official MCP TypeScript client drives `bun src/cli/index.ts
 * mcp` over stdio (2025-era `initialize` and 2026-07-28 `server/discover`), with an
 * isolated ORC_HOME and the scripted fake provider. Covers the handshake (instructions),
 * tools/list, settings, list, the spawn → wait → read → send → wait → kill loop, a
 * multi-id wait, a detached workflow, error results, and the CLI surface of `orc mcp`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { readRegistry } from '../src/registry.ts';
import { orcInstructions } from '../src/mcp/instructions.ts';
import { createCliRunner } from '../src/mcp/exec.ts';
import { cliFailure } from '../src/mcp/shape.ts';
import { killSessionProcesses, mkTmp, plainCliEnv } from './runtime-helpers.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const T = 60_000;
const prevHome = process.env.ORC_HOME;
const root = mkTmp('orc-mcp-stdio-');
const home = path.join(root, 'orc');
const work = path.join(root, 'work');
const FAKE_SCRIPT = JSON.stringify({
  rules: [{ match: 'HANG', action: 'hang' }],
  reportEnv: ['ORC_DAEMON_TOKEN', 'ORC_DAEMON_SECRET', 'ORC_DAEMON_TOKENS', 'ORC_HOME'],
});

/** The env `orc mcp` runs with (as a lead's MCP client would start it). */
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORC_')) env[k] = v;
  return plainCliEnv({
    ...env,
    ORC_HOME: home,
    [FAKE_PROVIDER_ENV]: FAKE_SCRIPT,
    // Daemon credentials in the lead's environment must never reach an agent.
    ORC_DAEMON_TOKEN: 'client-bearer',
    ORC_DAEMON_SECRET: 'shared-secret',
    ORC_DAEMON_TOKENS: '{"server-token":["admin"]}',
  });
}

const clients: Client[] = [];
async function connect(mode: 'legacy' | 'auto' | { pin: string } = 'legacy', args: string[] = []): Promise<Client> {
  const client = new Client({ name: 'orc-mcp-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', ...args], cwd: work, env: serverEnv(), stderr: 'pipe' }),
  );
  clients.push(client);
  return client;
}

interface Result {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args }, { timeout: 90_000 })) as Result;
}
const text = (r: Result): string => r.content.map((c) => c.text ?? '').join('\n');

async function orcCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd: work, env: serverEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

let client: Client;

beforeAll(async () => {
  process.env.ORC_HOME = home;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, 'mcp-wf.ts'),
    `export default {
  name: 'mcp-wf',
  steps: [{ id: 'one', provider: 'claude', prompt: 'workflow step one', allowUnverified: true }],
};\n`,
  );
  client = await connect('legacy', ['--wait-timeout', '20']);
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await killSessionProcesses((await readRegistry().catch(() => [])).map((r) => r.sessionId));
  if (prevHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const EXPECTED_TOOLS = [
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

describe('orc mcp over stdio', () => {
  test('a 2025-era initialize gets the lead instructions, the tools, the guide resource and prompt', async () => {
    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getServerVersion()?.name).toBe('orc');
    expect(client.getInstructions()).toBe(orcInstructions('stdio'));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    const wait = tools.tools.find((t) => t.name === 'wait')!;
    expect(wait.description).toContain('default 20');
    expect(wait.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.tools.find((t) => t.name === 'kill')!.annotations).toMatchObject({ destructiveHint: true });
    expect(Object.keys((tools.tools.find((t) => t.name === 'spawn')!.inputSchema as { properties: object }).properties)).toContain('host');
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toEqual(['orc://guide']);
    const guide = await client.readResource({ uri: 'orc://guide' });
    expect((guide.contents[0] as { text: string }).text).toContain('# orc lead playbook');
    const prompt = await client.getPrompt({ name: 'orchestrate', arguments: { task: 'ship the feature' } });
    expect(JSON.stringify(prompt.messages)).toContain('ship the feature');
  }, T);

  test('a 2026-07-28 client discovers the same server (instructions travel in server/discover)', async () => {
    const modern = await connect({ pin: '2026-07-28' });
    expect(modern.getProtocolEra()).toBe('modern');
    expect(modern.getInstructions()).toBe(orcInstructions('stdio'));
    expect((await modern.listTools()).tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    const g = await callTool(modern, 'guide', { topic: 'team' });
    expect(g.isError).toBeFalsy();
    expect(text(g)).toContain('Judge rubric');
    await modern.close();
  }, T);

  test('settings and list run the CLI', async () => {
    const s = await callTool(client, 'settings');
    expect(s.isError).toBeFalsy();
    expect(s.structuredContent).toMatchObject({ provider: { value: null, source: 'default' } });
    expect(text(s)).toContain('provider');
    const l = await callTool(client, 'list');
    expect(l.isError).toBeFalsy();
    expect(l.structuredContent).toEqual({ sessions: [] });
  }, T);

  test('spawn → wait → read → send → wait → read → state → kill', async () => {
    const sp = await callTool(client, 'spawn', { provider: 'claude', prompt: 'alpha\nbeta', alias: 'impl-one' });
    expect(sp.isError).toBeFalsy();
    const id = sp.structuredContent!.id as string;
    expect(sp.structuredContent).toMatchObject({ provider: 'claude', alias: 'impl-one', cwd: fs.realpathSync(work) });

    const w1 = await callTool(client, 'wait', { ids: [id] });
    expect(w1.isError).toBeFalsy();
    expect(w1.structuredContent).toMatchObject({ reached: [id], pending: [] });
    expect(w1.structuredContent!.sessions[0]).toMatchObject({ id, state: 'done', reached: true });

    const r1 = await callTool(client, 'read', { id });
    expect(r1.isError).toBeFalsy();
    expect(text(r1)).toContain('echo: alpha\nbeta');

    // The agent's provider never saw the lead's daemon credentials.
    const raw = await callTool(client, 'read', { id, raw: true });
    const ready = (raw.structuredContent!.journal as { type: string; info?: { env?: Record<string, string> } }[]).find(
      (e) => e.type === 'provider.ready',
    );
    expect(ready?.info?.env).toEqual({ ORC_HOME: home });

    const s1 = await callTool(client, 'send', { id: '@impl-one', prompt: 'second turn', idempotency_key: 'k-2' });
    expect(s1.isError).toBeFalsy();
    expect(s1.structuredContent).toMatchObject({ ok: true, id, phase: 'acknowledged', messageId: 'k-2', replayed: false });
    const again = await callTool(client, 'send', { id, prompt: 'second turn', idempotency_key: 'k-2' });
    expect(again.structuredContent).toMatchObject({ replayed: true });
    const clash = await callTool(client, 'send', { id, prompt: 'other text', idempotency_key: 'k-2' });
    expect(clash.isError).toBe(true);
    expect(text(clash)).toContain('use a new key');

    const w2 = await callTool(client, 'wait', { ids: [id], for: 'done' });
    expect(w2.structuredContent).toMatchObject({ reached: [id] });
    expect(text(await callTool(client, 'read', { id }))).toContain('echo: second turn');

    const st = await callTool(client, 'state', { id });
    expect(st.structuredContent).toMatchObject({ id, state: 'done', status: 'running', stopped: false });

    const listed = await callTool(client, 'list');
    expect((listed.structuredContent!.sessions as { id: string }[]).map((s) => s.id)).toContain(id);

    const k = await callTool(client, 'kill', { id });
    expect(k.structuredContent).toEqual({ ok: true, id, purged: false });
    expect((await callTool(client, 'state', { id })).structuredContent).toMatchObject({ state: 'failed', stopped: true });
    expect(((await callTool(client, 'list')).structuredContent!.sessions as unknown[]).length).toBe(0);
  }, T);

  test('wait on a team: mode any returns at the first settled agent; still-running ones are pending', async () => {
    const fast = (await callTool(client, 'spawn', { provider: 'pi', prompt: 'quick one' })).structuredContent!.id as string;
    const slow = (await callTool(client, 'spawn', { provider: 'codex', prompt: 'HANG forever' })).structuredContent!.id as string;
    const w = await callTool(client, 'wait', { ids: [fast, slow], mode: 'any', timeout_seconds: 15 });
    expect(w.isError).toBeFalsy();
    expect(w.structuredContent).toMatchObject({ mode: 'any', reached: [fast], pending: [slow] });
    expect(text(w)).toContain(`call wait again for ${slow}`);
    // A bounded wait on the hanging agent times out without an error.
    const t = await callTool(client, 'wait', { ids: [slow], timeout_seconds: 1 });
    expect(t.isError).toBeFalsy();
    expect(t.structuredContent).toMatchObject({ reached: [], pending: [slow] });
    expect(t.structuredContent!.sessions[0]).toMatchObject({ state: 'running', timedOut: true });
    for (const id of [fast, slow]) expect((await callTool(client, 'kill', { id, purge: true })).isError).toBeFalsy();
  }, T);

  test('workflow_run starts a detached run; workflow_status / workflow_logs / workflow_list follow it', async () => {
    const run = await callTool(client, 'workflow_run', { file: 'mcp-wf.ts' });
    expect(run.isError).toBeFalsy();
    const runId = run.structuredContent!.runId as string;
    expect(typeof run.structuredContent!.logPath).toBe('string');
    let status = '';
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const s = await callTool(client, 'workflow_status', { run_id: runId });
      expect(s.isError).toBeFalsy();
      status = s.structuredContent!.status as string;
      if (status !== 'running') break;
      await Bun.sleep(250);
    }
    expect(status).toBe('done');
    const logs = await callTool(client, 'workflow_logs', { run_id: runId, raw: true });
    expect(logs.isError).toBeFalsy();
    expect(text(logs)).toContain('### step one (claude)');
    expect(text(logs)).toContain('echo: workflow step one');
    const list = await callTool(client, 'workflow_list');
    expect((list.structuredContent!.runs as { id: string }[]).map((r) => r.id)).toContain(runId);
    const cleanup = await callTool(client, 'workflow_cleanup', { run_id: runId, sessions: true });
    expect(cleanup.isError).toBeFalsy();
  }, T);

  test('errors come back as isError results with a hint', async () => {
    const bad = await callTool(client, 'read', { id: 'nope' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("no session found for 'nope'");
    expect(text(bad)).toContain('hint:');
    const invalid = await callTool(client, 'wait', { ids: [] });
    expect(invalid.isError).toBe(true);
    const unknownRun = await callTool(client, 'workflow_status', { run_id: 'no-such-run' });
    expect(unknownRun.isError).toBe(true);
    expect(text(unknownRun)).toContain("no run found for 'no-such-run'");
  }, T);
});

describe('the orc mcp command', () => {
  test('is host-local, validates --wait-timeout, rejects stray arguments', async () => {
    const remote = await orcCli(['--host', 'mini', 'mcp']);
    expect(remote.code).toBe(1);
    expect(remote.err).toContain("'mcp' is not supported over --host");
    const bad = await orcCli(['mcp', '--wait-timeout', '0', '--json']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toEqual({ error: "invalid --wait-timeout '0' (seconds, 1-600)" });
    const stray = await orcCli(['mcp', 'extra']);
    expect(stray.code).toBe(1);
    expect(stray.err).toContain("unexpected argument 'extra'");
  }, T);

  test('a CLI option-parse error reaches the tools as the {"error"} document, then an error result', async () => {
    const r = await createCliRunner()({ args: ['--no-color', 'list', '--bogus', '--json'], cwd: work, env: serverEnv() });
    expect(r.code).toBe(1);
    expect((r.json as { error: string }).error).toContain("Unknown option '--bogus'");
    const res = cliFailure(r, 'orc list');
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Unknown option '--bogus'");
  }, T);
});
