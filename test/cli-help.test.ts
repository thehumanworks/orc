import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plainCliEnv } from './runtime-helpers.ts';
import { stripAnsi } from '../src/style.ts';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const DEAD_HOST = '127.0.0.1:1';

async function orc(args: string[], poisonSettings = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-cli-help-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  if (poisonSettings) {
    fs.writeFileSync(path.join(home, 'settings.toml'), 'invalid = [');
    fs.mkdirSync(path.join(cwd, '.orc'));
    fs.writeFileSync(path.join(cwd, '.orc', 'settings.toml'), 'invalid = [');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  try {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      cwd,
      env: plainCliEnv({ ...env, ORC_HOME: home, ORC_HOST: DEAD_HOST }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectHelp(result: Awaited<ReturnType<typeof orc>>, usage: RegExp) {
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toMatch(usage);
}

describe('command-specific help', () => {
  test('every standalone command supports short help without side effects', async () => {
    for (const command of [
      'spawn', 'send', 'read', 'state', 'wait', 'list', 'attach', 'kill',
      'resume', 'takeover', 'prune', 'daemon', 'settings', 'mcp',
    ]) {
      const result = await orc([command, '-h'], true);
      expectHelp(result, new RegExp(`orc ${command}\\s`));
      expect(result.out).toContain('--help');
      expect(result.out).toContain('Usage:');
      if (command !== 'spawn') expect(result.out).not.toMatch(/orc spawn\s/);
    }
  });

  test('forced-color focused help preserves the same text', async () => {
    const plain = await orc(['spawn', '--help'], true);
    const colored = await orc(['spawn', '--help', '--color=always'], true);
    expect(colored.code).toBe(0);
    expect(colored.err).toBe('');
    expect(colored.out).toContain('\x1b[');
    expect(stripAnsi(colored.out)).toBe(plain.out);
  });

  test('spawn help is focused and accepts both help flags before loading settings', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await orc(['spawn', flag], true);
      expectHelp(result, /orc spawn\s/);
      expect(result.out).toContain('--provider');
      expect(result.out).toContain('--prompt');
      expect(result.out).toContain('--worktree');
      expect(result.out).not.toMatch(/orc workflow run/);
      expect(result.out).not.toMatch(/orc remote add/);
    }
  });

  test('top-level help also bypasses malformed settings and the default host', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      expectHelp(await orc(args, true), /orc spawn\s/);
    }
  });

  test('explicit host and ordinary command options do not prevent local help', async () => {
    for (const args of [
      ['--host', DEAD_HOST, 'spawn', '--help'],
      ['spawn', '--host', DEAD_HOST, '--help'],
      ['spawn', '--provider', 'codex', '--prompt', 'hello', '--help'],
    ]) {
      expectHelp(await orc(args, true), /orc spawn\s/);
    }
  });

  test('command aliases render the same help as their canonical commands', async () => {
    for (const [canonical, aliases] of [
      ['spawn', ['new', 'agent']],
      ['list', ['ps']],
      ['workflow', ['wf']],
    ] as const) {
      const expected = await orc([canonical, '--help'], true);
      expect(expected.code).toBe(0);
      for (const alias of aliases) {
        const actual = await orc([alias, '-h'], true);
        expect(actual).toEqual(expected);
      }
    }
  });

  test('command groups show their own subcommands', async () => {
    for (const [group, subcommands] of [
      ['workflow', ['run', 'list', 'status', 'attach', 'logs', 'resume', 'retry', 'cancel', 'cleanup']],
      ['remote', ['add', 'list', 'rm']],
      ['login', ['chatgpt', 'status']],
      ['logout', ['chatgpt']],
    ] as const) {
      const result = await orc([group, '--help'], true);
      expectHelp(result, new RegExp(`orc ${group}\\s`));
      for (const subcommand of subcommands) expect(result.out).toContain(subcommand);
      expect(result.out).not.toMatch(/orc spawn\s/);
    }
  });

  test('leaf subcommands show focused usage without executing the command', async () => {
    for (const [group, subcommands] of [
      ['workflow', ['run', 'list', 'status', 'attach', 'logs', 'resume', 'retry', 'cancel', 'cleanup']],
      ['remote', ['add', 'list', 'rm']],
      ['login', ['chatgpt', 'status']],
      ['logout', ['chatgpt']],
    ] as const) {
      for (const subcommand of subcommands) {
        const result = await orc([group, subcommand, '--help'], true);
        expectHelp(result, new RegExp(`orc ${group} ${subcommand}\\b`));
        expect(result.out).not.toMatch(/orc spawn\s/);
      }
    }
    expectHelp(await orc(['wf', 'run', '-h'], true), /orc workflow run\b/);
    expect(await orc(['remote', 'remove', '--help'], true)).toEqual(
      await orc(['remote', 'rm', '--help'], true),
    );
  });

  test('help-like string values remain command arguments', async () => {
    for (const args of [
      ['spawn', '--prompt', '--help'],
      ['spawn', '--prompt=--help'],
      ['spawn', '--prompt', '-h'],
      ['workflow', 'run', '--run-id', '--help'],
    ]) {
      // Missing provider/file must fail normally, never print help or start an agent.
      const result = await orc(['--local', ...args]);
      expect(result.code).not.toBe(0);
      expect(result.out).not.toMatch(/Usage:/i);
      expect(result.err).not.toBe('');
    }
  });

  test('the option terminator makes help a positional value', async () => {
    const result = await orc(['--local', 'read', '--', '--help']);
    expect(result.code).not.toBe(0);
    expect(result.out).not.toMatch(/Usage:/i);
    expect(result.err).not.toBe('');
  });

  test('unknown commands and subcommands remain errors even with a help flag', async () => {
    for (const args of [
      ['no-such-command', '--help'],
      ['workflow', 'no-such-subcommand', '--help'],
      ['workflow', 'constructor', '--help'],
      ['remote', 'no-such-subcommand', '-h'],
      ['login', 'no-such-subcommand', '--help'],
      ['logout', 'no-such-subcommand', '--help'],
    ]) {
      const result = await orc(args);
      expect(result.code).not.toBe(0);
      expect(result.err).not.toBe('');
    }
  });
});
