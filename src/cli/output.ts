/**
 * Human + JSON renderers for the orc CLI.
 */
import type { SessionRecord } from '../types.ts';
import type { WorkflowEvent, WorkflowRun, StepResult } from '../workflow.ts';

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
    `attach:      orc attach ${rec.id}`,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

export function renderSessionList(views: SessionView[]): string {
  if (views.length === 0) return '(no sessions)';
  return views.map(renderSessionLine).join('\n');
}

/** A session view tagged with the host it lives on (for `orc list --all-hosts`). */
export interface HostSessionView extends SessionView {
  host: string;
}

/** Like `renderSessionList`, with a leading `host` column (the fleet view). */
export function renderSessionListWithHost(views: HostSessionView[]): string {
  if (views.length === 0) return '(no sessions)';
  return views.map((v) => `${v.host.padEnd(14)} ${renderSessionLine(v)}`).join('\n');
}

/** One human line per workflow step result. */
function renderStepResultLine(r: StepResult): string {
  const mark = r.ok ? 'ok' : 'FAIL';
  const flag = r.unverified ? ' UNVERIFIED' : '';
  const wt = r.worktree ? ` worktree=${r.worktree}` : '';
  return `  [${mark}] ${r.id} (${r.provider}) state=${r.state} commitsAhead=${r.commitsAhead}${flag}  session=${r.sessionId}${wt}`;
}

/** Render a streamed workflow event as a human progress line (trailing newline). */
export function renderWorkflowEvent(e: WorkflowEvent): string {
  switch (e.type) {
    case 'run-start':
      return `> run ${e.runId} '${e.name}' (${e.steps} step${e.steps === 1 ? '' : 's'})\n`;
    case 'step-start':
      return `  - ${e.stepId} [${e.provider}] running...\n`;
    case 'step-done':
      return `${renderStepResultLine(e.result)}\n`;
    case 'step-warn':
      return `  ! warning: ${e.message}\n`;
    case 'step-error':
      return `  ! ${e.stepId} error: ${e.error}\n`;
    case 'run-done':
      return `= run ${e.runId} ${e.status}\n`;
  }
}

/** Multi-line detail of a persisted run (for `orc workflow status`). */
export function renderRunDetail(run: WorkflowRun): string {
  const head = [
    `id:         ${run.id}`,
    `name:       ${run.name}`,
    `status:     ${run.status}`,
    `startedAt:  ${run.startedAt}`,
    run.finishedAt ? `finishedAt: ${run.finishedAt}` : null,
    `steps:      ${run.steps.length}`,
  ].filter((l): l is string => l !== null);
  const steps = run.steps.map(renderStepResultLine);
  return [...head, ...steps].join('\n');
}

/** One line per run for `orc workflow list`. */
export function renderRunList(runs: WorkflowRun[]): string {
  if (runs.length === 0) return '(no runs)';
  return runs
    .map((r) => {
      const okCount = r.steps.filter((s) => s.ok).length;
      return `${r.id}  ${r.status.padEnd(7)} ${r.name}  steps=${okCount}/${r.steps.length}  ${r.startedAt}`;
    })
    .join('\n');
}

