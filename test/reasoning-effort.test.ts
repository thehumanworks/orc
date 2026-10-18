import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateOptions } from '../src/agent.ts';
import { nativeResumeArgv } from '../src/provider-cli.ts';
import { validateReasoningEffort } from '../src/providers.ts';
import { buildClaudeArgv } from '../src/runtime/providers/claude.ts';
import { buildPiArgs } from '../src/runtime/providers/pi-protocol.ts';
import { validateSpawnSpec } from '../src/runtime/spec.ts';
import type { SpawnSpec } from '../src/runtime/types.ts';
import type { Provider, ReasoningEffort } from '../src/types.ts';

const base: SpawnSpec = {
  version: 1,
  sessionId: '11111111-2222-4333-8444-555555555555',
  provider: 'claude',
  cwd: '/work/repo',
  env: {},
  createdAt: '2026-10-18T00:00:00.000Z',
};
const levels: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const providers: Provider[] = ['claude', 'pi'];
const launchArgs = (spec: SpawnSpec, resume: boolean) =>
  spec.provider === 'claude' ? buildClaudeArgv(spec, resume) : buildPiArgs(spec, resume);

describe('explicit reasoning effort', () => {
  test('agent persists explicit effort in its durable spawn spec and session record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-effort-'));
    const script = `
      import { agent } from './src/agent.ts';
      import { readSpawnSpec } from './src/runtime/spec.ts';
      import { readRegistry } from './src/registry.ts';
      const results = [];
      for (const provider of ['claude', 'pi']) {
        const session = await agent({ provider, reasoningEffort: 'high', cwd: process.env.ORC_HOME });
        try {
          const record = (await readRegistry()).find((record) => record.sessionId === session.sessionId);
          results.push({ provider, spec: readSpawnSpec(session.sessionId)?.reasoningEffort, record: record?.reasoningEffort });
        } finally { await session.kill({ purge: true }); }
      }
      console.log(JSON.stringify(results));
    `;
    try {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, ORC_HOME: dir, ORC_TEST_FAKE_PROVIDER: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
      expect(JSON.parse(stdout)).toEqual([
        { provider: 'claude', spec: 'high', record: 'high' },
        { provider: 'pi', spec: 'high', record: 'high' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('validates provider-specific levels at API and persisted spec boundaries', () => {
    for (const provider of providers) {
      for (const reasoningEffort of levels) {
        const valid = provider === 'pi' || !['off', 'minimal'].includes(reasoningEffort);
        const checks = [
          () => validateReasoningEffort(provider, reasoningEffort),
          () => validateOptions({ provider, reasoningEffort }),
          () => validateSpawnSpec({ ...base, provider, reasoningEffort }),
        ];
        for (const check of checks) {
          if (valid) expect(check).not.toThrow();
          else expect(check).toThrow('reasoningEffort');
        }
      }
    }
  });

  test('passes native flags on fresh launches, runtime resumes, and interactive takeovers', () => {
    for (const provider of providers) {
      for (const reasoningEffort of levels.filter((level) => provider === 'pi' || !['off', 'minimal'].includes(level))) {
        // Serialize as spawn.json does before resuming in a different process.
        const spec: SpawnSpec = JSON.parse(JSON.stringify({ ...base, provider, reasoningEffort }));
        const flag = provider === 'claude' ? '--effort' : '--thinking';
        for (const args of [launchArgs(spec, false), launchArgs(spec, true), nativeResumeArgv(spec)]) {
          expect(args.filter((arg) => arg === flag)).toHaveLength(1);
          expect(args[args.indexOf(flag) + 1]).toBe(reasoningEffort);
        }
      }
    }
  });

  test('omission preserves provider defaults on every launch path', () => {
    for (const provider of providers) {
      const spec = { ...base, provider };
      expect(() => validateOptions({ provider })).not.toThrow();
      expect(() => validateSpawnSpec(spec)).not.toThrow();
      for (const args of [launchArgs(spec, false), launchArgs(spec, true), nativeResumeArgv(spec)]) {
        expect(args).not.toContain('--effort');
        expect(args).not.toContain('--thinking');
      }
    }
  });

  test('rejects malformed and unsupported levels instead of ignoring them', () => {
    for (const provider of providers) {
      for (const value of [null, '', 'HIGH', ' high', 'high ', 'ultra', 1, {}, ...(provider === 'claude' ? ['off', 'minimal'] : [])]) {
        const reasoningEffort = value as ReasoningEffort;
        const spec = { ...base, provider, reasoningEffort };
        expect(() => validateOptions({ provider, reasoningEffort })).toThrow('reasoningEffort');
        expect(() => validateSpawnSpec(spec)).toThrow('reasoningEffort');
        expect(() => launchArgs(spec, false)).toThrow('reasoningEffort');
        expect(() => launchArgs(spec, true)).toThrow('reasoningEffort');
        expect(() => nativeResumeArgv(spec)).toThrow('reasoningEffort');
      }
    }
  });
});
