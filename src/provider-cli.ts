/**
 * Provider facts orc needs outside the runtime: where each CLI keeps its transcript, and
 * the native command a human runs to continue a session after `orc takeover`.
 *
 * Transcript locations:
 * - claude: `~/.claude/projects/<slug>/<providerSessionId>.jsonl` (globbed; the runtime
 *   reports it on ready once the file exists).
 * - codex:  the codex harness's pi-format session file,
 *   `~/.orc/sessions/<sid>/codex-session.jsonl` (reported on ready, persisted in
 *   spawn.json). Sessions from the removed codex app-server runtime recorded a codex
 *   rollout path instead: those are not shown (no transcript).
 * - pi:     `get_state.sessionFile` (persisted in spawn.json), else `<sessionDir>/*_<id>.jsonl`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from './types.ts';
import type { SpawnSpec } from './runtime/types.ts';
import { resolveClaudeTranscript } from './runtime/providers/claude.ts';
import { buildPiArgs } from './runtime/providers/pi-protocol.ts';
import { LEGACY_CODEX_SESSION_FILE } from './legacy-codex.ts';
import { validateModel, validateReasoningEffort } from './providers.ts';
import { sessionStateDir } from './paths.ts';

function existing(p: string | undefined): string | null {
  return p && fs.existsSync(p) ? p : null;
}

/**
 * Resolve the provider transcript for a record. Order: the path persisted on the record
 * (kill/takeover), the path the runtime recorded in spawn.json, then the provider rule.
 */
