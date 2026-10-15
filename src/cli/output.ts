/**
 * Human + JSON renderers for the orc CLI.
 */
import type { SessionRecord } from '../types.ts';
import type { WorkflowEvent, WorkflowRun, StepResult } from '../workflow.ts';
import { schedulingSummary } from '../workflow-scheduler.ts';
import { aliasHandle } from '../registry.ts';

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
export function renderSessionLine(rec: SessionView, opts?: { lineage?: boolean }): string {
  const status = rec.status ? `[${rec.status}]` : '';
  const wt = rec.worktreePath ? ` wt=${rec.worktreePath}` : '';
  const agent = rec.agentName ? ` agent=${rec.agentName}` : '';
  const alias = rec.alias ? ` alias=${aliasHandle(rec)}` : '';
  const model = rec.model ? ` model=${rec.model}` : '';
  let lineage = '';
  if (opts?.lineage || rec.rootRunId || rec.parentRunId || rec.stepId) {
    const parts: string[] = [];
    if (rec.rootRunId) parts.push(`root=${rec.rootRunId}`);
    if (rec.parentRunId) parts.push(`run=${rec.parentRunId}`);
    if (rec.stepId) parts.push(`step=${rec.stepId}`);
    if (rec.depth !== undefined) parts.push(`depth=${rec.depth}`);
    if (parts.length) lineage = ` ${parts.join(' ')}`;
  }
  return `${rec.id}  ${rec.provider} ${status} ${rec.tmuxName}${model}${agent}${alias}  cwd=${rec.cwd}${wt}${lineage}`.trim();
}

/** Multi-line human detail of a session record. */
export function renderSessionDetail(rec: SessionView): string {
  const lines = [
    `id:          ${rec.id}`,
    `sessionId:   ${rec.sessionId}`,
    `provider:    ${rec.provider}`,
    rec.model ? `model:       ${rec.model}` : null,
    rec.agentName ? `agentName:   ${rec.agentName}` : null,
    rec.alias ? `alias:       @${rec.alias}` : null,
    rec.alias ? `aliasKey:    ${aliasHandle(rec)}` : null,
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

export function renderSessionList(views: SessionView[], opts?: { lineage?: boolean }): string {
  if (views.length === 0) return '(no sessions)';
  return views.map((v) => renderSessionLine(v, opts)).join('\n');
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
    case 'attempt-transition':
      return `  · attempt ${e.attemptId} ${e.stepId} → ${e.phase}${e.sessionId ? ` session=${e.sessionId}` : ''}\n`;
    case 'lease-heartbeat':
      return `  · lease expires ${e.expiresAt}\n`;
    case 'run-resume':
      return `> resume ${e.runId} (from ${e.fromStatus})\n`;
    case 'run-retry':
      return `> retry ${e.runId}${e.stepId ? ` step ${e.stepId}` : ''}\n`;
    case 'run-cancel':
      return `= cancel ${e.runId}${e.cascade ? ' (cascade)' : ''}\n`;
    case 'attempt-adopt':
      return `  · adopt ${e.stepId} session=${e.sessionId}\n`;
    case 'step-scheduled':
      return `  · schedule ${e.stepId}${e.slotsRemaining !== undefined ? ` (slots left ${e.slotsRemaining})` : ''}\n`;
    case 'step-blocked':
      return `  · blocked ${e.stepId}: ${e.reason}\n`;

    default:
      return '';
  }
}

/**
 * Public status projection: max concurrency + per-step scheduling state.
 * Strips plan prompts/task files so list/get never leak credentials.
 */
export function publicRunView(run: WorkflowRun): Record<string, unknown> {
  const sched = schedulingSummary(run.plan, run.attempts, run.steps);
  const maxConcurrency = sched?.maxConcurrency ?? run.plan?.maxConcurrency ?? 1;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    schemaVersion: run.schemaVersion,
    revision: run.revision,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    definitionDigest: run.definitionDigest,
    maxConcurrency,
    policy: run.policy,
    lease: run.lease
      ? {
          ownerId: run.lease.ownerId,
          expiresAt: run.lease.expiresAt,
        }
      : undefined,
    runner: run.runner
      ? {
          pid: run.runner.pid,
          startedAt: run.runner.startedAt,
          logPath: run.runner.logPath,
        }
      : undefined,
    steps: run.steps.map((s) => ({
      id: s.id,
      provider: s.provider,
      ok: s.ok,
      state: s.state,
      outcome: s.outcome,
      sessionId: s.sessionId,
      commitsAhead: s.commitsAhead,
      worktree: s.worktree,
      branch: s.branch,
      unverified: s.unverified,
    })),
    scheduling: sched
      ? {
          maxConcurrency: sched.maxConcurrency,
          steps: sched.steps,
        }
      : undefined,
    attempts: (run.attempts ?? []).map((a) => ({
      attemptId: a.attemptId,
      attemptNumber: a.attemptNumber,
      stepId: a.stepId,
      phase: a.phase,
      sessionId: a.sessionId,
      errorCategory: a.errorCategory,
      errorMessage: a.errorMessage,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    })),
  };
}

