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
import { CODEX_SESSION_FILE_NAME, isLegacyCodexSpec } from './runtime/providers/codex.ts';
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
      if (p && path.basename(p) === CODEX_SESSION_FILE_NAME && fs.existsSync(p)) return p;
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
    return path.join(sessionStateDir(sessionId), CODEX_SESSION_FILE_NAME);
  } catch {
    return undefined;
  }
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
      const argv = ['claude', '--resume', psid];
      if (spec.model) argv.push('--model', spec.model);
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
      if (isLegacyCodexSpec(spec)) return [];
      const file =
        spec.transcriptPath && path.basename(spec.transcriptPath) === CODEX_SESSION_FILE_NAME
          ? spec.transcriptPath
          : safeSessionFile(spec.sessionId);
      return file && fs.existsSync(file) ? ['pi', '--session', file] : [];
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
  return 'needs pi (>= 1.2.0) on PATH, signed in to OpenAI in pi (Sign in with ChatGPT) or OPENAI_API_KEY set';
}

/** `cd <cwd> && <native resume argv>` (shell-quoted), or a comment for `fake`. */
export function nativeResumeCommand(spec: SpawnSpec): string {
  const argv = nativeResumeArgv(spec);
  if (argv.length === 0) return `# provider '${spec.provider}' has no native resume command`;
  return `cd ${shellQuote(spec.cwd)} && ${argv.map(shellQuote).join(' ')}`;
}
