import { describe, test, expect } from 'bun:test';
import {
  effectiveAgentModel,
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

async function withCodexHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
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

  test('codex: custom TOML agents precede prompt store and claude fallback', () => {
    const cwd = '/repo';
    const cands = agentDefCandidates('foo', cwd, 'codex');
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    expect(cands).toEqual([
      path.join('/repo', '.codex', 'agents', '*.toml'),
      path.join(codexHome, 'agents', '*.toml'),
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
      expect(cands).toContain(path.join('/custom/codex', 'agents', '*.toml'));
      expect(cands).toContain(path.join('/custom/codex', 'prompts', 'bar.md'));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

describe('resolveAgentDef codex TOML agents', () => {
  test('resolves project .codex/agents/*.toml by name field when filename differs', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      await writeFile(
        path.join(cwd, '.codex', 'agents', 'review.toml'),
        `name = "reviewer"
description = "Reviews changes"
model = "gpt-5.5"
developer_instructions = "  Be strict.  "
`,
      );

      const def = await resolveAgentDef('reviewer', cwd, 'codex');
      expect(def?.name).toBe('reviewer');
      expect(def?.description).toBe('Reviews changes');
      expect(def?.model).toBe('gpt-5.5');
      expect(def?.body).toBe('Be strict.');
      expect(def?.source).toBe(path.join(cwd, '.codex', 'agents', 'review.toml'));
      expect(def?.sourceType).toBe('codex-toml');
    });
  });

  test('project TOML wins over user TOML', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      await writeFile(
        path.join(cwd, '.codex', 'agents', 'local.toml'),
        `name = "same"
description = "local"
developer_instructions = "project body"
`,
      );
      await writeFile(
        path.join(codexHome, 'agents', 'user.toml'),
        `name = "same"
description = "user"
developer_instructions = "user body"
`,
      );

      const def = await resolveAgentDef('same', cwd, 'codex');
      expect(def?.description).toBe('local');
      expect(def?.body).toBe('project body');
      expect(def?.source).toBe(path.join(cwd, '.codex', 'agents', 'local.toml'));
    });
  });

  test('$CODEX_HOME/agents is used for user-scope custom agents', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      await writeFile(
        path.join(codexHome, 'agents', 'user-only.toml'),
        `name = "user-only"
description = "from user home"
developer_instructions = "user body"
`,
      );

      const def = await resolveAgentDef('user-only', cwd, 'codex');
      expect(def?.body).toBe('user body');
      expect(def?.source).toBe(path.join(codexHome, 'agents', 'user-only.toml'));
    });
  });

  test('invalid matching TOML reports source path and missing fields', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      const source = path.join(cwd, '.codex', 'agents', 'bad.toml');
      await writeFile(
        source,
        `name = "bad"
description = "Missing instructions"
`,
      );
      await writeFile(path.join(cwd, '.codex', 'prompts', 'bad.md'), 'legacy body');

      await expect(resolveAgentDef('bad', cwd, 'codex')).rejects.toThrow(
        new RegExp(`Invalid Codex custom agent TOML at ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*developer_instructions`),
      );
    });
  });

  test('invalid filename-matching TOML missing name reports source path and does not fall back', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      const source = path.join(cwd, '.codex', 'agents', 'nameless.toml');
      await writeFile(
        source,
        `description = "Missing name"
developer_instructions = "body"
`,
      );
      await writeFile(path.join(cwd, '.codex', 'prompts', 'nameless.md'), 'legacy body');

      await expect(resolveAgentDef('nameless', cwd, 'codex')).rejects.toThrow(
        new RegExp(`Invalid Codex custom agent TOML at ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*name`),
      );
    });
  });

  test('legacy .codex/prompts/<name>.md still resolves when no TOML agent exists', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      await writeFile(path.join(cwd, '.codex', 'prompts', 'legacy.md'), 'legacy body');

      const def = await resolveAgentDef('legacy', cwd, 'codex');
      expect(def?.body).toBe('legacy body');
      expect(def?.source).toBe(path.join(cwd, '.codex', 'prompts', 'legacy.md'));
      expect(def?.sourceType).toBe('markdown');
    });
  });

  test('legacy markdown frontmatter model does not become codex effective model', async () => {
    const cwd = await tmpdir();
    const codexHome = await tmpdir();
    await withCodexHome(codexHome, async () => {
      await writeFile(
        path.join(cwd, '.codex', 'prompts', 'legacy.md'),
        `---
model: prompt-model
---
legacy body`,
      );

      const def = await resolveAgentDef('legacy', cwd, 'codex');
      expect(def?.model).toBe('prompt-model');
      expect(def?.sourceType).toBe('markdown');
      expect(effectiveAgentModel(undefined, def, 'codex')).toBeUndefined();
    });
  });
});

describe('effectiveAgentModel', () => {
  test('inherits codex TOML model when caller omitted --model', () => {
    expect(
      effectiveAgentModel(undefined, {
        name: 'reviewer',
        description: 'Reviews changes',
        model: 'gpt-5.5',
        body: 'Be strict.',
        source: '/repo/.codex/agents/review.toml',
        sourceType: 'codex-toml',
      }, 'codex'),
    ).toBe('gpt-5.5');
  });

  test('caller --model takes precedence over codex TOML model', () => {
    expect(
      effectiveAgentModel('explicit-model', {
        name: 'reviewer',
        description: 'Reviews changes',
        model: 'gpt-5.5',
        body: 'Be strict.',
        source: '/repo/.codex/agents/review.toml',
        sourceType: 'codex-toml',
      }, 'codex'),
    ).toBe('explicit-model');
  });

  test('does not inherit non-codex agent model', () => {
    expect(
      effectiveAgentModel(undefined, {
        name: 'reviewer',
        model: 'opus',
        body: 'Be strict.',
        source: '/repo/.claude/agents/review.md',
        sourceType: 'markdown',
      }, 'pi'),
    ).toBeUndefined();
  });
});
