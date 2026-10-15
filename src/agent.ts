/**
 * agent() — the core primitive. Validates options, resolves the system prompt / agent
 * body, optionally creates a worktree, writes the session's spawn spec and starts its
 * detached actor (src/runtime/client.ts `createSession`), waits for the provider to be
 * ready, then sends the initial prompt through the durable inbox.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sanitizeLabel } from './naming.ts';
import { effectiveAgentModel, resolveAgentDef } from './agentdefs.ts';
import { createWorktree, gitToplevel, isInsideGitRepo, removeWorktree } from './worktree.ts';
import { removeRecord, reserveRecord, upsertRecord, validateAlias } from './registry.ts';
import { piSessionDir } from './paths.ts';
import { Session } from './session.ts';
import { withLock } from './lock.ts';
import type { AgentOptions, Provider, SessionRecord, SystemPromptMode } from './types.ts';
import { removeSessionDir, writeSystemPromptFile } from './session-files.ts';
import {
  resolveLineage,
  enforceSpawnPolicy,
  lineageEnv,
  validateExecutionPolicy,
} from './lineage.ts';
import { createSession, stop as kernelStop } from './runtime/client.ts';
import { RUNTIME_SCHEMA_VERSION } from './runtime/types.ts';
import type { SpawnSpec } from './runtime/types.ts';

/**
 * Test seam: when set, sessions are started on the scripted `fake` provider runtime
 * (src/runtime/providers/fake.ts) instead of the real CLI. Value: a JSON FakeScript, or
 * `1` for the default script. Works from source only (the fake child is a .ts file).
 */
export const FAKE_PROVIDER_ENV = 'ORC_TEST_FAKE_PROVIDER';

