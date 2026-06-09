/**
 * Human + JSON renderers for the agi CLI.
 */
import type { SessionRecord } from '../types.ts';

export interface SessionView extends SessionRecord {
  status?: 'running' | 'dead';
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(message: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
}

/** One-line human summary of a session record. */
export function renderSessionLine(rec: SessionView): string {
  const status = rec.status ? `[${rec.status}]` : '';
  const wt = rec.worktreePath ? ` wt=${rec.worktreePath}` : '';
  const agent = rec.agentName ? ` agent=${rec.agentName}` : '';
  const model = rec.model ? ` model=${rec.model}` : '';
  return `${rec.id}  ${rec.provider} ${status} ${rec.tmuxName}${model}${agent}  cwd=${rec.cwd}${wt}`.trim();
}

/** Multi-line human detail of a session record. */
export function renderSessionDetail(rec: SessionView): string {
  const lines = [
    `id:          ${rec.id}`,
    `sessionId:   ${rec.sessionId}`,
    `provider:    ${rec.provider}`,
    rec.model ? `model:       ${rec.model}` : null,
    rec.agentName ? `agentName:   ${rec.agentName}` : null,
    `tmuxName:    ${rec.tmuxName}`,
    rec.status ? `status:      ${rec.status}` : null,
    `cwd:         ${rec.cwd}`,
    rec.worktreePath ? `worktree:    ${rec.worktreePath}` : null,
    rec.branch ? `branch:      ${rec.branch}` : null,
    `workspace:   ${rec.workspace}`,
    `createdAt:   ${rec.createdAt}`,
    `attach:      tmux attach -t ${rec.tmuxName}`,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

export function renderSessionList(views: SessionView[]): string {
  if (views.length === 0) return '(no sessions)';
  return views.map(renderSessionLine).join('\n');
}

export const HELP_TEXT = `agi — orc multi-agent orchestration CLI

Usage:
  agi spawn  --provider <claude|codex|pi> [options]   Launch a new agent session
             aliases: agent, new
  agi send   <id|name> [PROMPT | - | @file]           Send a prompt (multi-line safe)
  agi read   <id|name> [--raw]                        Parsed transcript (default) or full pane (--raw)
  agi state  <id|name>                                Classify state once: starting|running|done|waiting|failed
  agi wait   <id|name> [--for S] [--timeout SEC]      Block until the agent settles (S: done|waiting|failed|settled)
  agi list   [--workspace W | --all | --dead]         List sessions (alias: ps)
  agi attach <id|name> [--read-only]                  Print the tmux attach command
  agi kill   <id|name> [--worktree] [--purge]         Kill session (mark dead; --purge removes record)
  agi prune  [--worktree]                             Drop all dead records (+ optional worktrees)
  agi help                                            This help

spawn options:
  --provider, -p <p>     claude | codex | pi (required)
  --model, -m <model>    model name
  --agent <name>         named agent definition (mutually exclusive with --system-prompt)
  --system-prompt <txt>  system prompt text
  --system-prompt-mode   append (default) | replace
  --prompt <txt | ->     initial prompt sent after boot (- reads stdin)
  --cwd <dir>            base working directory (default: cwd)
  --workspace <w>       logical workspace key
  --worktree            create a fresh git worktree as cwd
  --branch <b>          worktree branch name
  --no-wait             return immediately; skip boot wait AND initial prompt send

wait options:
  --for <S>             done | waiting | failed | settled (default: settled = any of the three)
  --timeout <sec>       give up after SEC seconds (default 600); returns the last observed state

Global:
  --json                machine-readable output; non-zero exit + {error} on failure

read --json emits the parsed turn array ([{role,text},...]); --raw --json emits
{id,pane}; if no transcript exists yet it falls back to {id,fallback:true,pane}.
state --json emits {id,state}. wait --json emits {id,state,elapsedMs,timedOut};
exit 0 iff the reached state is in the requested set, non-zero on timeout.

State meaning: 'done' = the composer is idle and ready for YOUR input (NOT "succeeded"
— it also covers an agent that asked a clarifying question, which is pane-identical to
a finished turn). 'waiting' = blocked on a TUI modal (trust/approval/update). 'failed'
= the pane is gone (crash OR clean exit like /exit — "terminated", not "errored").
`;
