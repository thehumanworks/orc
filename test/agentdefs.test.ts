import { describe, test, expect } from 'bun:test';
import { parseFrontmatter, agentDefCandidates } from '../src/agentdefs.ts';
import os from 'node:os';
import path from 'node:path';

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

  test('codex: own prompt store first (project, user), then claude fallback', () => {
    const cwd = '/repo';
    const cands = agentDefCandidates('foo', cwd, 'codex');
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    expect(cands).toEqual([
      path.join('/repo', '.codex', 'prompts', 'foo.md'),
      path.join(codexHome, 'prompts', 'foo.md'),
      path.join('/repo', '.claude', 'agents', 'foo.md'),
      path.join(os.homedir(), '.claude', 'agents', 'foo.md'),
    ]);
  });

  test('codex: honors $CODEX_HOME for the user-scope prompt dir', () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/custom/codex';
    try {
      const cands = agentDefCandidates('bar', '/repo', 'codex');
      expect(cands).toContain(path.join('/custom/codex', 'prompts', 'bar.md'));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});
