import { HELP_TEXT } from './output.ts';

/** Reuse the detailed reference so command help and the full manual agree. */
function section(heading: string): string {
  const start = HELP_TEXT.indexOf(`\n${heading}:\n`);
  if (start < 0) return '';
  const text = HELP_TEXT.slice(start + 1);
  return text.split('\n\n')[0]!;
}

const NOTES: Record<string, string> = {
  read: 'Options:\n  --last              Latest turn (default)\n  --index N           Select a zero-based turn\n  --full              Full transcript\n  --raw               Session journal\n  Select only one of --last, --index, --full or --raw.',
  state: 'Reports starting, running, done, waiting or failed.\n  --json includes stopped and suspended status.',
  list: 'Options:\n  --workspace W       Filter by workspace\n  --all               Include dead sessions\n  --dead              Show only dead sessions\n  --all-hosts         Aggregate local and trusted remote hosts\n  --run ID            Filter by workflow run (local only)\n  --lineage           Show session lineage (local only)',
  attach: 'Follow the live journal read-only; Ctrl-C stops following.\nOver --host, prints a Tailscale SSH command instead.\n  --json              Print attachment metadata instead of following',
  kill: 'Options:\n  --purge             Delete the session record and journal\n  --worktree          Remove its worktree checkout; keep the branch\nWithout --purge, history is kept. Stopped sessions require resume before send.',
  resume: 'Resume a stopped, taken-over or suspended session. Host-local command.\nUse the session ID for a stopped session; its alias may have been released.',
  takeover: 'Stop the actor and print the provider command for human control.\nUse orc resume <id> to hand it back. Host-local command.',
  prune: 'Options:\n  --worktree          Remove owned worktree checkouts; keep branches\n  --suspended         Also stop and remove suspended sessions\n  --taken-over        Also remove sessions taken over by a human\nRemoves dead records and journals. Host-local; running sessions are kept.',
  daemon: 'Options:\n  --port P            Listen port (default: 8787)\n  --bind IP           Bind address (default: this host\'s Tailscale IP)\n  --insecure          Permit binding outside loopback/Tailscale\n  --mcp-allow-host H  Additional allowed MCP Host/Origin (repeatable)\nRun in the foreground. All routes except /health require authentication.\nTrust callers by Tailscale node name with orc remote add <name>.',
  settings: section('settings (ORC_HOST + settings.toml)'),
  mcp: 'Serve MCP over stdio for a lead agent. Host-local command.\nOptions:\n  --wait-timeout SEC  Tool wait timeout (default: 45, maximum: 600)',
};

const GROUPS: Record<string, Record<string, string>> = {
  workflow: Object.fromEntries(['run', 'list', 'status', 'attach', 'logs', 'resume', 'retry', 'cancel', 'cleanup'].map((name) => {
    const reference = section('workflow subcommands');
    const rows = reference.slice(reference.indexOf(`  orc workflow ${name} `));
    return [name, rows.split(/\n(?=  orc workflow )/)[0]!.trimEnd()];
  })),
  remote: {
    add: '  orc remote add <host> [--port P] [--json]\n\nTrust a Tailscale peer by node name (short name or full DNS name).\nThe peer list also supplies destinations for --all-hosts. Default port: 8787.',
    list: '  orc remote list [--json]\n\nList trusted peers from this host\'s ~/.orc/peers.json.',
    rm: '  orc remote rm <host> [--json]\n\nRemove a trusted peer from this host\'s peer list.',
  },
  login: {
    chatgpt: '  orc login chatgpt (removed)\n\nStart pi, run /login, choose OpenAI and Sign in with ChatGPT, or set OPENAI_API_KEY.\nSelect provider pi and model openai/<model-id> for new sessions. See docs/MIGRATION-pi.md.',
    status: '  orc login status (removed)\n\nPi owns OpenAI credentials; inspect providers with /login in Pi. See docs/MIGRATION-pi.md.',
  },
  logout: {
    chatgpt: '  orc logout chatgpt (removed)\n\nUse /logout in Pi. Old ORC auth files are preserved; see docs/MIGRATION-pi.md.',
  },
};

const REMOTE = new Set(['spawn', 'send', 'read', 'state', 'wait', 'list', 'attach', 'kill', 'workflow']);

/** null means unknown command/subcommand, so normal dispatch can report the error. */
export function commandHelp(command: string, subcommand?: string): string | null {
  const group = GROUPS[command];
  let body: string;
  if (group) {
    if (subcommand) {
      if (!Object.hasOwn(group, subcommand)) return null;
      body = `Usage:\n${group[subcommand]}`;
    } else {
      body = `Subcommands:\n${Object.values(group).join('\n\n')}`;
    }
  } else {
    const usage = HELP_TEXT.split('\n').find((line) => line.startsWith(`  orc ${command} `));
    if (!usage) return null;
    const details = ['spawn', 'send', 'wait'].includes(command) ? section(`${command} options`) : NOTES[command];
    body = `Usage:\n${usage}${details ? `\n\n${details}` : ''}`;
  }
  const routing = REMOTE.has(command)
    ? '\n  --host H            Run against a remote daemon (host or host:port)\n  --local             Run here, overriding ORC_HOST/settings'
    : '\n  This command runs locally.';
  return `orc ${command}${subcommand ? ` ${subcommand}` : ''}\n\n${body}\n\nCommon options:\n  -h, --help          Show this help\n  --json              Machine-readable command output\n  --color[=WHEN]      auto | always | never\n  --no-color          Disable color${routing}\n`;
}

// String options must consume their values before looking for a help flag: prompt
// text such as `--prompt --help` is data. Keep this list aligned with CLI parsers.
const VALUE_FLAGS = new Set([
  '--provider', '-p', '--model', '-m', '--agent', '--alias', '--system-prompt',
  '--system-prompt-mode', '--prompt', '--cwd', '--workspace', '--branch',
  '--idempotency-key', '--index', '--for', '--timeout', '--run', '--step',
  '--max-concurrency', '--port', '--bind', '--mcp-allow-host', '--wait-timeout', '--run-id',
]);

export function helpRequested(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}

export function helpSubcommand(command: string, args: readonly string[]): string | undefined {
  if (!GROUPS[command]) return undefined;
  // Group dispatch requires its subcommand first (login/logout also accept options first).
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return args[i + 1];
    if (VALUE_FLAGS.has(arg)) { i++; continue; }
    if (!arg.startsWith('-')) return command === 'remote' && arg === 'remove' ? 'rm' : arg;
  }
  return undefined;
}
