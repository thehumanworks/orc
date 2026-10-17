/**
 * Human + JSON renderers for the orc CLI.
 *
 * Every human renderer takes an optional Style (default PLAIN = byte-identical unstyled
 * text); the CLI passes the style of the stream it writes to (see setTerminalStyles).
 * JSON output is never styled.
 */
import type { AgentState, SessionRecord, SessionStatus } from '../types.ts';
import type { WorkflowEvent, WorkflowRun, StepResult } from '../workflow.ts';
import { schedulingSummary } from '../workflow-scheduler.ts';
import { aliasHandle } from '../registry.ts';
import { PLAIN, TONE_STYLES, resolveStyle, sgr, toneOf } from '../style.ts';
import type { Attr, Style } from '../style.ts';
import { TerminalSanitizer } from '../terminal-text.ts';

export interface SessionView extends SessionRecord {
  /** running | suspended | dead (derived from the kernel; see SessionStatus). */
  status?: SessionStatus;
  /** Derived agent state, when cheap to compute. */
  state?: AgentState;
}

/** The styles of the CLI's two output streams (decided per stream in main()). */
export interface TerminalStyles {
  out: Style;
  err: Style;
}

let terminal: TerminalStyles = { out: PLAIN, err: PLAIN };

/** Set once by the CLI entry point; everything defaults to PLAIN until then. */
export function setTerminalStyles(styles: TerminalStyles): void {
  terminal = styles;
}

export function terminalStyles(): TerminalStyles {
  return terminal;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** `error: <message>` (one line per call; `st` = the stderr style). */
export function formatError(message: string, st: Style = PLAIN): string {
  return `${st.errorLabel('error:')} ${st.text(message)}\n`;
}

/** `warning: <message>` (one line per call; `st` = the stderr style). */
export function formatWarning(message: string, st: Style = PLAIN): string {
  return `${st.warningLabel('warning:')} ${st.text(message)}\n`;
}

export function printError(message: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(formatError(message, terminal.err));
  }
}

/** ` key=value`: the key dim, the value in `role` (default: unstyled). */
function kv(st: Style, key: string, value: string, role: (s: string) => string = st.text): string {
  return ` ${st.label(`${key}=`)}${role(value)}`;
}

/** One-line human summary of a session record. */
export function renderSessionLine(rec: SessionView, opts?: { lineage?: boolean; style?: Style }): string {
  const st = resolveStyle(opts?.style);
  const status = rec.status ? st.tag(rec.status) : '';
  const wt = rec.worktreePath ? kv(st, 'wt', rec.worktreePath, st.muted) : '';
  const agent = rec.agentName ? kv(st, 'agent', rec.agentName) : '';
  const alias = rec.alias ? kv(st, 'alias', aliasHandle(rec) ?? '', st.alias) : '';
  const model = rec.model ? kv(st, 'model', rec.model) : '';
  let lineage = '';
  if (opts?.lineage || rec.rootRunId || rec.parentRunId || rec.stepId) {
    const parts: string[] = [];
    if (rec.rootRunId) parts.push(kv(st, 'root', rec.rootRunId, st.muted));
    if (rec.parentRunId) parts.push(kv(st, 'run', rec.parentRunId, st.muted));
    if (rec.stepId) parts.push(kv(st, 'step', rec.stepId, st.muted));
    if (rec.depth !== undefined) parts.push(kv(st, 'depth', String(rec.depth), st.muted));
    if (parts.length) lineage = parts.join('');
  }
  const state = rec.state ? ` ${st.tone(rec.state)}` : '';
  const legacy = rec.legacy ? kv(st, 'legacy', rec.legacy, st.muted) : '';
  // Kept by `orc prune` (unless --taken-over): the human holds it; hand back with resume.
  const taken = rec.stoppedBy === 'takeover' ? ` ${st.warning(`taken-over(hand back: orc resume ${rec.id})`)}` : '';
  return `${st.id(rec.id)}  ${st.text(rec.provider)} ${status}${state}${model}${agent}${alias}${legacy}${taken}  ${st.label('cwd=')}${st.muted(rec.cwd)}${wt}${lineage}`.trim();
}

