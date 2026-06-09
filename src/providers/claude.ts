/**
 * claude adapter. Native --agent, --session-id; transcript by globbing the sid.
 */
import os from 'node:os';
import path from 'node:path';
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;

  async prepare(_ctx: BuildCtx): Promise<void> {
    // claude needs no cwd prep.
  }

  buildArgv(ctx: BuildCtx): string[] {
    const argv = ['claude', '--dangerously-skip-permissions'];
    if (ctx.model) argv.push('--model', ctx.model);
    if (ctx.agentName) {
      // Native named agent.
      argv.push('--agent', ctx.agentName);
    } else if (ctx.systemPrompt) {
      if (ctx.systemPromptMode === 'replace') {
        argv.push('--system-prompt', ctx.systemPrompt);
      } else {
        argv.push('--append-system-prompt', ctx.systemPrompt);
      }
    }
    argv.push('--session-id', ctx.sessionId);
    return argv;
  }

  readyMatch(pane: string): boolean {
    // Require the bypass-permissions footer. Do NOT fall back to a bare '❯' — the
    // trust dialog's selection cursor ('❯ 1. Yes, I trust this folder') contains
    // '❯', and the boot loop checks readyMatch before trustDialogMatch.
    return pane.includes('bypass permissions on');
  }

  trustDialogMatch(pane: string): boolean {
    return (
      pane.includes('trust this folder') ||
      pane.includes('Is this a project you created') ||
      pane.includes('Do you trust the files in this folder')
    );
  }

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    // glob ~/.claude/projects/*/<sid>.jsonl — do NOT recompute the slug. claude DOES
    // honor our --session-id (the file IS named <sid>.jsonl), so the glob is correct.
    //
    // BUG 5 (investigated live, claude 2.1.169): for an orc-launched INTERACTIVE
    // session this file contains ONLY an `ai-title` event — the user/assistant turns
    // are never written here, not while live and not on clean `/exit`, and not under any
    // other filename in the project dir. The turns aren't on disk under ~/.claude at all
    // for interactive sessions (full JSONL is only written in `claude -p` print mode).
    // So this resolves the correct (title-only) file; for the live conversation use
    // `agi read --scrollback`. A cwd+mtime rewrite (like codex) would NOT help — there is
    // no fuller file to discover. Documented in README; left as a glob deliberately.
    const base = path.join(os.homedir(), '.claude', 'projects');
    const glob = new Bun.Glob(`*/${rec.sessionId}.jsonl`);
    for await (const match of glob.scan({ cwd: base, absolute: true })) {
      return match;
    }
    return null;
  }
}
