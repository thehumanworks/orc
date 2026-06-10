/**
 * Resolve agent / persona definitions from the on-disk stores the user already keeps,
 * preferring the provider's OWN convention before cross-provider fallback:
 *
 *   - codex: project `.codex/agents/*.toml` → user `$CODEX_HOME/agents/*.toml`
 *            → project `.codex/prompts/<name>.md` → user `$CODEX_HOME/prompts/<name>.md`
 *            → then claude agent files as a fallback.
 *   - claude/pi/other: project `.claude/agents/<name>.md` → user `~/.claude/agents/<name>.md`.
 *
 * (claude itself resolves named agents natively via `--agent`; this resolver is used for
 * the non-native providers so a single `agentName` works across providers.) Files may have
 * YAML frontmatter; we use the body as the persona/system prompt.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Provider } from './types.ts';

export interface AgentDef {
  /** Bare agent name (frontmatter `name:` or filename without .md). */
  name: string;
  /** Description from frontmatter or Codex TOML, if present. */
  description?: string;
  /** Model from frontmatter or Codex TOML, if present. */
  model?: string;
  /** The prompt body (markdown body or Codex TOML developer_instructions). */
  body: string;
  /** Absolute path the def was loaded from. */
  source: string;
  /** Definition format. Only Codex TOML files carry Codex custom-agent config semantics. */
  sourceType: 'codex-toml' | 'markdown';
}

export interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse YAML frontmatter delimited by leading `---` ... `---`. Only flat
 * `key: value` scalar pairs are supported (sufficient for claude agent files).
 * If there is no frontmatter block, the whole text is the body.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  // Must start with '---' on its own line.
  if (!/^---[ \t]*\n/.test(normalized)) {
    return { frontmatter: {}, body: normalized };
  }
  const closeMatch = normalized.match(/\n---[ \t]*(?:\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: {}, body: normalized };
  }
  const fmStart = normalized.indexOf('\n') + 1;
  const fmEnd = closeMatch.index + 1; // position of the closing line's leading newline+1
  const fmBlock = normalized.slice(fmStart, closeMatch.index);
  const body = normalized.slice(closeMatch.index + closeMatch[0].length);

  const frontmatter: Record<string, string> = {};
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) frontmatter[key] = value;
  }
  // silence unused fmEnd in case of future use
  void fmEnd;
  return { frontmatter, body };
}

/** `$CODEX_HOME` (defaults to `~/.codex`), matching the codex CLI's own resolution. */
function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/**
 * Candidate file paths/globs for an agent name, project scope before user scope. When
 * `provider === 'codex'`, native custom TOML agents are searched before legacy prompt
 * markdown, and both codex stores win over the cross-provider claude fallback.
 */
export function agentDefCandidates(name: string, cwd: string, provider?: Provider): string[] {
  const claudeScopes = [
    path.join(cwd, '.claude', 'agents', `${name}.md`),
    path.join(os.homedir(), '.claude', 'agents', `${name}.md`),
  ];
  if (provider === 'codex') {
    return [
      path.join(cwd, '.codex', 'agents', '*.toml'),
      path.join(codexHome(), 'agents', '*.toml'),
      path.join(cwd, '.codex', 'prompts', `${name}.md`),
      path.join(codexHome(), 'prompts', `${name}.md`),
      ...claudeScopes,
    ];
  }
  return claudeScopes;
}

function markdownAgentDefCandidates(name: string, cwd: string, provider?: Provider): string[] {
  return agentDefCandidates(name, cwd, provider).filter((candidate) => !candidate.includes('*'));
}

async function tomlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function invalidCodexTomlError(source: string, fields: string[]): Error {
  return new Error(
    `Invalid Codex custom agent TOML at ${source}: missing or invalid required field(s): ${fields.join(', ')}`,
  );
}

function codexTomlAgentDef(parsed: Record<string, unknown>, source: string): AgentDef {
  const missing = ['name', 'description', 'developer_instructions'].filter(
    (field) => stringField(parsed[field]) === undefined,
  );
  if (missing.length > 0) throw invalidCodexTomlError(source, missing);

  return {
    name: stringField(parsed.name)!,
    description: stringField(parsed.description),
    model: stringField(parsed.model),
    body: stringField(parsed.developer_instructions)!,
    source,
    sourceType: 'codex-toml',
  };
}

async function resolveCodexTomlAgent(name: string, cwd: string): Promise<AgentDef | null> {
  const dirs = [path.join(cwd, '.codex', 'agents'), path.join(codexHome(), 'agents')];
  for (const dir of dirs) {
    for (const source of await tomlFiles(dir)) {
      const stemMatches = path.basename(source, '.toml') === name;
      let parsed: Record<string, unknown>;
      try {
        parsed = Bun.TOML.parse(await Bun.file(source).text()) as Record<string, unknown>;
      } catch (error) {
        if (stemMatches) {
          throw new Error(`Invalid Codex custom agent TOML at ${source}: ${(error as Error).message}`);
        }
        continue;
      }

      const parsedName = stringField(parsed.name);
      if (parsedName === name) return codexTomlAgentDef(parsed, source);
      if (stemMatches && parsedName === undefined) throw invalidCodexTomlError(source, ['name']);
    }
  }
  return null;
}

/** Return the effective model for a resolved definition; caller options win. */
export function effectiveAgentModel(
  callerModel: string | undefined,
  def: AgentDef | null | undefined,
  provider?: Provider,
): string | undefined {
  if (callerModel !== undefined) return callerModel;
  return provider === 'codex' && def?.sourceType === 'codex-toml' ? def.model : undefined;
}

/**
 * Resolve an agent definition by name. Returns null if no file is found in any scope.
 */
export async function resolveAgentDef(
  name: string,
  cwd: string,
  provider?: Provider,
): Promise<AgentDef | null> {
  if (provider === 'codex') {
    const tomlDef = await resolveCodexTomlAgent(name, cwd);
    if (tomlDef) return tomlDef;
  }

  for (const candidate of markdownAgentDefCandidates(name, cwd, provider)) {
    const file = Bun.file(candidate);
    if (!(await file.exists())) continue;
    const text = await file.text();
    const { frontmatter, body } = parseFrontmatter(text);
    return {
      name: frontmatter.name ?? name,
      description: frontmatter.description,
      model: frontmatter.model,
      body: body.trim(),
      source: candidate,
      sourceType: 'markdown',
    };
  }
  return null;
}