/** Multi-line detail of a persisted run (for `orc workflow status`). */
export function renderRunDetail(run: WorkflowRun): string {
  const sched = schedulingSummary(run.plan, run.attempts, run.steps);
  const maxConcurrency = sched?.maxConcurrency ?? run.plan?.maxConcurrency ?? 1;
  const head = [
    `id:         ${run.id}`,
    `name:       ${run.name}`,
    `status:     ${run.status}`,
    run.schemaVersion !== undefined ? `schema:     ${run.schemaVersion}` : null,
    run.revision !== undefined ? `revision:   ${run.revision}` : null,
    `startedAt:  ${run.startedAt}`,
    run.finishedAt ? `finishedAt: ${run.finishedAt}` : null,
    run.rootRunId ? `rootRunId:  ${run.rootRunId}` : null,
    run.definitionDigest ? `digest:     ${run.definitionDigest.slice(0, 16)}…` : null,
    `maxConc:    ${maxConcurrency}`,
    run.lease ? `lease:      owner=${run.lease.ownerId} exp=${run.lease.expiresAt}` : null,
    run.runner
      ? `runner:     pid=${run.runner.pid} started=${run.runner.startedAt} log=${run.runner.logPath}`
      : run.legacyRunnerTmux
        ? `runner:     legacy tmux runner (gone${
            run.status === 'running' || run.status === 'orphaned' || run.status === 'failed'
              ? '; resumable'
              : ''
          })`
        : null,
    `steps:      ${run.steps.length}`,
    run.attempts?.length ? `attempts:   ${run.attempts.length}` : null,
  ].filter((l): l is string => l !== null);
  const steps = run.steps.map(renderStepResultLine);
  const schedLines =
    sched?.steps.map((s) => {
      const needs = s.needs.length ? ` needs=[${s.needs.join(',')}]` : '';
      const reason = s.reason ? ` — ${s.reason}` : '';
      return `  sched ${s.id} [${s.status}]${needs}${reason}`;
    }) ?? [];
  const attempts = (run.attempts ?? []).map(
    (a) =>
      `  attempt ${a.attemptNumber} ${a.stepId} [${a.phase}]` +
      (a.sessionId ? ` session=${a.sessionId}` : '') +
      (a.errorMessage ? ` err=${a.errorMessage}` : ''),
  );
  return [
    ...head,
    ...steps,
    ...(schedLines.length ? ['scheduling:', ...schedLines] : []),
    ...(attempts.length ? ['attempts:', ...attempts] : []),
  ].join('\n');
}

/** One line per run for `orc workflow list`. */
export function renderRunList(runs: WorkflowRun[]): string {
  if (runs.length === 0) return '(no runs)';
  return runs
    .map((r) => {
      const okCount = r.steps.filter((s) => s.ok).length;
      const maxC = r.plan?.maxConcurrency ?? 1;
      return `${r.id}  ${r.status.padEnd(7)} ${r.name}  steps=${okCount}/${r.steps.length}  maxC=${maxC}  ${r.startedAt}`;
    })
    .join('\n');
}

