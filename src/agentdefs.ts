/**
 * Resolve agent / persona definitions from the on-disk stores the user already keeps,
 * preferring the provider's OWN convention before cross-provider fallback:
 *
 *   - codex: project `.codex/prompts/<name>.md` → user `$CODEX_HOME/prompts/<name>.md`
 *            (codex's native custom-prompt store) → then claude agent files as a fallback.
 *   - claude/pi/other: project `.claude/agents/<name>.md` → user `~/.claude/agents/<name>.md`.
 *
 * (claude itself resolves named agents natively via `--agent`; this resolver is used for
 * the non-native providers so a single `agentName` works across providers.) Files may have
 * YAML frontmatter; we use the body as the persona/system prompt.
 */
import os from 'node:os';
import path from 'node:path';

import type { Provider } from './types.ts';

export interface AgentDef {
  /** Bare agent name (frontmatter `name:` or filename without .md). */
  name: string;
  /** Frontmatter description, if present. */
  description?: string;
  /** Frontmatter model, if present. */
  model?: string;
  /** The markdown body (everything after the closing frontmatter delimiter). */
  body: string;
  /** Absolute path the def was loaded from. */
  source: string;
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
 * Candidate file paths for an agent name, project scope before user scope. When
 * `provider === 'codex'`, codex's native custom-prompt store is searched first so a
 * codex-scoped definition (local or user) wins over the cross-provider claude fallback.
 */
export function agentDefCandidates(name: string, cwd: string, provider?: Provider): string[] {
  const claudeScopes = [
    path.join(cwd, '.claude', 'agents', `${name}.md`),
    path.join(os.homedir(), '.claude', 'agents', `${name}.md`),
  ];
  if (provider === 'codex') {
    return [
      path.join(cwd, '.codex', 'prompts', `${name}.md`),
      path.join(codexHome(), 'prompts', `${name}.md`),
      ...claudeScopes,
    ];
  }
  return claudeScopes;
}

/**
 * Resolve an agent definition by name. Returns null if no file is found in any scope.
 */
export async function resolveAgentDef(
  name: string,
  cwd: string,
  provider?: Provider,
): Promise<AgentDef | null> {
  for (const candidate of agentDefCandidates(name, cwd, provider)) {
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
    };
  }
  return null;
}
