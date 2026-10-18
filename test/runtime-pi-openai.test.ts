/**
 * Real Pi CLI + its built-in OpenAI provider and tool loop, with a local Responses API.
 * Credentials are synthetic; this is a transport/auth contract, not live OpenAI evidence.
 * No ORC harness, auth implementation or pi-ai dependency is used by this test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiRuntime } from '../src/runtime/providers/pi.ts';
import { PI_VERIFIED_VERSION } from '../src/runtime/providers/pi-protocol.ts';
import { nativeResumeArgv } from '../src/provider-cli.ts';
import { processStartTime, terminateProcessGroup } from '../src/runtime/process.ts';
import type { ProviderEvent, ProviderLaunch, ProviderRuntime } from '../src/runtime/types.ts';

const piBin = process.env.ORC_TEST_PI_BIN ?? Bun.which('pi');
const suite = piBin ? describe : describe.skip;
if (!piBin) test.skip('Pi OpenAI contract: install Pi 1.2.0 and set ORC_TEST_PI_BIN', () => {});

let root = '';
const runtimes: ProviderRuntime[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const factory = createPiRuntime({ bin: piBin ?? 'pi', bootTimeoutMs: 15_000 });

interface ApiRequest {
  path: string;
  authorization: string | null;
  body: { model?: string; input?: Array<Record<string, unknown>>; tools?: Array<{ name?: string }> };
}

/** Minimal Responses SSE consumed by Pi's actual OpenAI transport. */
function responseSse(tool: boolean): string {
  const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
  const itemId = `${tool ? 'fc' : 'msg'}_${crypto.randomUUID().replaceAll('-', '')}`;
  const text = 'PI_OPENAI_OK';
  const item = tool
    ? { type: 'function_call', id: itemId, call_id: 'call_write', name: 'write',
        arguments: JSON.stringify({ path: 'written-by-pi.txt', content: 'Pi executed the tool.\n' }), status: 'completed' }
    : { type: 'message', id: itemId, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0,
      item: tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } },
  ];
  if (tool) {
    events.push(
      { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: 0, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: itemId, output_index: 0, arguments: item.arguments },
    );
  } else {
    events.push(
      { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text },
    );
  }
  events.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  );
  return events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
}

function setup(options: { auth: 'env' | 'oauth' | 'none'; tool?: boolean; model?: string }): {
  launch: ProviderLaunch; requests: ApiRequest[]; dir: string; agentDir: string;
} {
  const dir = fs.mkdtempSync(path.join(root, `${options.auth}-`));
  const agentDir = path.join(dir, 'pi-agent');
  const home = path.join(dir, 'home');
  fs.mkdirSync(agentDir, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const requests: ApiRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname;
      if (route !== '/v1/responses' || request.method !== 'POST') {
        return new Response('Unexpected route in isolated Pi contract', { status: 404 });
      }
      const body = await request.json() as ApiRequest['body'];
      requests.push({ path: route, authorization: request.headers.get('authorization'), body });
      const hasToolResult = body.input?.some((item) => item.type === 'function_call_output');
      return new Response(responseSse(!!options.tool && !hasToolResult), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  servers.push(server);
  // Override only the endpoint. Pi retains its built-in OpenAI catalog, authentication
  // and Responses transport. The mock never learns real credentials.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openai: { baseUrl: `http://127.0.0.1:${server.port}/v1` } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    retry: { enabled: false }, quietStartup: true,
  }), { mode: 0o600 });
  if (options.auth === 'oauth') {
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
      openai: { type: 'oauth', access: 'pi-contract-oauth-access', refresh: 'pi-contract-oauth-refresh',
        expires: Date.now() + 3_600_000, clientId: 'pi-contract-client', scopes: ['chatgpt.tokens.use.direct'] },
    }), { mode: 0o600 });
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1',
  };
  if (options.auth !== 'none') env.OPENAI_API_KEY = 'sk-pi-contract-env';
  const sessionId = crypto.randomUUID();
  return { dir, agentDir, requests, launch: {
    spec: { version: 1, sessionId, provider: 'pi', cwd: dir,
      model: options.model ?? 'openai/gpt-5.5', sessionDir: path.join(dir, 'sessions'),
      env: {}, createdAt: new Date().toISOString() },
    resume: false, env, rawLogPath: path.join(dir, 'provider.jsonl'),
  } };
}

