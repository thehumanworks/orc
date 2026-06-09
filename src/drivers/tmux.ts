/**
 * TmuxDriver — all tmux calls go through Bun.spawn with ARRAY argv. Untrusted prompt
 * text is never string-interpolated into a shell; it travels via `set-buffer -- <text>`.
 */
import type { Driver, SpawnArgs } from './driver.ts';
import type { PaneInfo } from '../types.ts';

const FIELD = '\t';
const LIST_FORMAT = [
  '#{session_name}',
  '#{pane_pid}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{session_attached}',
].join(FIELD);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `tmux <args...>` via Bun.spawn with array argv (no shell). */
async function tmux(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/**
 * Sanitize a tmux session name. tmux session names cannot contain '.' or ':'.
 * We restrict to [A-Za-z0-9_-] and collapse runs of disallowed chars to '-'.
 */
export function sanitizeTmuxName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'agent';
}

export class TmuxDriver implements Driver {
  readonly name = 'tmux';
  private static serverPrepared = false;

  /**
   * Best-effort fidelity tweaks pi/claude request. Ignore failures (server may not
   * be up yet; these are global options that take effect once it is).
   */
  private async prepareServer(): Promise<void> {
    if (TmuxDriver.serverPrepared) return;
    TmuxDriver.serverPrepared = true;
    await tmux(['set', '-g', 'extended-keys', 'on']).catch(() => {});
    await tmux(['set', '-g', 'focus-events', 'on']).catch(() => {});
  }

  async spawn(a: SpawnArgs): Promise<void> {
    // new-session -d (detached) -s name -c cwd -- <prog> <args...>
    // The `--` form passes argv directly (no shell quoting of prompt text).
    const args = ['new-session', '-d', '-s', a.name, '-c', a.cwd];
    if (a.env) {
      for (const [k, v] of Object.entries(a.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }
    args.push('--', ...a.argv);
    const r = await tmux(args);
    if (r.code !== 0) {
      throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    // Apply server fidelity options now that a server is guaranteed running.
    await this.prepareServer();
  }

  async capture(name: string, o?: { scrollback?: boolean }): Promise<string> {
    const args = ['capture-pane', '-t', name, '-p'];
    if (o?.scrollback) args.push('-S', '-');
    const r = await tmux(args);
    if (r.code !== 0) {
      throw new Error(`tmux capture-pane failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async sendKeys(name: string, keys: string): Promise<void> {
    const r = await tmux(['send-keys', '-t', name, keys]);
    if (r.code !== 0) {
      throw new Error(`tmux send-keys failed: ${r.stderr.trim()}`);
    }
  }

  async paste(name: string, text: string): Promise<void> {
    // set-buffer is server-global (NO -t). Use -- to end option parsing so text
    // starting with '-' is treated literally.
    const set = await tmux(['set-buffer', '--', text]);
    if (set.code !== 0) {
      throw new Error(`tmux set-buffer failed: ${set.stderr.trim()}`);
    }
    // -p = bracketed paste; -t <name> targets this pane.
    const paste = await tmux(['paste-buffer', '-p', '-t', name]);
    if (paste.code !== 0) {
      throw new Error(`tmux paste-buffer failed: ${paste.stderr.trim()}`);
    }
  }

  async list(prefix = 'orc-'): Promise<PaneInfo[]> {
    const r = await tmux(['list-panes', '-a', '-F', LIST_FORMAT]);
    // No server / no sessions => non-zero with a benign message; treat as empty.
    if (r.code !== 0) return [];
    const panes: PaneInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      if (line.length === 0) continue;
      const parts = line.split(FIELD);
      if (parts.length < 5) continue;
      const [name, pid, cwd, command, attached] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (!name.startsWith(prefix)) continue;
      panes.push({
        name,
        pid: Number.parseInt(pid, 10) || 0,
        cwd,
        command,
        attached: attached === '1',
      });
    }
    return panes;
  }

  async isAlive(name: string): Promise<boolean> {
    const r = await tmux(['has-session', '-t', name]);
    return r.code === 0;
  }

  async kill(name: string): Promise<void> {
    const r = await tmux(['kill-session', '-t', name]);
    if (r.code !== 0) {
      // Already gone is fine.
      if (/can't find session|no server running/i.test(r.stderr)) return;
      throw new Error(`tmux kill-session failed: ${r.stderr.trim()}`);
    }
  }

  attachCommand(name: string, o?: { readOnly?: boolean }): string {
    return o?.readOnly ? `tmux attach -r -t ${name}` : `tmux attach -t ${name}`;
  }
}
