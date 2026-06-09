/**
 * pi adapter. -a trust flag (no trust dialog); --session-id + --session-dir;
 * system prompt via --append-system-prompt; transcript glob <dir>/*_<sid>.jsonl.
 */
import type { ProviderAdapter, BuildCtx } from './provider.ts';
import type { SessionRecord } from '../types.ts';

export class PiAdapter implements ProviderAdapter {
  readonly name = 'pi' as const;

  async prepare(_ctx: BuildCtx): Promise<void> {
    // pi needs no cwd prep; session-dir is created by the caller.
  }

  buildArgv(ctx: BuildCtx): string[] {
    const argv = ['pi', '-a'];
    if (ctx.model) argv.push('--model', ctx.model);
    if (ctx.systemPrompt) {
      if (ctx.systemPromptMode === 'replace') {
        argv.push('--system-prompt', ctx.systemPrompt);
      } else {
        argv.push('--append-system-prompt', ctx.systemPrompt);
      }
    }
    argv.push('--session-id', ctx.sessionId);
    argv.push('--session-dir', ctx.sessionDir);
    return argv;
  }

  readyMatch(pane: string): boolean {
    // pi renders its input box; the box border / prompt char indicates ready.
    return pane.includes('│') || pane.includes('❯') || pane.includes('>');
  }

  trustDialogMatch(_pane: string): boolean {
    // pi -a has no trust dialog.
    return false;
  }

  async resolveTranscript(rec: SessionRecord): Promise<string | null> {
    const dir = rec.sessionDir;
    if (!dir) return null;
    const glob = new Bun.Glob(`*_${rec.sessionId}.jsonl`);
    for await (const match of glob.scan({ cwd: dir, absolute: true })) {
      return match;
    }
    return null;
  }
}