export function resolveTranscriptPath(
  rec: Pick<SessionRecord, 'provider' | 'sessionId' | 'providerSessionId' | 'transcriptPath' | 'sessionDir'>,
  spec?: SpawnSpec,
): string | null {
  if (rec.provider === 'codex') {
    // Only the harness's session file: a legacy app-server record points at a codex rollout.
    for (const p of [rec.transcriptPath, spec?.transcriptPath, safeSessionFile(rec.sessionId)]) {
      if (p && path.basename(p) === LEGACY_CODEX_SESSION_FILE && fs.existsSync(p)) return p;
    }
    return null;
  }
  const recorded = existing(rec.transcriptPath) ?? existing(spec?.transcriptPath);
  if (recorded) return recorded;
  const psid = spec?.providerSessionId ?? rec.providerSessionId ?? rec.sessionId;
  switch (rec.provider) {
    case 'claude':
      return resolveClaudeTranscript(psid) ?? null;
    case 'pi': {
      const dir = spec?.sessionDir ?? rec.sessionDir;
      if (!dir) return null;
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return null;
      }
      for (const id of new Set([psid, rec.sessionId])) {
        const hit = names.find((n) => n.endsWith(`_${id}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
      return null;
    }
    default:
      return null;
  }
}

function safeSessionFile(sessionId: string): string | undefined {
  try {
    return path.join(sessionStateDir(sessionId), LEGACY_CODEX_SESSION_FILE);
  } catch {
    return undefined;
  }
}

/**
 * Read only the model selection needed for a native handoff. Pi v3's active branch
 * ends at the last entry; prior takeovers may have added other branches. Match Pi
 * 1.2.0 session-manager's parent chain and model/assistant precedence, but refuse a
 * broken chain instead of silently selecting a model from incomplete history.
 */
function legacyContinuationModel(spec: SpawnSpec, file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const unsupported = (reason: string) => new Error(
    `cannot safely continue historical Codex transcript ${file}: ${reason}; review its history with orc read ${spec.sessionId} --full and select a model explicitly in Pi. See docs/MIGRATION-pi.md.`,
  );
  let header: Record<string, unknown> | undefined;
  const entries: Array<Record<string, unknown>> = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[i]!); }
    catch { continue; } // Pi's reader also skips malformed lines (including a torn tail).
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unsupported('invalid entry');
    const entry = parsed as Record<string, unknown>;
    if (i === 0) {
      header = entry;
      continue;
    }
    if (entry.type === 'session' || typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)) {
      throw unsupported('missing or duplicate entry identity');
    }
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  if (header?.type !== 'session' || header.version !== 3 || header.id !== spec.sessionId) {
    throw unsupported('not a matching Pi v3 session');
  }
  const active: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let entry = entries.at(-1);
  while (entry) {
    if (seen.has(entry.id)) throw unsupported('cyclic active branch');
    seen.add(entry.id);
    active.push(entry);
    if (entry.parentId === null) break;
    if (typeof entry.parentId !== 'string' || !byId.has(entry.parentId)) throw unsupported('broken active branch');
    entry = byId.get(entry.parentId);
  }
  let model: unknown = spec.model;
  let provider: unknown = 'openai';
  for (const entry of active.reverse()) {
    if (entry.type === 'model_change') {
      model = entry.modelId;
      provider = entry.provider;
    } else if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
      const message = entry.message as Record<string, unknown>;
      if (message.role === 'assistant' && (message.model !== undefined || message.provider !== undefined)) {
        model = message.model;
        provider = message.provider;
      }
    }
  }
  if (!model) {
    throw unsupported('no recorded model');
  }
  if (provider !== 'openai') {
    throw unsupported('the active branch does not select the supported OpenAI provider');
  }
  try { validateModel('pi', model); }
  catch { throw unsupported('invalid recorded model'); }
  return model;
}

/** POSIX shell single-quoting (only when needed). */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The provider's own interactive resume command for a stopped session (`orc takeover`).
 * Uses the same session id, model and persona file the runtime launched with:
 * - claude: `claude --resume <providerSessionId>` (+ --model / --agent / system prompt file)
 * - codex:  `pi --session <harness session file>` — the harness writes pi's session format
 *           (verified: pi 1.2.0 `--session <path>` opens it with its messages, model and
 *           thinking level, from any cwd). pi uses its own OpenAI login.
 * - pi:     the runtime's resume flags minus `--mode rpc` (same --session-id/--session-dir
 *           and system prompt flag: pi drops the addendum when it is omitted)
 */
export function nativeResumeArgv(spec: SpawnSpec): string[] {
  const psid = spec.providerSessionId ?? spec.sessionId;
  switch (spec.provider) {
    case 'claude': {
      validateReasoningEffort('claude', spec.reasoningEffort);
      const argv = ['claude', '--resume', psid];
      if (spec.model) argv.push('--model', spec.model);
      if (spec.reasoningEffort !== undefined) argv.push('--effort', spec.reasoningEffort);
      if (spec.agentName) argv.push('--agent', spec.agentName);
      if (spec.systemPrompt) {
        argv.push(
          spec.systemPrompt.mode === 'replace' ? '--system-prompt-file' : '--append-system-prompt-file',
          spec.systemPrompt.path,
        );
      }
      return argv;
    }
    case 'codex': {
      if (spec.providerSessionId && spec.providerSessionId !== spec.sessionId) return [];
      const file =
        spec.transcriptPath && path.basename(spec.transcriptPath) === LEGACY_CODEX_SESSION_FILE
          ? spec.transcriptPath
          : safeSessionFile(spec.sessionId);
      if (!file || !fs.existsSync(file)) return [];
      // Explicit flags prevent Pi restoring a different provider when the saved model's
      // credentials are unavailable. No model catalog or auth is implemented in ORC.
      const model = legacyContinuationModel(spec, file);
      const argv = ['pi', '--session', file, '--provider', 'openai', '--model', model];
      if (spec.systemPrompt) {
        if (!existing(spec.systemPrompt.path) || !fs.statSync(spec.systemPrompt.path).isFile()) {
          throw new Error(`historical session system prompt is missing or not a file: ${spec.systemPrompt.path}; restore it before continuing in Pi. See docs/MIGRATION-pi.md.`);
        }
        argv.push(spec.systemPrompt.mode === 'replace' ? '--system-prompt' : '--append-system-prompt', spec.systemPrompt.path);
      }
      return argv;
    }
    case 'pi': {
      const args = buildPiArgs(spec, true);
      const i = args.indexOf('--mode');
      if (i >= 0) args.splice(i, 2);
      return ['pi', ...args];
    }
    default:
      return [];
  }
}

/**
 * Extra guidance printed with a takeover command (null when none): the codex harness is
 * continued in pi, which authenticates on its own.
 */
export function nativeResumeNote(spec: SpawnSpec): string | null {
  if (spec.provider !== 'codex') return null;
  return 'Needs Pi (verified 1.2.0) on PATH; sign in with Pi /login → OpenAI → Sign in with ChatGPT, or set OPENAI_API_KEY. Continue in Pi; this historical ORC session cannot be handed back with orc resume. History and old credentials are preserved. See docs/MIGRATION-pi.md.';
}

/** `cd <cwd> && <native resume argv>` (shell-quoted), or a comment for `fake`. */
export function nativeResumeCommand(spec: SpawnSpec): string {
  const argv = nativeResumeArgv(spec);
  if (argv.length === 0) return `# provider '${spec.provider}' has no native resume command`;
  return `cd ${shellQuote(spec.cwd)} && ${argv.map(shellQuote).join(' ')}`;
}
