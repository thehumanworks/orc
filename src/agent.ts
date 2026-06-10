/**
 * agent() — the core primitive. Validates options, resolves system prompt / agent
 * body, optionally creates a worktree, spawns the provider TUI in a detached driver
 * session, boots it (auto-confirm trust dialogs, wait for ready), then optionally
 * sends the initial prompt.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getDriver } from './drivers/driver.ts';
import { sanitizeTmuxName } from './drivers/tmux.ts';
import { getProvider } from './providers/provider.ts';
import type { BuildCtx } from './providers/provider.ts';
import { effectiveAgentModel, resolveAgentDef } from './agentdefs.ts';
import { createWorktree, gitToplevel, isInsideGitRepo, removeWorktree } from './worktree.ts';
import { removeRecord, reserveRecord, upsertRecord, validateAlias } from './registry.ts';
import { piSessionDir } from './paths.ts';
import { Session } from './session.ts';
import type { AgentOptions, Provider, SessionRecord, SystemPromptMode } from './types.ts';

const VALID_PROVIDERS: Provider[] = ['claude', 'codex', 'pi'];

/** Validate options and throw on invalid combinations. */
export function validateOptions(opts: AgentOptions): void {
  if (!opts.provider) {
    throw new Error('provider is required (claude|codex|pi)');
  }
  if (!VALID_PROVIDERS.includes(opts.provider)) {
    throw new Error(`invalid provider '${opts.provider}' (expected claude|codex|pi)`);
  }
  if (opts.agentName && opts.systemPrompt) {
    throw new Error('agentName and systemPrompt are mutually exclusive — pass only one');
  }
  validateAlias(opts.alias);
}