/** `label` (dim) padded to `width` columns, then the (already styled) value. */
function field(st: Style, label: string, width: number, value: string): string {
  return `${st.label(label)}${' '.repeat(Math.max(0, width - label.length))}${value}`;
}

/** Multi-line human detail of a session record. */
export function renderSessionDetail(rec: SessionView, style?: Style): string {
  const st = resolveStyle(style);
  const f = (label: string, value: string) => field(st, label, 13, value);
  const lines = [
    f('id:', st.id(rec.id)),
    f('sessionId:', st.muted(rec.sessionId)),
    f('provider:', st.text(rec.provider)),
    rec.model ? f('model:', st.text(rec.model)) : null,
    rec.agentName ? f('agentName:', st.text(rec.agentName)) : null,
    rec.alias ? f('alias:', st.alias(`@${rec.alias}`)) : null,
    rec.alias ? f('aliasKey:', st.alias(aliasHandle(rec) ?? '')) : null,
    rec.status ? f('status:', st.status(rec.status)) : null,
    rec.state ? f('state:', st.status(rec.state)) : null,
    rec.providerSessionId ? f('providerId:', st.muted(rec.providerSessionId)) : null,
    rec.legacy ? f('legacy:', st.muted(`${rec.legacy}${rec.legacyTmuxName ? ` (${rec.legacyTmuxName})` : ''}`)) : null,
    f('cwd:', st.muted(rec.cwd)),
    rec.worktreePath ? f('worktree:', st.muted(rec.worktreePath)) : null,
    rec.branch ? f('branch:', st.text(rec.branch)) : null,
    f('workspace:', st.muted(rec.workspace)),
    f('createdAt:', st.muted(rec.createdAt)),
    f('attach:', st.command(`orc attach ${rec.id}`)),
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

export function renderSessionList(views: SessionView[], opts?: { lineage?: boolean; style?: Style }): string {
  const st = resolveStyle(opts?.style);
  if (views.length === 0) return st.muted('(no sessions)');
  return views.map((v) => renderSessionLine(v, { ...opts, style: st })).join('\n');
}

/** A session view tagged with the host it lives on (for `orc list --all-hosts`). */
export interface HostSessionView extends SessionView {
  host: string;
}

/** Like `renderSessionList`, with a leading `host` column (the fleet view). */
export function renderSessionListWithHost(views: HostSessionView[], style?: Style): string {
  const st = resolveStyle(style);
  if (views.length === 0) return st.muted('(no sessions)');
  // Pad the plain (sanitized) host first, then style: codes never count toward the width.
  return views.map((v) => `${st.muted(st.text(v.host).padEnd(14))} ${renderSessionLine(v, { style: st })}`).join('\n');
}

/** One human line per workflow step result (plain; styled by styleWorkflowLine). */
function renderStepResultLine(r: StepResult): string {
  const mark = r.ok ? 'ok' : 'FAIL';
  const flag = r.unverified ? ' UNVERIFIED' : '';
  const wt = r.worktree ? ` worktree=${r.worktree}` : '';
  return `  [${mark}] ${r.id} (${r.provider}) state=${r.state} commitsAhead=${r.commitsAhead}${flag}  session=${r.sessionId}${wt}`;
}

/** The plain progress line(s) of one workflow event (trailing newline; '' for unknown events). */
function workflowEventText(e: WorkflowEvent): string {
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
 * Render a streamed workflow event as a human progress line (trailing newline). Colour is
 * applied by `styleWorkflowText` over the plain line — the same styler `orc workflow
 * attach` applies to a detached runner's (plain) log, so both views look alike.
 */
export function renderWorkflowEvent(e: WorkflowEvent, style?: Style): string {
  const st = resolveStyle(style);
  return styleWorkflowText(st.text(workflowEventText(e)), st);
}

// ---------------------------------------------------------------------------------------
// Workflow progress lines: colour by pattern (one styler for live events and runner logs)
// ---------------------------------------------------------------------------------------

const STEP_RESULT_RE =
  /^  \[(ok|FAIL)\] (\S+) \((\S+)\) state=(\S+) commitsAhead=(\S+)( UNVERIFIED)?  session=(\S*)( worktree=(.*))?$/;
const STEP_START_RE = /^  - (\S+) \[(\S+)\] running\.\.\.$/;
const STEP_WARN_RE = /^  ! warning: (.*)$/;
const STEP_ERROR_RE = /^  ! (\S+) error: (.*)$/;
const STEP_BLOCKED_RE = /^  · blocked (\S+): (.*)$/;
const RUN_START_RE = /^> run (\S+) '(.*)' \((\d+ steps?)\)$/;
const RUN_RESUME_RE = /^> resume (\S+) \(from (\S+)\)$/;
const RUN_RETRY_RE = /^> retry (\S+)( step (\S+))?$/;
const RUN_DONE_RE = /^= run (\S+) (\S+)$/;
const RUN_CANCEL_RE = /^= cancel (\S+)( \(cascade\))?$/;

/**
 * One plain workflow progress line (an event, a step result, or a runner-log line) in
 * colour. Lines it does not recognise are returned unchanged. Only SGR codes are added,
 * except that the `[ok]` / `[FAIL]` / `-` markers become the same-width `✓ ok` / `✗ FAIL`
 * / `●` glyph forms. `line` must already be sanitized (when sanitizing applies).
 */
export function styleWorkflowLine(line: string, st: Style): string {
  if (!st.color) return line;
  const p = (s: string, ...attrs: Attr[]) => sgr(s, attrs);
  const toned = (word: string, s: string = word) => {
    const t = toneOf(word);
    return t ? sgr(s, TONE_STYLES[t].attrs) : s;
  };
  const glyphed = (word: string) => {
    const t = toneOf(word);
    return t ? sgr(`${TONE_STYLES[t].glyph} ${word}`, TONE_STYLES[t].attrs) : word;
  };
  let m: RegExpExecArray | null;
  if ((m = STEP_RESULT_RE.exec(line))) {
    const [, mark, id, provider, state, ahead, unverified, session, , wt] = m;
    return (
      `  ${p(`${TONE_STYLES[mark === 'ok' ? 'success' : 'danger'].glyph} ${mark}`, mark === 'ok' ? 'green' : 'red')}` +
      ` ${p(id!, 'bold')} ${p(`(${provider})`, 'dim')} ${p('state=', 'dim')}${toned(state!)}` +
      ` ${p('commitsAhead=', 'dim')}${ahead}${unverified ? ` ${p('UNVERIFIED', 'bold', 'yellow')}` : ''}` +
      `  ${p(`session=${session}`, 'dim')}${wt !== undefined ? ` ${p(`worktree=${wt}`, 'dim')}` : ''}`
    );
  }
  if ((m = STEP_START_RE.exec(line))) {
    return `  ${p('●', 'cyan')} ${p(m[1]!, 'bold')} ${p(`[${m[2]}]`, 'dim')} ${p('running...', 'cyan')}`;
  }
  if ((m = STEP_WARN_RE.exec(line))) return `  ${p('! warning:', 'yellow')} ${m[1]}`;
  if ((m = STEP_ERROR_RE.exec(line))) return `  ${p('!', 'red')} ${p(m[1]!, 'bold')} ${p('error:', 'red')} ${m[2]}`;
  if ((m = STEP_BLOCKED_RE.exec(line))) return `  ${p('· blocked', 'yellow')} ${p(m[1]!, 'bold')}: ${m[2]}`;
  if (line.startsWith('  · ')) return p(line, 'dim');
  if ((m = RUN_START_RE.exec(line))) {
    return `${p('>', 'bold', 'cyan')} ${p('run', 'bold')} ${p(m[1]!, 'bold')} '${m[2]}' ${p(`(${m[3]})`, 'dim')}`;
  }
  if ((m = RUN_RESUME_RE.exec(line))) {
    return `${p('>', 'bold', 'cyan')} ${p('resume', 'bold')} ${p(m[1]!, 'bold')} ${p('(from ', 'dim')}${toned(m[2]!)}${p(')', 'dim')}`;
  }
  if ((m = RUN_RETRY_RE.exec(line))) {
    return `${p('>', 'bold', 'cyan')} ${p('retry', 'bold')} ${p(m[1]!, 'bold')}${m[2] ? ` ${p('step', 'dim')} ${p(m[3]!, 'bold')}` : ''}`;
  }
  if ((m = RUN_DONE_RE.exec(line))) return `${p('= run', 'bold')} ${p(m[1]!, 'bold')} ${glyphed(m[2]!)}`;
  if ((m = RUN_CANCEL_RE.exec(line))) {
    return `${p('=', 'bold')} ${toned('cancelled', 'cancel')} ${p(m[1]!, 'bold')}${m[2] ? p(m[2], 'dim') : ''}`;
  }
  if (line.startsWith('# ')) return p(line, 'dim');
  return line;
}

/** `styleWorkflowLine` over every line of `text` (newlines kept). */
export function styleWorkflowText(text: string, st: Style): string {
  if (!st.color) return text;
  return text
    .split('\n')
    .map((l) => styleWorkflowLine(l, st))
    .join('\n');
}

/**
 * The sink `orc workflow attach` follows a runner log into. The log is plain text (a
 * detached runner never colours it). Writing to a TTY, the stream is made terminal-safe
 * (escape sequences may span chunks); with colour, each complete line is styled like a
 * live `workflow run` (a partial line waits for its newline, or for `end`). Piped without
 * colour it is a passthrough.
 */
export function runnerLogWriter(
  st: Style,
  sink: (text: string) => void,
): { write: (text: string) => void; end: () => void } {
  if (!st.color && !st.sanitize) return { write: sink, end: () => {} };
  const sanitizer = st.sanitize ? new TerminalSanitizer() : undefined;
  const clean = (t: string): string => (sanitizer ? sanitizer.push(t) : t);
  if (!st.color) {
    return {
      write: (t) => {
        const c = clean(t);
        if (c) sink(c);
      },
      end: () => void sanitizer?.end(),
    };
  }
  let pending = '';
  return {
    write: (t) => {
      pending += clean(t);
      const nl = pending.lastIndexOf('\n');
      if (nl === -1) return;
      sink(styleWorkflowText(pending.slice(0, nl + 1), st));
      pending = pending.slice(nl + 1);
    },
    end: () => {
      sanitizer?.end();
      if (pending) sink(styleWorkflowText(pending, st));
      pending = '';
    },
  };
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
    ...(run.defaultModels ? { defaultModels: run.defaultModels } : {}),
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
export function renderRunDetail(run: WorkflowRun, style?: Style): string {
  const st = resolveStyle(style);
  const f = (label: string, value: string) => field(st, label, 12, value);
  const sched = schedulingSummary(run.plan, run.attempts, run.steps);
  const maxConcurrency = sched?.maxConcurrency ?? run.plan?.maxConcurrency ?? 1;
  const head = [
    f('id:', st.id(run.id)),
    f('name:', st.text(run.name)),
    f('status:', st.status(run.status)),
    run.schemaVersion !== undefined ? f('schema:', st.muted(String(run.schemaVersion))) : null,
    run.revision !== undefined ? f('revision:', st.muted(String(run.revision))) : null,
    f('startedAt:', st.muted(run.startedAt)),
    run.finishedAt ? f('finishedAt:', st.muted(run.finishedAt)) : null,
    run.rootRunId ? f('rootRunId:', st.muted(run.rootRunId)) : null,
    run.definitionDigest ? f('digest:', st.muted(`${run.definitionDigest.slice(0, 16)}…`)) : null,
    f('maxConc:', st.text(String(maxConcurrency))),
    run.lease
      ? f('lease:', `${st.label('owner=')}${st.text(run.lease.ownerId)}${kv(st, 'exp', run.lease.expiresAt, st.muted)}`)
      : null,
    run.runner
      ? f(
          'runner:',
          `${st.label('pid=')}${st.text(String(run.runner.pid))}${kv(st, 'started', run.runner.startedAt, st.muted)}${kv(st, 'log', run.runner.logPath, st.muted)}`,
        )
      : run.legacyRunnerTmux
        ? f(
            'runner:',
            st.muted(
              `legacy pre-actor runner (gone${
                run.status === 'running' || run.status === 'orphaned' || run.status === 'failed'
                  ? '; resumable'
                  : ''
              })`,
            ),
          )
        : null,
    f('steps:', String(run.steps.length)),
    run.attempts?.length ? f('attempts:', String(run.attempts.length)) : null,
  ].filter((l): l is string => l !== null);
  const steps = run.steps.map((r) => styleWorkflowLine(st.text(renderStepResultLine(r)), st));
  const schedLines =
    sched?.steps.map((s) => {
      const needs = s.needs.length ? kv(st, 'needs', `[${s.needs.join(',')}]`, st.muted) : '';
      const reason = s.reason ? ` ${st.muted('—')} ${st.text(s.reason)}` : '';
      return `  ${st.label('sched')} ${st.bold(s.id)} ${st.tag(s.status)}${needs}${reason}`;
    }) ?? [];
  const attempts = (run.attempts ?? []).map(
    (a) =>
      `  ${st.label('attempt')} ${a.attemptNumber} ${st.bold(a.stepId)} ${st.tag(a.phase)}` +
      (a.sessionId ? kv(st, 'session', a.sessionId, st.muted) : '') +
      (a.errorMessage ? kv(st, 'err', a.errorMessage, st.danger) : ''),
  );
  return [
    ...head,
    ...steps,
    ...(schedLines.length ? [st.heading('scheduling:'), ...schedLines] : []),
    ...(attempts.length ? [st.heading('attempts:'), ...attempts] : []),
  ].join('\n');
}

/** One line per run for `orc workflow list`. */
export function renderRunList(runs: WorkflowRun[], style?: Style): string {
  const st = resolveStyle(style);
  if (runs.length === 0) return st.muted('(no runs)');
  return runs
    .map((r) => {
      const okCount = r.steps.filter((s) => s.ok).length;
      const maxC = r.plan?.maxConcurrency ?? 1;
      return `${st.id(r.id)}  ${st.status(r.status, 7)} ${st.text(r.name)}  ${st.label('steps=')}${okCount}/${r.steps.length}  ${st.label('maxC=')}${maxC}  ${st.muted(r.startedAt)}`;
    })
    .join('\n');
}

export const HELP_TEXT = `orc — multi-agent orchestration CLI

Usage:
  orc spawn  --provider <claude|codex|pi> [options]   Launch a new agent session
             aliases: agent, new
  orc send   <id|@alias> [PROMPT | - | @file] [--idempotency-key K] [--no-wake]
                                                      Send a prompt (multi-line safe; wakes a suspended session)
  orc read   <id|@alias> [--last|--index N|--full|--raw]  Latest parsed turn by default; --full = full transcript; --raw = session journal
  orc state  <id|@alias>                              Derived state: starting|running|done|waiting|failed
  orc wait   <id|@alias> [--for S] [--timeout SEC]    Block until the agent settles (S: done|waiting|failed|settled)
  orc list   [--workspace W | --all | --dead | --all-hosts | --run ID | --lineage]  List sessions (alias: ps)
  orc attach <id|@alias>                              Follow the session live (read-only journal view)
  orc kill   <id|@alias> [--worktree] [--purge]       Stop the session (sticky; record kept; --purge removes record + journal)
  orc resume <id|@alias>                              Hand a killed/taken-over/suspended session back to an actor
  orc takeover <id|@alias>                            Stop orc's actor and print the provider's own resume command
  orc prune  [--worktree] [--suspended] [--taken-over] Drop dead records (+ journals; optional worktrees)
  orc workflow <run|list|status|attach|logs|resume|retry|cancel|cleanup> ...  Workflows (alias: wf)
  orc daemon [--port 8787] [--bind <ip>] [--insecure] Serve the HTTP API over tailscale
  orc remote <add|list|rm> <host> [--port P]          Manage trusted peers (~/.orc/peers.json)
  orc login  chatgpt [--import-pi] [--no-browser]     Sign in with ChatGPT for the codex provider
  orc login  status [--json]                          Which OpenAI credential codex sessions use
  orc logout chatgpt                                  Remove orc's ChatGPT credential
  orc settings [--json]                               Effective settings (ORC_HOST, settings.toml) and their sources
  orc mcp    [--wait-timeout SEC]                     Serve orc's commands as MCP tools over stdio (for a lead agent)
  orc help                                            This help
  orc --version [--json]                              This binary's version (alias: -V; never remote)

spawn options:
  --provider, -p <p>     claude | codex | pi (required unless settings.toml sets \`provider\`)
  --model, -m <model>    model name (default: settings.toml [models].<provider>, unless --agent)
  --agent <name>         named agent definition (codex TOML matched by name; mutually exclusive with --system-prompt)
  --alias <name>         workspace-scoped session alias; later use @name or @workspace:name
  --system-prompt <txt>  system prompt text
  --system-prompt-mode   append (default) | replace
  --prompt <txt|-|@f>    initial prompt sent once the provider is ready (- stdin, @f file)
  --cwd <dir>            base working directory (default: cwd)
  --workspace <w>       logical workspace key
  --worktree            create a fresh git worktree as cwd
  --branch <b>          worktree branch name
  --no-wait             return once the session's actor has started (no readiness wait);
                        an initial --prompt is queued and delivered when ready

send options:
  --idempotency-key K   message id: a replay with the same K returns the recorded phase
                        (replayed) instead of sending again; K with different text is an error
  --no-wake             only queue the message; do not wake a suspended session
  exit: 0 acknowledged or queued, 3 unknown (cut before the provider acknowledged it;
  never re-sent automatically), 1 failed

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
                                      (<provider>)'). --raw shows each step session's journal
                                      tail; --json emits {step,turns}[] (or {step,provider,journal}[]
                                      with --raw).
  orc workflow resume <runId> <file> [--detach] [--json]
                                      Resume an incomplete run (skips successful attempts; adopts
                                      in-flight steps whose instruction reached a still-resumable
                                      session). <file> is the original workflow file (required
                                      locally; over --host it defaults to the run's recorded file).
  orc workflow retry <runId> [--step id] <file> [--detach] [--json]
                                      New attempts for failed/incomplete steps (or --step and
                                      subsequent). Preserves attempt history. <file> as for resume.
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
maxDepth, maxSessions, maxConcurrentSessions (live actors), deadlineMs, canDelegate.

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
                        spawn/send/wait/run/resume/retry require *:write. Other errors:
                        400 bad request, 403 policy violation, 404 unknown session/run,
                        409 stopped session / idempotency conflict / legacy session / run
                        state, 502 provider failed to start, 500 anything else.
  orc remote add <h>    Trust peer <h> (also the host list for --host / --all-hosts).
  orc --host <h> <cmd>  Run <cmd> against the daemon on <h> (host or host:port) over HTTP
                        instead of locally — list/spawn/send/read/wait/state/kill/workflow.
                        Output (and --json) matches local, except: state --json is only
                        {id,state,status,suspended,stopped}; list takes only --workspace/
                        --all/--dead (rows have no lineage); workflow resume/retry take no
                        --detach. Sends Bearer from \$ORC_DAEMON_TOKEN and/or x-orc-secret
                        from \$ORC_DAEMON_SECRET when set. Remote attach / workflow attach
                        print a \`tailscale ssh <host> orc …\` command instead of following.
  orc list --all-hosts  Fleet view: aggregate local + every trusted peer, with a host column.

mcp (orc's commands as tools for a lead agent):
  orc mcp               MCP over stdio. Tools: spawn send wait read state list kill resume prune
                        settings guide workflow_run|list|status|logs|resume|retry|cancel|cleanup.
                        Each runs \`orc <cmd> … --json\` (spawn with --no-wait, workflows with
                        --detach); \`host\` sends a call to a peer's daemon. The server's
                        instructions and the \`guide\` tool teach the lead the team method.
                        wait returns within --wait-timeout SEC (default 45): call it again.
  orc daemon            Also serves those tools at http://<bind>:<port>/mcp (Streamable HTTP),
                        always run on the daemon host, behind the daemon's auth. Each tool needs
                        its REST scope: sessions:read (read state list wait settings),
                        sessions:write (spawn send resume), workflows:read|write, admin (kill
                        prune workflow cancel|cleanup). Host and Origin must name the daemon:
                        --mcp-allow-host H (repeatable) adds a name.

settings (ORC_HOST + settings.toml):
  host = "studio"       default remote target (host or host:port, as --host)
  provider = "claude"   default spawn --provider
  [models]              default --model per provider (spawn, and workflow steps)
  claude = "haiku"
  Files: global \$ORC_HOME/settings.toml (~/.orc/settings.toml); local: the NEAREST
  <dir>/.orc/settings.toml from the cwd up to its git toplevel (outside a repo: the cwd only).
  Local overrides global per key ([models] per provider). Unknown keys warn on stderr; a bad
  value or file is an error naming the file and key. An invalid ORC_HOST refuses only the
  commands it would route (not with --local / --host).
  host:     --local > --host > ORC_HOST (set; "" = no default host) > local > global > this host
  provider: --provider > local > global (else spawn errors)
  model:    --model > local [models] > global [models] > the provider's own default
  A default host applies to list/spawn/send/read/wait/state/kill/attach/workflow (not to
  list --all-hosts) and prints \`orc: → <host> (from <ORC_HOST|file>)\` on stderr. Host-local
  commands ignore it. A host from a LOCAL file must be a trusted peer (orc remote add) or your
  global settings host, else the command is refused. Inside an orc session (ORC_PARENT_SESSION_ID / ORC_DEPTH>=1 set)
  default hosts are ignored; --host still works. ORC_HOST never reaches agent processes.
  spawn defaults resolve here and are sent explicitly (also over --host). A local workflow
  run fixes its [models] at start (run.defaultModels); resume/retry and detached runners use
  that record, never settings; over --host the daemon applies no [models] (also --detach). A
  detached runner always runs with --local. The SDK reads no settings files (loadSettings()).

codex provider (orc's built-in harness; no codex CLI needed):
  Talks to the OpenAI Responses API directly. Credentials, first match wins: \`orc login
  chatgpt\` (~/.orc/auth/chatgpt.json), pi's ChatGPT login (~/.pi/agent/auth.json, or
  $PI_CODING_AGENT_DIR), then OPENAI_API_KEY. Without --model a session uses the first model
  your ChatGPT account lists (API key: the newest chat model pi-ai knows); spawn prints it.
  Tools: read, write, edit, bash, ls. No context compaction yet: a turn that overflows the
  model's context window fails — start a new session. \`orc takeover\` prints
  \`pi --session <file>\` (pi's session format; pi needs its own OpenAI login).

Global:
  --host <h>            Run the command against the daemon on host <h> (see above)
  --local               Run here, ignoring --host, ORC_HOST and settings.toml \`host\`
  --json                machine-readable output; non-zero exit + {error} on failure
  --color[=WHEN]        colour: auto (default: only when writing to a terminal) | always | never
  --no-color            same as --color=never. NO_COLOR=1 also disables colour, FORCE_COLOR=1
                        forces it (the flags win); --json output is never coloured

Sessions run as detached per-session actors that drive each provider over a structured
protocol (no terminal). Status: running (actor live) | suspended (actor gone without a
stop — crash/reboot; the next send or \`orc resume\` wakes it) | spawning (being created
right now) | dead (killed, taken over, pre-actor legacy, or a codex app-server session).
\`orc list\` shows running + suspended + spawning; --dead/--all include dead. \`orc prune\`
never removes suspended sessions unless --suspended, nor sessions taken over by
\`orc takeover\` unless --taken-over (their dir holds the system prompt the printed provider
resume command uses; hand back with \`orc resume <id>\`).

read defaults to the latest parsed conversation turn. --full emits the full parsed
transcript, --index N emits zero-based parsed turn N, and --raw emits the session journal
(JSONL; --json: {id,journal}). If no transcript exists yet it falls back to the journal
rendered as text (--json: {id,fallback:true,journal}).
state --json emits {id,state,status,stopped,suspended,live,pendingMessages,openTurn?,
lastTurn?,stopReason?,legacy?}. wait --json emits {id,state,elapsedMs,timedOut}; exit 0 iff a
requested state was reached.
send --json emits {ok,id,phase,messageId,replayed}.
takeover prints \`cd <cwd> && <provider resume command>\` (--json: {id,cwd,command});
\`orc resume <id>\` hands the session back. attach --json: {id,command,journalPath}.

Session aliases are active-session handles, not agent definitions. Spawn with
\`--alias debugger\`, then address it as \`@debugger\` from the same workspace or
\`@orc:debugger\` from outside a workspace named \`orc\`. The same alias cannot be
used by two active (running or suspended) sessions in one workspace, but can be reused
after the old session is killed or pruned. Dead records remain addressable by id.

State meaning (derived from the session journal): 'done' = no open turn and nothing
queued — ready for YOUR input (NOT "succeeded"; it also covers an agent that asked a
clarifying question). 'running' = a turn is open or messages are queued. 'waiting' = the
provider asked for a permission decision. 'failed' = the last turn failed or the session
is not live (stopped, or suspended and resumable — see \`orc state --json\`).
`;

/** A column-0 help line ending in `:` is a section heading. */
const HELP_HEADING_RE = /^\S.*:$/;
/** A usage row's command (`orc` + its subcommand words) at a two-space indent. */
const HELP_COMMAND_RE = /^( {2})(orc(?: {1,2}[a-z][a-z-]*)*)/;
/** Flags (`--name`, `-p`; not inside words) and `<placeholders>`. */
const HELP_TOKEN_RE = /(^|[^\w-])(--?[a-z][a-z0-9-]*)|(<[^<>\s]+>)/g;

/**
 * HELP_TEXT styled at print time (HELP_TEXT itself stays plain): headings bold, command
 * names bold cyan, flags cyan, placeholders italic. Only SGR codes are added, so the
 * text is unchanged once they are stripped. PLAIN (the default) returns HELP_TEXT as is.
 */
export function renderHelp(style?: Style): string {
  const st = resolveStyle(style);
  if (!st.color) return HELP_TEXT;
  return HELP_TEXT.split('\n')
    .map((line, i) => {
      if (i === 0 || HELP_HEADING_RE.test(line)) return sgr(line, ['bold']);
      const cmd = HELP_COMMAND_RE.exec(line);
      const head = cmd ? `${cmd[1]}${sgr(cmd[2]!, ['bold', 'cyan'])}` : '';
      const rest = cmd ? line.slice(cmd[0].length) : line;
      return (
        head +
        rest.replace(HELP_TOKEN_RE, (_m, pre: string | undefined, flag: string | undefined, ph: string | undefined) =>
          flag !== undefined ? `${pre ?? ''}${sgr(flag, ['cyan'])}` : sgr(ph ?? '', ['italic']),
        )
      );
    })
    .join('\n');
}