export const HELP_TEXT = `orc — multi-agent orchestration CLI

Usage:
  orc spawn  --provider <claude|codex|pi> [options]   Launch a new agent session
             aliases: agent, new
  orc send   <id|@alias> [PROMPT | - | @file] [--idempotency-key K]  Send a prompt (multi-line safe)
  orc read   <id|@alias> [--last|--index N|--full|--raw]  Latest parsed turn by default; --full = full transcript; --raw = full pane
  orc state  <id|@alias>                              Classify state once: starting|running|done|waiting|failed
  orc wait   <id|@alias> [--for S] [--timeout SEC]    Block until the agent settles (S: done|waiting|failed|settled)
  orc list   [--workspace W | --all | --dead | --all-hosts | --run ID | --lineage]  List sessions (alias: ps)
  orc attach <id|@alias> [--read-only]                Attach to the tmux session
  orc kill   <id|@alias> [--worktree] [--purge]       Kill session (mark dead; --purge removes record)
  orc prune  [--worktree]                             Drop marked-dead/gone records (+ optional worktrees)
  orc workflow <run|list|status|attach|logs|resume|retry|cancel|cleanup> ...  Workflows (alias: wf)
  orc daemon [--port 8787] [--bind <ip>] [--insecure] Serve the HTTP API over tailscale
  orc remote <add|list|rm> <host> [--port P]          Manage trusted peers (~/.orc/peers.json)
  orc help                                            This help

spawn options:
  --provider, -p <p>     claude | codex | pi (required)
  --model, -m <model>    model name
  --agent <name>         named agent definition (codex TOML matched by name; mutually exclusive with --system-prompt)
  --alias <name>         workspace-scoped session alias; later use @name or @workspace:name
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
  orc workflow run <file> [--detach] [--json] [--max-concurrency N]
                                      Import the file's default-exported WorkflowDef and
                                      run it, streaming step events (or --json the final WorkflowRun).
                                      Exits non-zero if the run failed. --detach runs it as a
                                      detached runner process and returns the runId immediately
                                      (--json: {runId,logPath}); its output goes to
                                      ~/.orc/runs/<runId>/runner.log.
                                      --max-concurrency N (positive int; default 1) allows
                                      dependency-free steps to run concurrently (DAG needs[]).
  orc workflow list [--json]          List persisted runs from ~/.orc/runs/ (newest first)
  orc workflow status <runId> [--json]  Print a run record (per-step state + attempts). A \`running\`
                                      record whose owner lease/runner has died is reported \`orphaned\`.
  orc workflow attach <runId> [--json]  Follow a --detach run's runner log until the run ends
                                      (Ctrl-C stops following); --json prints {runId,logPath,runner}.
  orc workflow logs <runId> [--step <id>] [--raw] [--json]  Per-step transcript ('### step <id>
                                      (<provider>)'). --raw shows the live pane; --json emits
                                      {step,turns}[] (or {step,provider,pane}[] with --raw).
  orc workflow resume <runId> [file] [--detach] [--json]
                                      Resume an incomplete run (skips successful attempts; adopts
                                      live owned sessions). Requires original workflow file when
                                      the plan used function \`done\` predicates (non-portable; prefer \`verify\`).
  orc workflow retry <runId> [--step id] [file] [--detach] [--json]
                                      New attempts for failed/incomplete steps (or --step and
                                      subsequent). Preserves attempt history.
  orc workflow cancel <runId> [--cascade] [--json]
                                      Idempotent cancel; --cascade kills only sessions proven owned
                                      by this run/root (never unrelated sessions).
  orc workflow cleanup <runId> [--sessions] [--worktrees] [--json]
                                      Explicit cleanup of owned sessions/worktrees only.

A workflow file default-exports a PLAIN object { name, steps[] } — no import required
(runWorkflow validates the shape). A step succeeds by an explicit \`done\` predicate over a
HARD signal (a commit, a file); a worktree step defaults to state==='done' && commitsAhead>=1.
A non-worktree step with no predicate is reported \`unverified\` — a yield is NOT success.
Run status: running | done | failed | orphaned | cancelled.
Durable attempts use phases: queued|spawning|dispatched|running|verifying|succeeded|failed|
waiting|cancelled|abandoned. Foreground runs carry an owner lease so crashes reconcile.
Not exactly-once across process boundaries — durable intent, adoption, and compensation.
Token/cost budgets are not measurable and are not enforced; ExecutionPolicy supports
maxDepth, maxSessions, maxConcurrentSessions, deadlineMs, canDelegate.

daemon + remote (drive agents on other orc hosts over tailscale):
  orc daemon            Run Bun.serve exposing the SDK as JSON. Binds to this host's
                        tailscale IP by DEFAULT (never 0.0.0.0); refuses an unsafe --bind
                        unless --insecure. --bind 127.0.0.1 for local testing. Every route
                        except GET /health is behind FAIL-CLOSED authn+authz:
                        allowlisted tailnet identity (all scopes), OR Authorization:
                        Bearer token from ORC_DAEMON_TOKENS (JSON token→scopes), OR
                        legacy x-orc-secret == \$ORC_DAEMON_SECRET (all scopes). Missing/
                        invalid credentials → 401; authenticated but missing scope → 403.
                        Scopes: sessions:read|write, workflows:read|write, admin (implies all).
                        Kill/cancel/cleanup require admin; read/list require *:read;
                        spawn/send/wait/run/resume/retry require *:write.
  orc remote add <h>    Trust peer <h> (also the host list for --host / --all-hosts).
  orc --host <h> <cmd>  Run <cmd> against the daemon on <h> (host or host:port) over HTTP
                        instead of locally — list/spawn/send/read/wait/state/kill/workflow.
                        Output (and --json) is identical to local. Sends Bearer from
                        \$ORC_DAEMON_TOKEN and/or x-orc-secret from \$ORC_DAEMON_SECRET when set.
                        Remote attach prints a tailscale ssh hint (attach is host-local).
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

Session aliases are active-session handles, not agent definitions. Spawn with
\`--alias debugger\`, then address it as \`@debugger\` from the same workspace or
\`@orc:debugger\` from outside a workspace named \`orc\`. The same alias cannot be
used by two active sessions in one workspace, but can be reused after the old session
is killed or pruned. Dead transcript records remain addressable by id.

State meaning: 'done' = the composer is idle and ready for YOUR input (NOT "succeeded"
— it also covers an agent that asked a clarifying question, which is pane-identical to
a finished turn). 'waiting' = blocked on a TUI modal (trust/approval/update). 'failed'
= the pane is gone (crash OR clean exit like /exit — "terminated", not "errored").
`;
