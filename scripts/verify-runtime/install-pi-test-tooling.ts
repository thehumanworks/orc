#!/usr/bin/env bun
/**
 * Install the real Pi CLI for offline protocol/model/auth contract tests, outside ORC's
 * dependency graph. Pi's sibling dependencies use caret ranges upstream; override them
 * together so a nominal CLI version cannot silently test a mixed Pi release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PI_VERIFIED_VERSION } from '../../src/runtime/providers/pi-protocol.ts';

const target = process.argv[2];
if (!target) throw new Error('usage: bun scripts/verify-runtime/install-pi-test-tooling.ts <isolated-directory>');
const directory = path.resolve(target);
const repo = path.resolve(import.meta.dir, '../..');
if (directory === repo || directory.startsWith(`${repo}${path.sep}`)) {
  throw new Error('Pi contract-test tooling must be installed outside the ORC checkout');
}
fs.mkdirSync(directory, { recursive: true });
const siblings = ['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-mcp', 'pi-telemetry', 'pi-tui'];
const overrides = Object.fromEntries(siblings.map((name) => [`@earendil-works/${name}`, PI_VERIFIED_VERSION]));
fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({
  name: 'orc-pi-contract-tooling',
  private: true,
  dependencies: { '@earendil-works/pi-coding-agent': PI_VERIFIED_VERSION },
  overrides,
}, null, 2)}\n`);

const installed = Bun.spawnSync([process.execPath, 'install', '--ignore-scripts'], {
  cwd: directory, stdout: 'pipe', stderr: 'pipe',
});
if (installed.exitCode !== 0) throw new Error(`Pi test-runtime install failed: ${installed.stderr.toString()}`);
// Check all declared Pi packages, resolving from the CLI to include nested installations.
const cliManifest = path.join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
const manifest = JSON.parse(fs.readFileSync(cliManifest, 'utf8')) as { version: string };
if (manifest.version !== PI_VERIFIED_VERSION) throw new Error(`unexpected Pi CLI version ${manifest.version}`);
for (const name of siblings) {
  const file = Bun.resolveSync(`@earendil-works/${name}/package.json`, path.dirname(cliManifest));
  const dependency = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string };
  if (dependency.version !== PI_VERIFIED_VERSION) throw new Error(`mixed Pi release: ${name} ${dependency.version}`);
}
process.stdout.write(`${JSON.stringify({ version: PI_VERIFIED_VERSION, binary: path.join(directory, 'node_modules', '.bin', 'pi') })}\n`);