async function complete(launch: ProviderLaunch): Promise<ProviderEvent[]> {
  const runtime = await factory.start(launch);
  runtimes.push(runtime);
  const events: ProviderEvent[] = [];
  const settled = (async () => {
    for await (const event of runtime.events()) {
      events.push(event);
      if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted') return;
    }
  })();
  await runtime.send('openai-turn', 'Write the requested file if asked by the tool response, then reply PI_OPENAI_OK.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([settled, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pi OpenAI turn did not settle')), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
    await runtime.close();
  }
  expect(events.find((event) => event.type === 'ready')).toMatchObject({
    info: { model: 'openai/gpt-5.5', version: PI_VERIFIED_VERSION },
  });
  expect(events.at(-1)).toMatchObject({ type: 'turn.completed', result: 'PI_OPENAI_OK' });
  return events;
}

/** Keep cleanup bounded while allowing Bun to reap a child that is already exiting. */
async function settlesWithin(pending: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-pi-openai-'))); });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close({ graceMs: 500 })));
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

suite('OpenAI through the actual Pi integration', () => {
  test('OPENAI_API_KEY selects the model and Pi executes its own write tool', async () => {
    const s = setup({ auth: 'env', tool: true });
    await complete(s.launch);
    expect(s.requests).toHaveLength(2);
    expect(s.requests.every((r) => r.authorization === 'Bearer sk-pi-contract-env' && r.body.model === 'gpt-5.5')).toBe(true);
    expect(s.requests[0]?.body.tools?.some((tool) => tool.name === 'write')).toBe(true);
    expect(s.requests[1]?.body.input?.some((item) => item.type === 'function_call_output')).toBe(true);
    expect(fs.readFileSync(path.join(s.dir, 'written-by-pi.txt'), 'utf8')).toBe('Pi executed the tool.\n');
  }, 25_000);

  test('Pi stored ChatGPT OAuth credential takes precedence over OPENAI_API_KEY', async () => {
    const s = setup({ auth: 'oauth' });
    await complete(s.launch);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.authorization).toBe('Bearer pi-contract-oauth-access');
    expect(s.requests[0]?.body.model).toBe('gpt-5.5');
    expect(fs.existsSync(path.join(s.dir, 'auth', 'chatgpt.json'))).toBe(false);
  }, 25_000);

  test('unknown or unauthenticated qualified selections fail before an API request', async () => {
    for (const options of [{ auth: 'env', model: 'openai/orc-nonexistent-model' },
                           { auth: 'none', model: 'openai/gpt-5.5' }] as const) {
      const s = setup(options);
      await expect(factory.start(s.launch)).rejects.toThrow(/not available in Pi's authenticated model list/);
      expect(s.requests).toHaveLength(0);
      expect(fs.readFileSync(s.launch.rawLogPath, 'utf8')).not.toContain('"type":"prompt"');
    }
  }, 25_000);

  for (const branch of ['linear', 'branched'] as const) {
    test(`historical harness v3 ${branch} transcript continues in native Pi with its history, model and persona`, async () => {
      const s = setup({ auth: 'env' });
      const sessionId = s.launch.spec.sessionId;
      const now = new Date().toISOString();
      const transcriptPath = path.join(s.dir, 'codex-session.jsonl');
      const persona = path.join(s.dir, 'system-prompt.md');
      fs.writeFileSync(persona, 'Preserve the archived reviewer persona.');
      // The former harness wrote a linear Pi v3 session with explicit model/thinking
      // changes and Pi message records. No removed writer is needed to read this fixture.
      const entries: Array<Record<string, unknown>> = [
        { type: 'session', version: 3, id: sessionId, timestamp: now, cwd: s.dir },
        { type: 'model_change', id: 'model0', parentId: null, timestamp: now, provider: 'openai', modelId: 'gpt-5.5' },
        { type: 'thinking_level_change', id: 'thinking0', parentId: 'model0', timestamp: now, thinkingLevel: 'off' },
        { type: 'message', id: 'system0', parentId: 'thinking0', timestamp: now,
          message: { role: 'system', content: 'Preserve the archived reviewer persona.', tools: [], timestamp: Date.now() } },
        { type: 'message', id: 'user0', parentId: 'system0', timestamp: now,
          message: { role: 'user', content: [{ type: 'text', text: 'Remember the archived codeword PINEAPPLE.' }], timestamp: Date.now() } },
        { type: 'message', id: 'assistant0', parentId: 'user0', timestamp: now,
          message: { role: 'assistant', content: [{ type: 'text', text: 'The old Codex answer remembered PINEAPPLE.' }],
            api: 'openai-responses', provider: 'openai', model: 'gpt-5.5', stopReason: 'stop', timestamp: Date.now(),
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      ];
      if (branch === 'branched') {
        entries.push(
          { type: 'model_change', id: 'inactive-model', parentId: 'assistant0', timestamp: now, provider: 'anthropic', modelId: 'claude-other' },
          { type: 'message', id: 'inactive-user', parentId: 'inactive-model', timestamp: now,
            message: { role: 'user', content: [{ type: 'text', text: 'Discarded branch content must not be replayed.' }], timestamp: Date.now() } },
          { type: 'message', id: 'active-user', parentId: 'assistant0', timestamp: now,
            message: { role: 'user', content: [{ type: 'text', text: 'Continue only the selected OpenAI branch.' }], timestamp: Date.now() } },
        );
      }
      fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const argv = nativeResumeArgv({ ...s.launch.spec, provider: 'codex', providerSessionId: sessionId,
        model: 'stale-record-model', transcriptPath, systemPrompt: { mode: 'replace', path: persona } });
      expect(argv).toContain('--session');
      expect(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 4)).toEqual(['--provider', 'openai', '--model', 'gpt-5.5']);
      const proc = Bun.spawn([piBin!, ...argv.slice(1), '--mode', 'rpc', '-a'], {
        cwd: s.dir, env: s.launch.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true,
      });
      const identity = { pid: proc.pid, startTime: processStartTime(proc.pid) };
      const stderr = new Response(proc.stderr).text();
      const records: Array<Record<string, unknown>> = [];
      const pump = (async () => {
        const decoder = new TextDecoder();
        let buffered = '';
        for await (const chunk of proc.stdout) {
          buffered += decoder.decode(chunk, { stream: true });
          for (;;) {
            const end = buffered.indexOf('\n');
            if (end < 0) break;
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            try { records.push(JSON.parse(line)); } catch { /* Pi diagnostics are not RPC records. */ }
          }
        }
      })();
      const waitFor = async (predicate: (record: Record<string, unknown>) => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!records.some(predicate)) {
          if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`native Pi exited: ${await stderr}`);
          if (Date.now() > deadline) throw new Error('native Pi continuation RPC timed out');
          await Bun.sleep(10);
        }
        return records.find(predicate)!;
      };
      try {
        proc.stdin.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
        await proc.stdin.flush();
        const state = await waitFor((record) => record.id === 'state');
        expect(state).toMatchObject({ success: true, data: {
          sessionId, sessionFile: transcriptPath, model: { provider: 'openai', id: 'gpt-5.5' },
        } });
        proc.stdin.write(JSON.stringify({ id: 'continue', type: 'prompt', message: 'Continue from the archived conversation.' }) + '\n');
        await proc.stdin.flush();
        await waitFor((record) => record.type === 'agent_settled');
        expect(s.requests).toHaveLength(1);
        const input = JSON.stringify(s.requests[0]?.body.input);
        expect(input).toContain('Preserve the archived reviewer persona.');
        expect(input).toContain('Remember the archived codeword PINEAPPLE.');
        expect(input).toContain('The old Codex answer remembered PINEAPPLE.');
        expect(input).toContain('Continue from the archived conversation.');
        if (branch === 'branched') {
          expect(input).toContain('Continue only the selected OpenAI branch.');
          expect(input).not.toContain('Discarded branch content must not be replayed.');
        }
        const retained = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(retained.slice(0, entries.length)).toEqual(entries);
      } finally {
        await proc.stdin.end();
        // EOF makes Pi exit. On macOS a process in its exiting state can still pass
        // the liveness probe but reject group signals with EPERM before Bun reaps it.
        // Allow that exit to finish; real termination errors still fail this test.
        if (!(await settlesWithin(proc.exited, 1_000))) {
          await terminateProcessGroup(identity, 1_000);
        }
        if (!(await settlesWithin(Promise.all([proc.exited, pump, stderr]), 3_000))) {
          throw new Error('native Pi cleanup did not finish');
        }
      }
    }, 25_000);
  }
});
