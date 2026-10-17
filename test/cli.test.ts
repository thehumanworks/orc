import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSelectionFromFlags, resolveCommand } from '../src/cli/index.ts';
import { HELP_TEXT } from '../src/cli/output.ts';
import { plainCliEnv } from './runtime-helpers.ts';

describe('resolveCommand routing', () => {
  test('spawn aliases', () => {
    expect(resolveCommand('spawn')).toBe('spawn');
    expect(resolveCommand('agent')).toBe('spawn');
    expect(resolveCommand('new')).toBe('spawn');
  });
  test('list alias ps', () => {
    expect(resolveCommand('list')).toBe('list');
    expect(resolveCommand('ps')).toBe('list');
  });
  test('direct commands', () => {
    expect(resolveCommand('send')).toBe('send');
    expect(resolveCommand('read')).toBe('read');
    expect(resolveCommand('attach')).toBe('attach');
    expect(resolveCommand('kill')).toBe('kill');
    expect(resolveCommand('settings')).toBe('settings');
  });
  test('help fallbacks', () => {
    expect(resolveCommand(undefined)).toBe('help');
    expect(resolveCommand('help')).toBe('help');
    expect(resolveCommand('--help')).toBe('help');
    expect(resolveCommand('-h')).toBe('help');
  });
  test('unknown command', () => {
    expect(resolveCommand('frobnicate')).toBe('unknown');
  });
});

describe('readSelectionFromFlags', () => {
  test('defaults to latest and accepts explicit modes', () => {
    expect(readSelectionFromFlags({})).toEqual({ mode: 'latest' });
    expect(readSelectionFromFlags({ last: true })).toEqual({ mode: 'latest' });
    expect(readSelectionFromFlags({ full: true })).toEqual({ mode: 'full' });
    expect(readSelectionFromFlags({ index: '2' })).toEqual({ mode: 'index', index: 2 });
  });

  test('rejects invalid and conflicting selections', () => {
    expect(() => readSelectionFromFlags({ index: '-1' })).toThrow(/invalid --index/);
    expect(() => readSelectionFromFlags({ index: '1.2' })).toThrow(/invalid --index/);
    expect(() => readSelectionFromFlags({ full: true, index: '0' })).toThrow(/mutually exclusive/);
    expect(() => readSelectionFromFlags({ raw: true, full: true })).toThrow(/--raw cannot/);
  });
});

describe('settings CLI surface', () => {
  test('help documents orc settings, --local, ORC_HOST and the precedence', () => {
    expect(HELP_TEXT).toMatch(/orc settings \[--json\]/);
    expect(HELP_TEXT).toContain('--local');
    expect(HELP_TEXT).toContain('host:     --local > --host > ORC_HOST');
    expect(HELP_TEXT).toContain('.orc/settings.toml');
    expect(HELP_TEXT).toContain('trusted peer');
  });
});

describe('send CLI surface', () => {
  test('help documents --idempotency-key without changing positional prompt syntax', () => {
    expect(HELP_TEXT).toContain('--idempotency-key');
    expect(HELP_TEXT).toMatch(/orc send\s+<id\|@alias>\s+\[PROMPT/);
  });
});

describe('workflow control CLI surface', () => {
  test('help documents resume/retry/cancel/cleanup', () => {
    expect(HELP_TEXT).toContain('workflow resume');
    expect(HELP_TEXT).toContain('workflow retry');
    expect(HELP_TEXT).toContain('workflow cancel');
    expect(HELP_TEXT).toContain('workflow cleanup');
    expect(HELP_TEXT).toContain('--cascade');
  });

  test('help documents list --run', () => {
    expect(HELP_TEXT).toMatch(/--run/);
  });

  test('help documents --max-concurrency', () => {
    expect(HELP_TEXT).toContain('--max-concurrency');
  });
});

describe('max-concurrency CLI validation', () => {
  test('normalizeMaxConcurrency rejects bad values used by CLI', async () => {
    const { normalizeMaxConcurrency, GraphValidationError } = await import('../src/workflow-scheduler.ts');
    expect(() => normalizeMaxConcurrency(0)).toThrow(GraphValidationError);
    expect(() => normalizeMaxConcurrency(-3)).toThrow(/positive integer/);
    expect(() => normalizeMaxConcurrency(1.2)).toThrow(/positive integer/);
    expect(normalizeMaxConcurrency(4)).toBe(4);
  });

  test('publicRunView exposes maxConcurrency and omits plan prompts', async () => {
    const { publicRunView } = await import('../src/cli/output.ts');
    const view = publicRunView({
      id: 'r1',
      name: 'n',
      status: 'done',
      startedAt: new Date().toISOString(),
      steps: [],
      plan: {
        name: 'n',
        maxConcurrency: 3,
        steps: [
          { id: 'a', provider: 'claude', prompt: 'SECRET_PROMPT_DO_NOT_LEAK', needs: [] },
          { id: 'b', provider: 'codex', needs: ['a'] },
        ],
      },
      attempts: [],
    });
    expect(view.maxConcurrency).toBe(3);
    expect(view.scheduling).toBeDefined();
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain('SECRET_PROMPT_DO_NOT_LEAK');
    expect(view).not.toHaveProperty('plan');
  });
});

describe('errors that escape a command (option parsing)', () => {
  const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
  async function orc(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-cli-parse-'));
    try {
      const proc = Bun.spawn([process.execPath, CLI, ...args], {
        cwd: home,
        env: plainCliEnv({ ...process.env, ORC_HOME: home, ORC_HOST: '' }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  test('with --json: the {"error"} document on stdout, exit 1; without: fatal: on stderr', async () => {
    const json = await orc(['list', '--bogus', '--json']);
    expect(json.code).toBe(1);
    expect(json.err).toBe('');
    expect(JSON.parse(json.out).error).toContain("Unknown option '--bogus'");
    const human = await orc(['list', '--bogus']);
    expect(human.code).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toMatch(/^fatal: Unknown option '--bogus'/);
    // A host-local command too.
    const settings = await orc(['settings', '--json', '--nope']);
    expect(settings.code).toBe(1);
    expect(JSON.parse(settings.out).error).toContain("Unknown option '--nope'");
  }, 30_000);
});
