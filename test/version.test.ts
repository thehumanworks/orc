/**
 * `orc --version` / `-V` and the shared VERSION (package.json, imported statically so a
 * compiled binary embeds it). The compiled-binary check is in compiled-cli.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../src/version.ts';
import { HELP_TEXT } from '../src/cli/output.ts';

const REPO = path.resolve(import.meta.dir, '..');
const CLI = path.join(REPO, 'src', 'cli', 'index.ts');
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-version-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function orc(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: root,
    env: { ...process.env, ORC_HOME: path.join(root, 'orc-home'), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('VERSION', () => {
  test('is the package.json version', () => {
    expect(VERSION).toBe(PKG_VERSION);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('orc --version', () => {
  test('--version and -V print `orc <version>` and exit 0', () => {
    expect(orc(['--version'])).toEqual({ code: 0, stdout: `orc ${PKG_VERSION}\n`, stderr: '' });
    expect(orc(['-V'])).toEqual({ code: 0, stdout: `orc ${PKG_VERSION}\n`, stderr: '' });
  });

  test('--json prints {version}', () => {
    const r = orc(['--version', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ version: PKG_VERSION });
  });

  test('is answered locally: never routed to a host, settings never loaded', () => {
    // Each of these makes a routed command fail: an unreachable --host, an invalid
    // ORC_HOST, an unparsable settings.toml.
    const orcHome = path.join(root, 'bad-home');
    fs.mkdirSync(orcHome, { recursive: true });
    fs.writeFileSync(path.join(orcHome, 'settings.toml'), 'host = [not toml\n');
    const env = { ORC_HOME: orcHome, ORC_HOST: 'not a host!' };
    expect(orc(['--host', 'nowhere.invalid', '--version'], env)).toEqual({ code: 0, stdout: `orc ${PKG_VERSION}\n`, stderr: '' });
    expect(orc(['-V'], env)).toEqual({ code: 0, stdout: `orc ${PKG_VERSION}\n`, stderr: '' });
  });

  test('rejects stray arguments', () => {
    const r = orc(['--version', 'extra']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("unexpected argument 'extra'");
  });

  test('help documents it', () => {
    expect(HELP_TEXT).toContain('orc --version [--json]');
    expect(HELP_TEXT).toContain('alias: -V');
  });
});
