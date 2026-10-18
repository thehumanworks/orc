/**
 * Shared Markdown agent definitions: project `.claude/agents/<name>.md`, then user
 * `~/.claude/agents/<name>.md`. Claude resolves native --agent itself; Pi uses this
 * reader to inject only the body as its system prompt. Provider-specific frontmatter
 * models are not silently interpreted as Pi model IDs.
 */
import os from 'node:os';
import path from 'node:path';

import type { Provider } from './types.ts';
import { assertProvider } from './providers.ts';

export interface AgentDef {
  /** Bare agent name (frontmatter `name:` or filename without .md). */
  name: string;
  /** Description from frontmatter, if present. */
  description?: string;
  /** Model from frontmatter, if present. */
  model?: string;
  /** The Markdown prompt body. */
  body: string;
  /** Absolute path the def was loaded from. */
  source: string;
  /** Definition format. */
  sourceType: 'markdown';
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

/** Project Markdown agents take precedence over user Markdown agents. */
export function agentDefCandidates(name: string, cwd: string, provider?: Provider): string[] {
  if (provider !== undefined) assertProvider(provider);
  return [
    path.join(cwd, '.claude', 'agents', `${name}.md`),
    path.join(os.homedir(), '.claude', 'agents', `${name}.md`),
  ];
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
      sourceType: 'markdown',
    };
  }
  return null;
}
