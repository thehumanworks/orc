import { describe, test, expect } from 'bun:test';
import {
  parseFrontmatter,
  agentDefCandidates,
  resolveAgentDef,
} from '../src/agentdefs.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orc-agentdefs-'));
}

async function writeFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe('parseFrontmatter', () => {
  test('parses flat frontmatter and body', () => {
    const text = `---
name: codebase-recon
description: maps a repo
model: opus
color: red
---
You are a recon agent.
Find things.`;
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('codebase-recon');
    expect(frontmatter.description).toBe('maps a repo');
    expect(frontmatter.model).toBe('opus');
    expect(body.trim()).toBe('You are a recon agent.\nFind things.');
  });

  test('strips surrounding quotes', () => {
    const text = `---
name: "quoted-name"
description: 'single'
---
body`;
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('quoted-name');
    expect(frontmatter.description).toBe('single');
  });

  test('no frontmatter => whole text is body', () => {
    const text = 'just a body, no frontmatter';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe(text);
  });

  test('handles CRLF', () => {
    const text = '---\r\nname: x\r\n---\r\nbody here';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('x');
    expect(body.trim()).toBe('body here');
  });

  test('ignores comment lines and blanks', () => {
    const text = `---
# a comment
name: y

model: sonnet
---
b`;
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('y');
    expect(frontmatter.model).toBe('sonnet');
    expect(frontmatter['# a comment']).toBeUndefined();
  });
});

describe('agentDefCandidates', () => {
  test('default (claude/pi): project scope first, then user scope', () => {
    const cwd = '/repo';
    const cands = agentDefCandidates('foo', cwd);
    expect(cands).toEqual([
      path.join('/repo', '.claude', 'agents', 'foo.md'),
      path.join(os.homedir(), '.claude', 'agents', 'foo.md'),
    ]);
  });

});

describe('Pi and Claude Markdown agents', () => {
  test('Pi resolves the same project Markdown body and retains frontmatter as metadata', async () => {
    const cwd = await tmpdir();
    try {
      const source = path.join(cwd, '.claude', 'agents', 'reviewer.md');
      await writeFile(source, '---\nname: reviewer\ndescription: Reviews changes\nmodel: opus\n---\nBe strict.\n');
      const def = await resolveAgentDef('reviewer', cwd, 'pi');
      expect(def).toEqual({ name: 'reviewer', description: 'Reviews changes', model: 'opus', body: 'Be strict.', source, sourceType: 'markdown' });
      expect(agentDefCandidates('reviewer', cwd, 'pi')).toEqual(agentDefCandidates('reviewer', cwd, 'claude'));
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });

  test('removed Codex agent selections fail with migration guidance', async () => {
    expect(() => agentDefCandidates('x', '/repo', 'codex' as never)).toThrow(/removed.*Pi|removed.*pi/);
    await expect(resolveAgentDef('x', '/repo', 'codex' as never)).rejects.toThrow(/removed/);
  });
});