export const HELP_TEXT = `orc — multi-agent orchestration CLI

Usage:
  orc spawn  --provider <claude|codex|pi> [options]   Launch a new agent session
             aliases: agent, new
  orc send   <id|name> [PROMPT | - | @file]           Send a prompt (multi-line safe)
  orc read   <id|name> [--last|--index N|--full|--raw]  Latest parsed turn by default; --full = full transcript; --raw = full pane
  orc state  <id|name>                                Classify state once: starting|running|done|waiting|failed
  orc wait   <id|name> [--for S] [--timeout SEC]      Block until the agent settles (S: done|waiting|failed|settled)
  orc list   [--workspace W | --all | --dead | --all-hosts]  List sessions (alias: ps)
  orc attach <id|name> [--read-only]                  Attach to the tmux session
  orc kill   <id|name> [--worktree] [--purge]         Kill session (mark dead; --purge removes record)
  orc prune  [--worktree]                             Drop marked-dead/gone records (+ optional worktrees)
  orc workflow <run|list|status|attach|logs> ...      Run/inspect multi-step workflows (alias: wf)
  orc daemon [--port 8787] [--bind <ip>] [--insecure] Serve the HTTP API over tailscale
  orc remote <add|list|rm> <host> [--port P]          Manage trusted peers (~/.orc/peers.json)
  orc help                                            This help

spawn options:
  --provider, -p <p>     claude | codex | pi (required)
  --model, -m <model>    model name
  --agent <name>         named agent definition (codex TOML matched by name; mutually exclusive with --system-prompt)
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

workflow subcommands:
  orc workflow run <file> [--detach] [--json]   Import the file's default-exported WorkflowDef and
                                      run it, streaming step events (or --json the final WorkflowRun).
                                      Exits non-zero if the run failed. --detach runs it as a
                                      detached tmux session (orc-wf-<runId>) and returns the runId
                                      immediately (--json: {runId,runnerTmux}).
  orc workflow list [--json]          List persisted runs from ~/.orc/runs/ (newest first)
  orc workflow status <runId> [--json]  Print a run record (per-step state). A \`running\` record
                                      whose runner session has died is reported \`orphaned\`.
  orc workflow attach <runId> [--read-only]  Print the tmux attach command for a --detach run's runner
  orc workflow logs <runId> [--step <id>] [--raw] [--json]  Per-step transcript ('### step <id>
                                      (<provider>)'). --raw shows the live pane; --json emits
                                      {step,turns}[] (or {step,provider,pane}[] with --raw).

A workflow file default-exports a PLAIN object { name, steps[] } — no import required
(runWorkflow validates the shape). A step succeeds by an explicit \`done\` predicate over a
HARD signal (a commit, a file); a worktree step defaults to state==='done' && commitsAhead>=1.
A non-worktree step with no predicate is reported \`unverified\` — a yield is NOT success.
Run status: running | done | failed | orphaned (a --detach runner that died mid-run).

daemon + remote (drive agents on other orc hosts over tailscale):
  orc daemon            Run Bun.serve exposing the SDK as JSON. Binds to this host's
                        tailscale IP by DEFAULT (never 0.0.0.0); refuses an unsafe --bind
                        unless --insecure. --bind 127.0.0.1 for local testing. Every route
                        except GET /health is behind a FAIL-CLOSED trust gate: a caller is
                        allowed iff tailscale whois resolves its IP to an allowlisted peer
                        (orc remote add) OR it presents x-orc-secret == \$ORC_DAEMON_SECRET.
  orc remote add <h>    Trust peer <h> (also the host list for --host / --all-hosts).
  orc --host <h> <cmd>  Run <cmd> against the daemon on <h> (host or host:port) over HTTP
                        instead of locally — list/spawn/send/read/wait/state/kill/workflow.
                        Output (and --json) is identical to local. Sends x-orc-secret from
                        \$ORC_DAEMON_SECRET when set. Remote attach prints a tailscale ssh hint
                        (the tmux session is host-local).
  orc list --all-hosts  Fleet view: aggregate local + every trusted peer, with a host column.

Global:
  --host <h>            Run the command against the daemon on host <h> (see above)
  --json                machine-readable output; non-zero exit + {error} on failure

read defaults to the latest parsed conversation turn. --full emits the full parsed
transcript, --index N emits zero-based parsed turn N, and --raw emits the full pane.
read --json emits the selected parsed turn array ([{role,text},...]); --raw --json emits
{id,pane}; if no transcript exists yet it falls back to {id,fallback:true,pane}.
state --json emits {id,state}. wait --json emits {id,state,elapsedMs,timedOut};
exit 0 iff the requested state actually settled after debounce, non-zero on timeout.

State meaning: 'done' = the composer is idle and ready for YOUR input (NOT "succeeded"
— it also covers an agent that asked a clarifying question, which is pane-identical to
a finished turn). 'waiting' = blocked on a TUI modal (trust/approval/update). 'failed'
= the pane is gone (crash OR clean exit like /exit — "terminated", not "errored").
`;
