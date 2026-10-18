/** Public selection contracts and read-only compatibility for removed Codex sessions. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agent, validateOptions, FAKE_PROVIDER_ENV } from '../src/agent.ts';
import { Session } from '../src/session.ts';
import { getSession } from '../src/index.ts';
import { readRegistry, upsertRecord } from '../src/registry.ts';
import { parseSettingsToml } from '../src/settings.ts';
import { mapSpawnRequest } from '../src/daemon/routes.ts';
import { httpStatusFor } from '../src/daemon/server.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { validateWorkflowDef, runWorkflow, resumeWorkflow, retryWorkflow } from '../src/workflow.ts';
import { launchDetachedRecovery } from '../src/workflow-runner.ts';
import { readRun } from '../src/runs.ts';
import { ensureSessionDirs, sessionPaths } from '../src/runtime/layout.ts';
import { readSpawnSpec, validateSpawnSpec } from '../src/runtime/spec.ts';
import { ensureAwake, reopen, send as kernelSend } from '../src/runtime/client.ts';
import { writeActorState, initialActorState } from '../src/runtime/actor-state.ts';
import { JournalWriter, readJournal } from '../src/runtime/journal.ts';
import { enqueue, listPending } from '../src/runtime/inbox.ts';
import type { Provider, SessionRecord } from '../src/types.ts';
import type { SpawnSpec } from '../src/runtime/types.ts';

const CLI = path.resolve(import.meta.dir, '../src/cli/index.ts');
let root: string;
const savedHome = process.env.ORC_HOME;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-integration-migration-'));
  process.env.ORC_HOME = path.join(root, 'orc');
  fs.mkdirSync(process.env.ORC_HOME);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORC_')));
  const proc = Bun.spawn([process.execPath, CLI, ...args, '--json'], {
    cwd: root, env: { ...env, ORC_HOME: process.env.ORC_HOME, NO_COLOR: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err, json: JSON.parse(out) as Record<string, unknown> };
}

describe('production provider and model selection', () => {
  test('SDK, HTTP and MCP select Pi/OpenAI and retain Claude', () => {
    const spawn = TOOLS.find((t) => t.name === 'spawn')!;
    for (const [provider, model] of [['pi', 'openai/gpt-5.5'], ['claude', 'haiku']] as const) {
      expect(() => validateOptions({ provider, model })).not.toThrow();
      expect(mapSpawnRequest({ provider, model })).toMatchObject({ provider, model });
      for (const mode of ['stdio', 'daemon'] as const) {
        expect(spawn.schema({ mode, waitTimeoutSec: 45 }).safeParse({ provider, model, cwd: root }).success).toBe(true);
        expect(spawn.schema({ mode, waitTimeoutSec: 45 }).safeParse({ provider: 'codex', model, cwd: root }).success).toBe(false);
      }
    }
    expect(() => validateOptions({ provider: 'codex' as Provider })).toThrow(/removed.*pi/);
    expect(() => mapSpawnRequest({ provider: 'codex' })).toThrow(/docs\/MIGRATION-pi\.md/);
    expect(() => validateWorkflowDef({ name: 'old', steps: [{ id: 's', provider: 'codex' as Provider, prompt: 'x' }] })).toThrow(/removed.*pi/);
  });

  test('shipped workflow examples and the agent-skill template remain executable definitions', async () => {
    for (const file of ['../orc.workflows/example.ts', '../orc.workflows/fanout-review.ts', '../skills/orc/assets/workflow-template.ts']) {
      const { default: def } = await import(path.resolve(import.meta.dir, file));
      expect(() => validateWorkflowDef(def)).not.toThrow();
    }
  });

  test('Pi named agents use the caller or Pi default model and the shared Markdown body', async () => {
    const file = path.join(root, '.claude', 'agents', 'reviewer.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: reviewer\nmodel: opus\n---\nReview every change carefully.\n');
    const previousFake = process.env[FAKE_PROVIDER_ENV];
    process.env[FAKE_PROVIDER_ENV] = '1';
    try {
      for (const model of [undefined, 'openai/gpt-5.5']) {
        const session = await agent({ provider: 'pi', model, agentName: 'reviewer', cwd: root });
        try {
          const spec = readSpawnSpec(session.sessionId)!;
          expect(spec.model).toBe(model);
          expect(spec.agentName).toBeUndefined();
          expect(spec.systemPrompt?.mode).toBe('append');
          expect(fs.readFileSync(spec.systemPrompt!.path, 'utf8')).toBe('Review every change carefully.\n');
        } finally { await session.kill({ purge: true }); }
      }
    } finally {
      if (previousFake === undefined) delete process.env[FAKE_PROVIDER_ENV];
      else process.env[FAKE_PROVIDER_ENV] = previousFake;
    }
  });

  test('invalid model values fail at SDK and HTTP boundaries before resources exist', async () => {
    for (const model of ['', ' ', 'openai/', '/gpt-5.5', 'openai//gpt-5.5', 'openai/gpt-5.5\n', 42, {}]) {
      const opts = { provider: 'pi' as const, model: model as string, cwd: root, worktree: true };
      expect(() => validateOptions(opts)).toThrow(/model/);
      expect(() => mapSpawnRequest(opts)).toThrow(/model/);
      await expect(agent(opts)).rejects.toThrow(/model/);
    }
    expect(await readRegistry()).toEqual([]);
    expect(fs.existsSync(path.join(process.env.ORC_HOME!, 'sessions'))).toBe(false);
    await expect(runWorkflow({ name: 'invalid-model', steps: [{ id: 's', provider: 'pi', prompt: 'x' }] }, {
      defaultModels: { pi: 'openai/' },
    })).rejects.toThrow(/model/);
    expect(fs.existsSync(path.join(process.env.ORC_HOME!, 'runs'))).toBe(false);
  });

  test('CLI refuses removed providers locally and remotely before reading a prompt or contacting a daemon', async () => {
    for (const prefix of [[], ['--host', '127.0.0.1:1']]) {
      const result = await cli([...prefix, 'spawn', '-p', 'codex', '--prompt', '@missing-prompt']);
      expect(result.code).toBe(1);
      expect(result.json.error).toMatch(/removed.*pi/);
      expect(result.json.error).not.toMatch(/ENOENT|connect/i);
    }
    const invalid = await cli(['spawn', '-p', 'pi', '-m', 'openai/']);
    expect(invalid.code).toBe(1);
    expect(invalid.json.error).toMatch(/model/);
    expect(await readRegistry()).toEqual([]);
  });

  test('old settings fail with explicit instructions; migrated settings select Pi', () => {
    const file = '/project/.orc/settings.toml';
    for (const text of ['provider = "codex"', '[models]\ncodex = "gpt-5.5"']) {
      expect(() => parseSettingsToml(text, file)).toThrow(file);
      expect(() => parseSettingsToml(text, file)).toThrow(/openai\/<model-id>/);
      expect(() => parseSettingsToml(text, file)).toThrow(/MIGRATION-pi/);
    }
    expect(parseSettingsToml('provider = "pi"\n[models]\npi = "openai/gpt-5.5"\nclaude = "haiku"', file).values)
      .toEqual({ provider: 'pi', models: { pi: 'openai/gpt-5.5', claude: 'haiku' } });
  });

  test('removed login/logout are actionable errors and leave old credentials byte-identical', async () => {
    const authDir = path.join(process.env.ORC_HOME!, 'auth');
    fs.mkdirSync(authDir);
    const file = path.join(authDir, 'chatgpt.json');
    const original = '{"fixture":"preserve this historical credential file"}\n';
    fs.writeFileSync(file, original, { mode: 0o600 });
    for (const args of [['login', 'chatgpt'], ['login', 'status'], ['logout', 'chatgpt']]) {
      const result = await cli(args);
      expect(result.code).toBe(1);
      expect(result.json.error).toMatch(/Pi|pi/);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
  });
});

async function oldSession(providerSessionId?: string) {
  const sid = randomUUID();
  ensureSessionDirs(sid);
  const files = sessionPaths(sid);
  const transcriptPath = path.join(files.dir, 'codex-session.jsonl');
  const systemPromptPath = path.join(files.dir, 'system-prompt.md');
  const now = new Date().toISOString();
  const transcript = [
    { type: 'session', version: 3, id: sid, timestamp: now, cwd: root },
    { type: 'message', id: 'u1', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'old question' }], timestamp: Date.now() } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: Date.now() } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(transcriptPath, transcript);
  fs.writeFileSync(systemPromptPath, 'Preserve this persona.\n');
  const spec: SpawnSpec = { version: 1, provider: 'codex', sessionId: sid, providerSessionId: providerSessionId ?? sid,
    model: 'gpt-5.5', cwd: root, env: {}, transcriptPath, systemPrompt: { mode: 'replace', path: systemPromptPath }, createdAt: now };
  // A historical fixture bypasses new-session validation, just like an on-disk upgrade.
  fs.writeFileSync(files.spawn, JSON.stringify(spec));
  writeActorState(initialActorState(sid, 'suspended'));
  const journal = JournalWriter.forSession(sid);
  journal.append({ type: 'turn.intent', messageId: 'uncertain-old', ulid: '01K00000000000000000000000', text: 'external effect may have happened' });
  journal.close();
  enqueue(sid, { kind: 'message', messageId: 'queued-old', text: 'still queued' });
  const record: SessionRecord = { id: sid.slice(0, 8), sessionId: sid, provider: 'codex', runtime: 'actor', cwd: root,
    workspace: root, transcriptPath, systemPromptPath, createdAt: now };
  await upsertRecord(record);
  return { session: new Session(record), spec, files, transcript, transcriptPath };
}

describe('historical data and continuation', () => {
  test('old records and transcripts remain readable; send/resume/wake cannot mutate or replay delivery', async () => {
    const { session, spec, files, transcript, transcriptPath } = await oldSession();
    const before = { spawn: fs.readFileSync(files.spawn, 'utf8'), journal: fs.readFileSync(files.journal, 'utf8'), pending: listPending(session.sessionId) };
    expect(await session.status()).toBe('dead');
    expect(await session.stateDetail()).toMatchObject({ state: 'failed', suspended: false, legacy: true });
    expect(await session.readParsed()).toEqual([{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }]);
    expect((await getSession(session.id))!.provider).toBe('codex');
    expect(() => validateSpawnSpec(spec)).toThrow(/removed Codex/);
    for (const action of [
      () => session.send('new work', { messageId: 'new' }),
      () => session.resume(),
      () => ensureAwake(session.sessionId),
      () => reopen(session.sessionId),
      () => kernelSend(session.sessionId, { messageId: 'new', text: 'new work' }),
    ]) {
      const error = await action().then(() => undefined, (e: unknown) => e);
      expect(error).toMatchObject({ code: 'ORC_SESSION_LEGACY' });
      expect(httpStatusFor(error)).toBe(409);
    }
    expect(fs.readFileSync(files.spawn, 'utf8')).toBe(before.spawn);
    expect(fs.readFileSync(files.journal, 'utf8')).toBe(before.journal);
    expect(listPending(session.sessionId)).toEqual(before.pending);
    expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(transcript);
    const result = await cli(['read', session.id, '--full']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('old answer');
  });

  test('takeover stops old delivery and prints a Pi command preserving the transcript and persona', async () => {
    const { session, spec, transcript, transcriptPath } = await oldSession();
    const result = await session.takeover({ graceMs: 10 });
    expect(result.command).toContain(`pi --session ${transcriptPath}`);
    expect(result.command).toContain(`--system-prompt ${spec.systemPrompt!.path}`);
    expect(result.note).toContain('cannot be handed back');
    expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(transcript);
    expect(readSpawnSpec(session.sessionId)).toEqual(spec);
    expect(listPending(session.sessionId)).toEqual([]);
    expect(readJournal(session.sessionId).filter((e) => e.type === 'turn.intent')).toHaveLength(1);
    await expect(session.resume()).rejects.toMatchObject({ code: 'ORC_SESSION_LEGACY' });
    expect((await getSession(session.id))!.toJSON().stoppedBy).toBe('takeover');
  });

  test('old workflow plans/results/defaults remain readable; resuming the removed provider never rewrites history', async () => {
    const dir = path.join(process.env.ORC_HOME!, 'runs');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'archive01.json');
    const original = JSON.stringify({ schemaVersion: 5, revision: 1, id: 'archive01', name: 'archive', startedAt: new Date().toISOString(), status: 'failed',
      defaultModels: { codex: 'gpt-5.5' }, plan: { name: 'archive', steps: [{ id: 'old', provider: 'codex', prompt: 'x' }] },
      steps: [{ id: 'old', sessionId: 'historic', provider: 'codex', state: 'failed', ok: false, commitsAhead: 0 }] });
    fs.writeFileSync(file, original);
    const run = await readRun('archive01');
    expect(run?.defaultModels).toEqual({ codex: 'gpt-5.5' });
    expect(run?.steps[0]?.provider).toBe('codex');
    expect(run?.plan?.steps[0]?.provider).toBe('codex');
    await expect(resumeWorkflow('archive01', { name: 'archive', steps: [{ id: 'old', provider: 'codex' as Provider, prompt: 'x' }] }))
      .rejects.toThrow(/removed.*pi/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  test('a Pi-only recovery definition cannot bypass historical selections or invalid new defaults', async () => {
    const dir = path.join(process.env.ORC_HOME!, 'runs');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'archive02.json');
    const def = { name: 'archive', steps: [{ id: 'old', provider: 'pi' as const, prompt: 'x' }] };
    const cases = [
      { stored: { defaultModels: { codex: 'gpt-5.5' } } },
      { stored: { plan: { name: 'archive', steps: [{ id: 'old', provider: 'codex', prompt: 'x' }] } } },
      { stored: { steps: [{ id: 'old', sessionId: 'historic', provider: 'codex', state: 'failed', ok: false, commitsAhead: 0 }] } },
      { stored: { attempts: [{ attemptId: 'old-1', attemptNumber: 1, stepId: 'old', phase: 'failed', provider: 'codex' }] } },
      { stored: {}, defaults: { pi: 'openai/' } },
    ];
    const workflowFile = path.join(root, 'pi-workflow.ts');
    fs.writeFileSync(workflowFile, `export default ${JSON.stringify(def)};\n`);
    for (const item of cases) for (const status of ['failed', 'running']) {
      const original = JSON.stringify({ schemaVersion: 5, revision: 1, id: 'archive02', name: 'archive',
        startedAt: new Date().toISOString(), status, steps: [], plan: def,
        lease: { ownerId: 'dead', pid: 2 ** 22 + 12345, updatedAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' },
        ...item.stored });
      fs.writeFileSync(file, original);
      for (const recover of [resumeWorkflow, retryWorkflow]) {
        await expect(recover('archive02', def, { defaultModels: item.defaults })).rejects.toThrow(/removed.*pi|model/);
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
      }
      // Detached recovery receives defaults only from the persisted run.
      if (!item.defaults) {
        let spawned = false;
        for (const action of ['resume', 'retry'] as const) {
          await expect(launchDetachedRecovery(action, 'archive02', def, '/abs/wf.ts', {
            spawn: () => { spawned = true; throw new Error('must not start a runner'); },
          })).rejects.toThrow(/removed.*pi/);
          expect(spawned).toBe(false);
          expect(fs.readFileSync(file, 'utf8')).toBe(original);
          for (const detach of [[], ['--detach']]) {
            const result = await cli(['workflow', action, 'archive02', workflowFile, ...detach]);
            expect(result.code).toBe(1);
            expect(result.json.error).toMatch(/removed.*pi/);
            expect(fs.readFileSync(file, 'utf8')).toBe(original);
          }
        }
      }
    }
  });
});