function fakeScriptFromEnv(env: NodeJS.ProcessEnv = process.env): unknown | undefined {
  const raw = env[FAKE_PROVIDER_ENV];
  if (raw === undefined || raw === '' || raw === '0') return undefined;
  if (raw === '1' || raw === 'true') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${FAKE_PROVIDER_ENV} must be '1' or a JSON fake script`);
  }
}

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
  if (opts.policy) validateExecutionPolicy(opts.policy, 'agent policy');
  if (opts.depth !== undefined && (!Number.isFinite(opts.depth) || opts.depth < 0)) {
    throw new Error('depth must be a non-negative number');
  }
}

export async function agent(opts: AgentOptions): Promise<Session> {
  validateOptions(opts);

  // Explicit options override inherited ORC_* environment lineage.
  const lineage = resolveLineage(opts, process.env);
  const provider = opts.provider;
  const systemPromptMode: SystemPromptMode = opts.systemPromptMode ?? 'append';
  const alias = validateAlias(opts.alias);

  // Base cwd → realpath.
  const baseCwd = await fs.realpath(opts.cwd ?? process.cwd());

  // Generate our handle uuid: the kernel session id (claude/pi also use it as their
  // --session-id; codex assigns its own thread id, recorded as providerSessionId).
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

  // Worktree label (branch `orc/<label>/<shortId>`). Alias intentionally does not affect it.
  const agentLabel = sanitizeLabel(opts.agentName ?? provider);

  // pi needs a session dir.
  const sessionDir = piSessionDir(sessionId);

  // Every provider reads its system prompt from an orc-owned file (never argv, never the
  // cwd): ~/.orc/sessions/<sid>/system-prompt.md. claude's native --agent needs none.
  const systemPromptText =
    resolvedSystemPrompt && resolvedSystemPrompt.trim().length > 0 ? resolvedSystemPrompt : undefined;

  let cwd = baseCwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;
  const createdAt = new Date().toISOString();
  let record: SessionRecord = {
    id: shortId,
    sessionId,
    runtime: 'actor',
    provider,
    model: effectiveModel,
    agentName: opts.agentName,
    alias,
    cwd,
    worktreePath,
    branch,
    workspace,
    systemPromptMode,
    sessionDir: provider === 'pi' ? sessionDir : undefined,
    createdAt,
    aliasReservedAt: alias ? createdAt : undefined,
    ...(lineage.rootRunId ? { rootRunId: lineage.rootRunId } : {}),
    ...(lineage.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
    ...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
    ...(lineage.stepId ? { stepId: lineage.stepId } : {}),
    ...(lineage.depth !== undefined ? { depth: lineage.depth } : {}),
    ...(lineage.owner ? { owner: lineage.owner } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
  };

  // Reserve the record (and alias) under the registry lock — and the root policy lock —
  // before any side effect, so concurrent spawns cannot oversubscribe a policy or alias.
  await reserveSpawnRecord(record, { lineage, policy: opts.policy });

  const fakeScript = fakeScriptFromEnv();
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

    let systemPromptPath: string | undefined;
    if (systemPromptText) {
      systemPromptPath = await writeSystemPromptFile(sessionId, systemPromptText);
      record = { ...record, systemPromptPath };
      await upsertRecord(record);
    }

    // Thread ORC_* lineage so nested `orc` CLIs inherit context (explicit AgentOptions
    // still override env on the next agent() call).
    const childEnv = {
      ...lineageEnv({
        ...lineage,
        // Child processes that spawn further agents deepen by 1 unless overridden.
        depth: (lineage.depth ?? 0) + 1,
        parentSessionId: shortId,
      }),
      ...(opts.extraEnv ?? {}),
    };

    const spec: SpawnSpec = {
      version: RUNTIME_SCHEMA_VERSION,
      sessionId,
      provider: fakeScript !== undefined ? 'fake' : provider,
      cwd,
      env: childEnv,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(nativeAgentName ? { agentName: nativeAgentName } : {}),
      ...(systemPromptPath ? { systemPrompt: { mode: systemPromptMode, path: systemPromptPath } } : {}),
      ...(provider === 'pi' ? { sessionDir } : {}),
      ...(fakeScript !== undefined ? { fakeScript } : {}),
      createdAt,
    };
    await createSession(spec);
    if (record.aliasReservedAt) {
      const { aliasReservedAt: _reserved, ...launched } = record;
      record = launched;
    }
    // Persist the launched record, clearing any transient alias reservation marker.
    await upsertRecord(record);

    let session = new Session(record);
    if (opts.waitForReady ?? true) {
      // Record the provider-side session id (codex: its thread id) and transcript path
      // straight from the provider.ready entry (no second read racing spawn.json).
      const ready = await session.awaitReady(opts.readyTimeoutMs);
      record = {
        ...record,
        providerSessionId: ready.providerSessionId,
        ...(ready.transcriptPath ? { transcriptPath: ready.transcriptPath } : {}),
      };
      await upsertRecord(record);
      session = new Session(record);
      if (opts.prompt) await session.send(opts.prompt);
    } else if (opts.prompt) {
      // Durably queued; the actor delivers it once the provider is ready.
      await session.send(opts.prompt, { ackTimeoutMs: 0 });
    }
    return session;
  } catch (e) {
    // D16: nothing is left behind — stop the actor, drop the session dir (journal,
    // system prompt), the worktree and the record. Never touches user files.
    // Also when createSession itself failed: a slow actor may still be starting.
    await kernelStop(sessionId, { reason: 'spawn-failed', graceMs: 1_000 }).catch(() => {});
    await removeSessionDir(sessionId).catch(() => {});
    if (worktreePath) {
      await removeWorktree(baseCwd, worktreePath, { branch }).catch(() => {});
    }
    await removeRecord(shortId).catch(() => {});
    throw e;
  }
}

/**
 * Atomically enforce a root execution policy and reserve the new registry record.
 * The cross-process root lock closes the check-then-reserve race where two agents
 * could both observe one free maxConcurrentSessions slot and oversubscribe it.
 */
export async function reserveSpawnRecord(
  record: SessionRecord,
  args: {
    lineage: ReturnType<typeof resolveLineage>;
    policy?: AgentOptions['policy'];
  },
): Promise<void> {
  const reserve = async () => {
    await enforceSpawnPolicy({
      lineage: args.lineage,
      policy: args.policy,
      isDelegation:
        (args.lineage.depth ?? 0) > 0 || Boolean(args.lineage.parentRunId),
    });
    await reserveRecord(record);
  };

  if (!args.lineage.rootRunId && !args.policy) {
    await reserve();
    return;
  }
  await withLock(`spawn-policy-${args.lineage.rootRunId ?? 'unrooted'}`, reserve);
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