export async function agent(opts: AgentOptions): Promise<Session> {
  validateOptions(opts);

  const provider = opts.provider;
  const adapter = getProvider(provider);
  const driver = getDriver(opts.driver ?? 'tmux');
  const systemPromptMode: SystemPromptMode = opts.systemPromptMode ?? 'append';
  const alias = validateAlias(opts.alias);

  // Base cwd → realpath.
  const baseCwd = await fs.realpath(opts.cwd ?? process.cwd());

  // Generate our handle uuid. claude/pi pass it as --session-id; for codex it's the
  // handle only (the codex-side id is discovered later at transcript() time).
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);

  // Resolve system prompt: explicit systemPrompt, OR (codex/pi) the agentName body.
  let resolvedSystemPrompt = opts.systemPrompt;
  let effectiveModel = opts.model;
  let nativeAgentName: string | undefined;

  if (opts.agentName) {
    if (provider === 'claude') {
      // claude resolves named agents natively.
      nativeAgentName = opts.agentName;
    } else {
      // codex/pi have no native launch-time named-agent flag, so resolve the agent's
      // prompt body ourselves (codex's own agent/prompt stores first, then claude agents).
      const def = await resolveAgentDef(opts.agentName, baseCwd, provider);
      if (!def || def.body.trim().length === 0) {
        const looked =
          provider === 'codex'
            ? '.codex/agents/, $CODEX_HOME/agents/, .codex/prompts/, $CODEX_HOME/prompts/, .claude/agents/, ~/.claude/agents/'
            : '.claude/agents/, ~/.claude/agents/';
        throw new Error(
          `agentName "${opts.agentName}" not found for provider=${provider} ` +
            `(looked in ${looked}). Define it there, pass systemPrompt instead, or use provider=claude.`,
        );
      }
      resolvedSystemPrompt = def.body;
      effectiveModel = effectiveAgentModel(opts.model, def, provider);
    }
  }

  // Workspace = opts.workspace ?? git toplevel of baseCwd ?? realpath(baseCwd).
  // Resolve from baseCwd (the ORIGINAL invocation dir), NOT the worktree `cwd`: a linked
  // worktree reports ITSELF as `git --show-toplevel`, so resolving from the worktree would
  // silo the session under <repo>/.orc/worktrees/<id> and hide it from `orc list` run in
  // the parent repo. A worktree always has a git parent (enforced below), and that parent
  // is the project home — so a worktree agent belongs to the same workspace as the repo.
  const workspace = await resolveWorkspace(opts.workspace, baseCwd);

  // tmux session name: orc-<agentLabel>-<shortId>. Alias intentionally does not affect it.
  const agentLabel = sanitizeTmuxName(opts.agentName ?? provider);
  const tmuxName = `orc-${agentLabel}-${shortId}`;

  // pi needs a session dir.
  const sessionDir = piSessionDir(sessionId);

  let cwd = baseCwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;
  const createdAt = new Date().toISOString();
  let record: SessionRecord = {
    id: shortId,
    sessionId,
    provider,
    model: effectiveModel,
    agentName: opts.agentName,
    alias,
    tmuxName,
    cwd,
    worktreePath,
    branch,
    workspace,
    systemPromptMode,
    sessionDir: provider === 'pi' ? sessionDir : undefined,
    createdAt,
    aliasReservedAt: alias ? createdAt : undefined,
  };

  // Reserve the alias under the registry lock before worktree/provider prep so two
  // near-simultaneous spawns cannot claim the same workspace alias.
  await reserveRecord(record, { driver });

  let spawned = false;
  try {
    // Worktree (optional). Requires cwd inside a git repo.
    if (opts.worktree) {
      if (!(await isInsideGitRepo(baseCwd))) {
        throw new Error(`worktree requires cwd to be inside a git repo (cwd=${baseCwd})`);
      }
      const wtOpts = typeof opts.worktree === 'object' ? opts.worktree : {};
      const wt = await createWorktree({
        cwd: baseCwd,
        shortId,
        agentLabel,
        branch: wtOpts.branch,
        path: wtOpts.path,
      });
      cwd = wt.path;
      worktreePath = wt.path;
      branch = wt.branch;
      record = { ...record, cwd, worktreePath, branch };
      await upsertRecord(record);
    }

    if (provider === 'pi') {
      await fs.mkdir(sessionDir, { recursive: true });
    }

    const ctx: BuildCtx = {
      model: effectiveModel,
      sessionId,
      systemPrompt: resolvedSystemPrompt,
      systemPromptMode,
      agentName: nativeAgentName,
      cwd,
      sessionDir,
    };

    // Provider cwd prep (codex writes AGENTS.md).
    await adapter.prepare(ctx);

    const argv = adapter.buildArgv(ctx);

    // Spawn the detached TUI.
    await driver.spawn({ name: tmuxName, cwd, argv });
    spawned = true;
    if (record.aliasReservedAt) {
      const { aliasReservedAt: _reserved, ...launched } = record;
      record = launched;
    }
  } catch (e) {
    if (!spawned) {
      if (worktreePath) {
        await removeWorktree(workspace, worktreePath).catch(() => {});
      }
      await removeRecord(shortId).catch(() => {});
    }
    throw e;
  }

  // Persist the launched record, clearing any transient alias reservation marker.
  await upsertRecord(record);

  const session = new Session(record, opts.driver ?? 'tmux');

  const waitForReady = opts.waitForReady ?? true;
  if (waitForReady) {
    const ready = await session.waitForReady();
    if (ready && opts.prompt) {
      await session.send(opts.prompt);
    }
  }
  // NOTE: when waitForReady=false we skip BOTH the boot-poll and the auto-send.
  // The record is still returned so a caller can poll status / send later.

  return session;
}

/**
 * Resolve the workspace key for a session.
 * BUG 4: when an explicit `workspace` resolves to an existing filesystem path, store its
 * REALPATH so it stays comparable to `defaultWorkspace()` (which realpaths cwd) —
 * otherwise a symlinked/relative `--workspace` becomes invisible to default `orc list`.
 * A logical (non-filesystem) workspace string is kept verbatim. With no explicit
 * workspace, fall back to git toplevel of cwd, else cwd (already realpathed upstream).
 */
export async function resolveWorkspace(
  workspace: string | undefined,
  cwd: string,
): Promise<string> {
  if (workspace) {
    return fs.realpath(workspace).catch(() => workspace);
  }
  return (await gitToplevel(cwd)) ?? cwd;
}

/** Slugless re-export of name builder for the CLI. */
export function buildTmuxName(label: string, shortId: string): string {
  return `orc-${sanitizeTmuxName(label)}-${shortId}`;
}
