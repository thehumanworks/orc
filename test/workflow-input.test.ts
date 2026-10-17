import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateWorkflowModule } from '../src/workflow-loader.ts';
import { readRun } from '../src/runs.ts';
import { serveDaemon } from '../src/daemon/server.ts';
import { plainCliEnv } from './runtime-helpers.ts';

const CLI = path.resolve(import.meta.dir, '../src/cli/index.ts');
const INPUT = 'research "inputs"\nsecond line';
let dir: string;
let file: string;
let oldHome: string | undefined;
let server: ReturnType<typeof serveDaemon> | undefined;

beforeEach(async () => {
  oldHome = process.env.ORC_HOME;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-workflow-input-'));
  process.env.ORC_HOME = path.join(dir, 'home');
  file = path.join(dir, 'workflow.ts');
  await fs.writeFile(file, `export default async ({ prompt }) => ({
    name: 'input-workflow', policy: { maxSessions: 0 }, keepSessionsOnError: false,
    steps: [{ id: 'research', provider: 'claude', prompt: 'Task: ' + (prompt ?? 'missing') }],
  });`);
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (oldHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = oldHome;
  await fs.rm(dir, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: plainCliEnv({ ORC_HOME: process.env.ORC_HOME!, ORC_DAEMON_SECRET: 'test' }), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function finished(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await readRun(id);
    if (run && run.status !== 'running') return run;
    await Bun.sleep(25);
  }
  throw new Error(`runner ${id} did not finish`);
}

function startDaemon() {
  server = serveDaemon({ hostname: '127.0.0.1', port: 0, secret: 'test', allowlist: [], whois: async () => null });
  return `http://127.0.0.1:${server.port}`;
}

async function post(base: string, route: string, body: unknown) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-orc-secret': 'test' },
    body: JSON.stringify(body),
  });
  const value = await response.json() as any;
  expect(response.status).toBe(200);
  return value;
}

describe('workflow invocation input', () => {
  test('plain objects, synchronous and asynchronous factories share validation', async () => {
    const def = { name: 'plain', steps: [{ id: 'one', provider: 'claude' as const, prompt: 'task' }] };
    expect(await evaluateWorkflowModule(def)).toBe(def);
    expect((await evaluateWorkflowModule(({ prompt }: { prompt?: string }) => ({ ...def, name: prompt }), { prompt: 'sync' })).name).toBe('sync');
    expect((await evaluateWorkflowModule(async () => def)).name).toBe('plain');
    await expect(evaluateWorkflowModule(() => ({ name: 'invalid' }))).rejects.toThrow();
  });

  test('foreground CLI expands file input and persists override through resume and retry', async () => {
    const inputFile = path.join(dir, 'input.txt');
    await fs.writeFile(inputFile, INPUT);
    const result = await cli('--local', 'workflow', 'run', file, '--prompt', `@${inputFile}`, '--keep-sessions-on-error', '--json');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(1); // the fixture deliberately prohibits agent creation
    const run = JSON.parse(result.stdout);
    for (const action of ['resume', 'retry']) {
      const recovered = await cli('--local', 'workflow', action, run.id, file, '--json');
      expect(recovered.stderr).toBe('');
      expect(recovered.code).toBe(1);
      const saved = await readRun(run.id);
      expect(saved?.prompt).toBe(INPUT);
      expect(saved?.plan?.steps[0]?.prompt).toBe(`Task: ${INPUT}`);
      expect(saved?.plan?.keepSessionsOnError).toBe(true);
    }
  });

  test('detached CLI persists input before launch and reuses it for detached recovery', async () => {
    const result = await cli('--local', 'workflow', 'run', file, '--prompt', INPUT, '--keep-sessions-on-error', '--detach', '--json');
    expect(result.code).toBe(0);
    const { runId } = JSON.parse(result.stdout);
    let run = await finished(runId);
    expect(run.prompt).toBe(INPUT);
    expect(run.plan?.steps[0]?.prompt).toBe(`Task: ${INPUT}`);
    expect(run.plan?.keepSessionsOnError).toBe(true);
    for (const action of ['resume', 'retry']) {
      const recovered = await cli('--local', 'workflow', action, runId, file, '--detach', '--json');
      expect(recovered.stderr).toBe('');
      expect(recovered.code).toBe(0);
      run = await finished(runId);
      expect(run.prompt).toBe(INPUT);
      expect(run.plan?.keepSessionsOnError).toBe(true);
    }
  }, 20_000);

  test('daemon transports input through detached run, resume and retry', async () => {
    const base = startDaemon();
    const launch = await post(base, '/workflows/run', { file, prompt: INPUT, keepSessionsOnError: true, detach: true });
    let run = await finished(launch.runId);
    expect(run.prompt).toBe(INPUT);
    expect(run.plan?.steps[0]?.prompt).toBe(`Task: ${INPUT}`);
    expect(run.plan?.keepSessionsOnError).toBe(true);
    for (const action of ['resume', 'retry']) {
      await post(base, `/workflows/runs/${run.id}/${action}`, { detach: true });
      run = await finished(run.id);
      expect(run.prompt).toBe(INPUT);
      expect(run.plan?.keepSessionsOnError).toBe(true);
    }
    const status = await fetch(`${base}/workflows/runs/${run.id}`, { headers: { 'x-orc-secret': 'test' } });
    expect(await status.text()).not.toContain(INPUT);
  }, 20_000);

  test('foreground daemon factories retain source and original input for recovery', async () => {
    const base = startDaemon();
    const run = await post(base, '/workflows/run', { file, prompt: INPUT, keepSessionsOnError: true });
    expect(run.sourcePath).toBe(file);
    expect(run.prompt).toBe(INPUT);
    const recovered = await post(base, `/workflows/runs/${run.id}/retry`, {});
    expect(recovered.plan.steps[0].prompt).toBe(`Task: ${INPUT}`);
    expect(recovered.plan.keepSessionsOnError).toBe(true);
  });

  test('remote CLI resolves input locally and sends the expanded text to the daemon', async () => {
    startDaemon();
    const inputFile = path.join(dir, 'remote-input.txt');
    await fs.writeFile(inputFile, INPUT);
    const result = await cli('--host', `127.0.0.1:${server!.port}`, 'workflow', 'run', file,
      '--prompt', `@${inputFile}`, '--keep-sessions-on-error', '--json');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(1);
    const run = JSON.parse(result.stdout);
    expect(run.prompt).toBe(INPUT);
    expect(run.plan.steps[0].prompt).toBe(`Task: ${INPUT}`);
    expect(run.plan.keepSessionsOnError).toBe(true);
  });

  test('daemon rejects malformed invocation options', async () => {
    const base = startDaemon();
    for (const option of [{ prompt: 42 }, { keepSessionsOnError: 'yes' }]) {
      const result = await fetch(base + '/workflows/run', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-orc-secret': 'test' },
        body: JSON.stringify({ file, ...option }),
      });
      expect(result.status).toBe(400);
    }
  });
});
