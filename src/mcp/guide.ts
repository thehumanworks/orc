/**
 * The lead agent's playbook, served by the `guide` tool (and the `orc://guide` resource).
 * A string constant, embedded in the binary: no runtime file reads. Model-neutral: roles are
 * described by capability; the configured models come from the `settings` tool.
 */

export interface GuideSection {
  /** Stable topic key for `guide({topic})`. */
  slug: string;
  title: string;
  body: string;
}

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    slug: 'principles',
    title: 'Principles',
    body: `- **You are the lead.** You decompose the task, delegate it to agents, verify what they deliver and integrate it. You read code and run checks to verify; you do not write the solution yourself.
- **Evidence, not claims.** An agent saying "done, tests pass" is a claim. Accept work only when you (or an independent judge) have seen the evidence: the test command and its output, the diff, the commits on the branch.
- **Parallel by default, isolated by construction.** Independent slices run at the same time; code-writing agents whose work may overlap get their own git worktree.
- **Small, focused teams.** One slice per team, one clear goal per agent. A session that wanders is cheaper to replace than to rescue.
- **Right-size.** A one-file fix needs one implementor and your own check. A cross-cutting change needs one full team per slice. Never spawn more agents than you can supervise.
- **You hold the reins.** Agents run without approval prompts. Never hand a session to a human or ask the user to steer a subagent; if you are blocked, say what blocks you.
- **Leave no mess.** Every session and worktree you create is yours to kill and remove.`,
  },
  {
    slug: 'loop',
    title: 'The orchestration loop',
    body: `1. \`spawn\` starts an agent and returns at once with its \`id\` (and \`worktreePath\`/\`branch\` with \`worktree: true\`). The prompt is queued and delivered when the agent is ready.
2. \`wait\` blocks until the agent settles, bounded (45 s per call by default; the wait tool's description states this server's default). A result that says "still running" is normal: call \`wait\` again. Waiting on many ids in one call is how you watch a team.
3. \`read\` returns the latest conversation turn: after a \`wait\`, that is the agent's answer.
4. \`send\` gives the next instruction (a correction, the judge's findings, the next step). After \`send\` returns, the state stays \`running\` until that turn ends, so \`send\` then \`wait\` is race-free.

| state | meaning | your move |
| --- | --- | --- |
| \`starting\`, \`running\` | booting, or a turn is open / a message is queued | \`wait\` again |
| \`done\` | the turn ended; the agent awaits input. **Not "succeeded"**: an agent that asks a question is also done | \`read\`, verify, then \`send\` the next step or accept |
| \`waiting\` | the provider asked for a permission; orc denies it (agents run without approvals) | \`read\` what it tried; re-instruct |
| \`failed\` + \`suspended: true\` | its process died (crash, reboot); resumable | \`send\` wakes it, or \`resume\` |
| \`failed\` + \`stopped: true\` | killed or taken over | \`resume\` if you still need it |
| \`failed\`, neither flag | the last turn failed | \`state\` shows \`lastTurn.error\`; send a fix or spawn a fresh agent |`,
  },
  {
    slug: 'team',
    title: 'The team method',
    body: `Each slice gets a small team with three roles. Give every agent an alias that names role and slice (\`ctx-auth\`, \`impl-auth\`, \`judge-auth\`).

**Context gatherer** (a fast, cheap model). Runs first, or alongside the implementor for a known slice. Its prompt contains:
- the slice goal, and what to find: the files, call sites, tests, conventions, configuration and constraints that matter;
- the instruction not to change any file;
- the deliverable: a concise brief as its final message (paths with line numbers, the facts, the risks, open questions), or a file outside the repository.

**Implementor** (the strongest model). Builds the slice and proves it. Its prompt contains:
- **goal**: the outcome in one or two sentences, and what is out of scope;
- **context**: the gatherer's brief (pasted, or the path of the brief file) and any decisions already made;
- **constraints**: files or interfaces not to touch, style, dependencies, compatibility;
- **verification**: the exact commands to run and the result expected (e.g. the test suite passes, the type check is clean);
- **deliverable**: commits on its branch, and a final message listing what changed and the verification commands with their actual output.

**Judge** (a strong model, ideally a different model or provider than the implementor: different models miss different things). Reviews before you accept. Spawn it with \`cwd\` set to the implementor's \`worktreePath\` (and \`workspace\` set to the repository root) so it reads and tests that branch. Its prompt contains the goal and acceptance criteria, where the work is (the branch, the diff command against the base), the rubric, the instruction to report and not fix, and the deliverable: a verdict \`ACCEPT\` or \`REJECT\` with numbered findings (severity, file:line, why, suggested fix).

Judge rubric:
1. Does it achieve the goal and every acceptance criterion?
2. Do the tests exist, cover the change, and pass when the judge runs them itself?
3. Scope: no unrelated changes, no weakened tests, no disabled checks.
4. Edge cases, error handling and failure modes.
5. Security and data handling (secrets, injection, permissions).
6. Consistency with the codebase's conventions; docs updated where behaviour changed.

Accept/reject loop: on \`REJECT\`, \`send\` the findings to the implementor's session (it keeps its context), \`wait\`, then \`send\` the judge "re-review; previous findings: …" and \`wait\` again. Repeat until \`ACCEPT\`. Cap it at about three rounds: if the slice still fails, re-scope it or start a fresh implementor with a summary of what went wrong. The final call is yours: you may overrule a judge with evidence, never without.`,
  },
  {
    slug: 'slices',
    title: 'Decomposing into verifiable vertical slices',
    body: `- A **vertical slice** is a thin end-to-end path (data, logic, interface, tests) that delivers one observable behaviour and can be verified by its own check. Prefer it to horizontal layers ("all the models", then "all the handlers"), which cannot be verified until the end.
- Each slice has one goal, one verification command, and as little file overlap with other slices as possible. If two slices must touch the same file, give both implementors \`worktree: true\` and plan the merge order.
- Shared foundations (a schema, an interface) become their own first slice; dependent slices start after it is accepted.
- Size a slice so one implementor finishes it in one focused session. A slice that needs a long spec is probably two slices.
- Write the slice list down (goal, verification, dependencies, team aliases) before the first spawn, and keep it updated as slices are accepted.`,
  },
  {
    slug: 'models',
    title: 'Choosing providers and models',
    body: `- Call \`settings\`: it shows the default provider and the default model per provider (\`[models]\`) configured on this host. \`spawn\` uses them when you omit \`provider\` / \`model\`.
- Match capability to role: a fast, cheap model for gathering; the strongest available model for implementing; a strong model for judging, from a different provider (or at least a different model) than the implementor.
- Only use model names you know are configured or that the user named; omit \`model\` to get the provider's default. \`spawn\` returns the model a session uses.
- Providers: \`claude\` and \`pi\` need their CLI on the host; \`codex\` needs an OpenAI credential on the host. A spawn fails with a clear error when its provider is unavailable: pick another provider.
- If only one provider is available, diversify within it: a different model or a reviewer persona (an agent definition) for the judge.`,
  },
  {
    slug: 'spawning',
    title: 'Spawning agents',
    body: `- \`alias\`: a workspace-scoped handle (\`@impl-auth\`); \`@alias\` resolves in the current workspace only, \`@workspace:alias\` from elsewhere. The \`id\` spawn returns always works: prefer it.
- \`system_prompt\` frames the role (appended to the provider's own by default; \`system_prompt_mode: replace\` replaces it). \`agent\` uses a named agent definition instead (\`.claude/agents/<name>.md\`; codex also reads \`.codex/agents/*.toml\`); the two are mutually exclusive.
- \`worktree: true\` creates a fresh git worktree on its own branch as the agent's cwd (\`branch\` names it); \`cwd\` must be inside a git repository. A fresh worktree has no installed dependencies: tell the agent to install them if it needs to build or test.
- \`cwd\` is the base directory (default: the server's); \`workspace\` groups sessions (default: the git toplevel of cwd). A reviewer pointed at another agent's worktree with \`cwd\` lands in that worktree's workspace: pass \`workspace\` (the repository root) to keep it with the others.
- \`prompt\` is optional: spawn without one, then \`send\` the task when you are ready.`,
  },
  {
    slug: 'prompts',
    title: 'Writing self-contained prompts',
    body: `Agents do not see your conversation, the user's request or other agents' work. Each prompt must stand alone:

\`\`\`
GOAL: <the outcome, one or two sentences; what is out of scope>
CONTEXT: <what exists and where: paths, the gatherer's brief, decisions made>
CONSTRAINTS: <files/interfaces not to touch, style, dependencies>
VERIFY: <exact commands and the expected result>
DELIVER: <commits on the branch; the final message: what changed + verification output>
\`\`\`

- Name files by path; quote error messages exactly; state the acceptance criteria the judge will use.
- Long specs: write them to a file outside the repository and send "Read <absolute path> in full and carry it out": the spec stays reviewable and is never committed by accident. Prompts of any length are delivered verbatim as one message.
- Ask for a final message in a fixed shape (e.g. \`STATUS: done|blocked\`, then evidence): it makes \`read\` results easy to check.`,
  },
  {
    slug: 'waiting',
    title: 'Waiting and reading',
    body: `- \`wait\` returns within \`timeout_seconds\` (45 by default) even if agents are still running: that is not an error. Some MCP clients time out a tool call after about a minute, so keep the default and call \`wait\` again.
- Many ids: \`mode: "all"\` (default) returns when every id has settled; \`mode: "any"\` returns as soon as one has: use it to pipeline (judge one slice while others work) and drop finished ids from the next call. Up to 16 ids per call.
- \`for\`: \`settled\` (default: done, waiting or failed), or one state.
- Prefer \`wait\` to polling \`state\`.
- \`read\` returns the latest conversation turn, token-efficient (each tool call is one line). \`full: true\` returns the whole transcript, \`index: N\` one turn (0 = the first), \`raw: true\` the session journal (lifecycle and provider events; for debugging). Output longer than \`max_chars\` (16000 by default) keeps the end and says how much was cut.
- Read the last turn after every \`wait\`; read \`full\` only when you need the history.`,
  },
  {
    slug: 'integration',
    title: 'Integrating worktree branches',
    body: `- A worktree session reports \`worktreePath\` and \`branch\`. After the judge accepts a slice, review the branch (\`git -C <worktreePath> log --oneline\`, the diff against the base) and merge it in dependency order.
- If you have no shell on the host (e.g. you drive a daemon's \`/mcp\` remotely), spawn an integration agent with the branches and the merge order, and judge its result like any slice.
- Merge conflicts: send the conflicting slice's implementor "rebase onto <base> and resolve conflicts with <branch>", then re-verify.
- After merging: \`kill\` the slice's sessions with \`worktree: true\` (removes the checkout; the branch and its commits are kept), then delete merged branches.`,
  },
  {
    slug: 'workflows',
    title: 'Workflows',
    body: `- Use \`workflow_run\` for a repeatable, multi-step process (review, migration, release) or long unattended work. Use ad-hoc \`spawn\` when you must judge between steps.
- A workflow is a TypeScript file default-exporting \`{ name, steps[] }\`. Each step is an agent (\`provider\`, \`prompt\` or \`taskFile\`, optional \`needs\` for ordering, \`worktree\`, \`verify\`, \`cwd\`). The file's \`maxConcurrency\` (or \`max_concurrency\`) runs independent steps in parallel.
- A step succeeds only on a hard signal: its \`verify\` check passes (or the file's own \`done\` predicate function returns true), or, with \`worktree: true\` and no \`verify\`, its branch has at least one commit. A step with neither fails as \`unverified\` when the agent yields, unless it sets \`allowUnverified: true\`: give every step one of them.
- \`workflow_run\` always runs in the background and returns \`runId\` at once. Poll \`workflow_status\` (status: running, done, failed, orphaned, cancelled); read what each step did with \`workflow_logs\`.
- Recovery: \`workflow_resume\` continues an incomplete or orphaned run (succeeded steps are skipped); \`workflow_retry\` starts new attempts for failed steps (\`step\` targets one). Both need the original workflow file.
- Where steps run: a step without its own \`cwd\` runs where its runner starts, which is the \`cwd\` of \`workflow_run\`, \`workflow_resume\` or \`workflow_retry\` (the server's directory if you omit it; on a daemon \`cwd\` is required). Pass resume and retry the directory the run was started in, and give steps an absolute \`cwd\` in the file when the directory matters.
- \`workflow_cancel\` stops a run (\`cascade: true\` also kills the sessions it owns); \`workflow_cleanup\` removes the sessions and worktrees a finished run owns.`,
  },
  {
    slug: 'failures',
    title: 'Failure handling',
    body: `- **The last turn failed** (\`failed\`, not stopped or suspended): \`state\` shows \`lastTurn.error\`; \`read\` the turn. Send a correction, or spawn a fresh agent with a sharper prompt and a summary.
- **Suspended** (the agent's process died): \`send\` wakes it and resumes the same conversation (unless \`wake: false\`); \`resume\` does it without a message. After repeated failed starts auto-wake stops until \`resume\`.
- **Stopped** (killed or taken over): \`resume\` hands it back to an agent process.
- **Waiting** (a permission was requested and denied): read what it tried, then tell it how to proceed without that action.
- **send phase \`unknown\`**: the delivery was cut before the agent acknowledged it, and orc never re-sends it. \`read\` to see whether it landed; if not, send again with a NEW \`idempotency_key\`. A send with a key already used and the same text is a no-op (\`replayed: true\`); different text is an error.
- **Stuck** (the same last turn across several waits, loops, repeated failures): send one concrete hint; if that does not help, \`kill\` it and spawn a fresh agent with what you learned.
- **Context exhausted** (e.g. "exceeds the model's context window"): spawn a fresh session and hand it a summary.
- **spawn errors**: a missing or signed-out provider, an alias already in use, a policy limit (maxSessions, maxConcurrentSessions): the error says which; adapt rather than retry blindly.`,
  },
  {
    slug: 'cleanup',
    title: 'Cleanup',
    body: `- \`kill\` each session as soon as its slice is accepted or abandoned. Its record and journal stay readable; \`purge: true\` deletes them; \`worktree: true\` removes its checkout (the branch is kept: delete it once merged).
- Before you finish: \`list\` with \`all: true\` and kill anything of yours still running or suspended (a suspended session wakes on the next send).
- \`prune\` removes the records of **all** dead sessions on the host, not only yours; \`worktree: true\` also removes their checkouts, \`suspended: true\` also stops and removes suspended sessions. Run it last.
- Workflow runs: \`workflow_cleanup\` with \`sessions\` and \`worktrees\` removes what the run owns.`,
  },
  {
    slug: 'remote',
    title: 'Remote hosts',
    body: `- **stdio** (\`orc mcp\`): tools run \`orc\` on this machine. On remote-capable tools (spawn, send, wait, read, state, list, kill, workflow_run/list/status/logs/cancel/cleanup) \`host\` runs the call on that peer's orc daemon (host or host:port, as \`orc --host\`). resume, prune, settings, workflow_resume and workflow_retry are local only.
- Without \`host\`, orc's own routing applies: a default host (ORC_HOST or settings.toml \`host\`) is followed, except inside an orc session.
- Remote calls authenticate as this machine's tailnet identity (the peer must trust it: \`orc remote add\` there); an explicit \`host\` call also carries ORC_DAEMON_TOKEN / ORC_DAEMON_SECRET from the server's environment. Calls without \`host\` never carry them, even when a default host sends them to a peer: when a default host is configured and that peer needs a token, pass \`host\` explicitly. \`unauthorized: authentication required\` on a call without \`host\` usually means exactly that.
- **daemon** (\`/mcp\` on \`orc daemon\`): everything runs on the daemon's host. Give spawn and workflow_run an absolute \`cwd\` (and absolute paths everywhere); address sessions by id (an \`@alias\` resolves against the daemon's own directory). The tools you see depend on your token's scopes.`,
  },
  {
    slug: 'limits',
    title: 'Limits and cost hygiene',
    body: `- Every agent spends tokens while it works. Right-size teams, give gatherers cheap models, and kill idle sessions.
- Supervise what you spawn: a handful of parallel slices you verify well beats a dozen you cannot track.
- Read the last turn, not the full transcript; page long transcripts with \`index\`.
- orc enforces no token or cost budget. An execution policy (maxSessions, maxConcurrentSessions, maxDepth, deadlineMs) may refuse a spawn: the error says which limit.
- Bounds: \`wait\` returns within 45 s by default (600 at most) and watches up to 16 ids; \`read\` and \`workflow_logs\` return at most \`max_chars\` (16000 by default, 100000 at most); at most 32 orc commands run at once per server (each \`wait\` id is one), and further calls queue.
- Arguments are checked strictly: a misspelled or unknown one is an error, not ignored. Use the names the tool lists (\`idempotency_key\`, \`timeout_seconds\`, \`max_chars\`).`,
  },
  {
    slug: 'excluded',
    title: 'What is not exposed, and why',
    body: `- \`attach\`, \`workflow attach\`: live streams for a human terminal. Use \`read\` / \`workflow_logs\`.
- \`takeover\`: hands a session to a human, which contradicts the lead holding the reins. A human can still run it from a shell.
- \`login\`, \`logout\`: credentials belong to the user.
- \`daemon\`, \`remote add|rm\`: serving and trust configuration. Never change trust to make a call work; report it.
- \`mcp\`, \`help\`: this server, and the human help text.`,
  },
  {
    slug: 'tools',
    title: 'Tool reference',
    body: `- \`spawn\`: start an agent; returns at once with its id.
- \`send\`: a follow-up prompt; wakes a suspended session.
- \`wait\`: block (bounded) until one or many sessions settle.
- \`read\`: the latest turn, one turn, the full transcript, or the journal.
- \`state\`: a session's state without waiting.
- \`list\`: sessions in this workspace (\`all\` for every one).
- \`kill\`: stop a session (optionally remove its worktree or purge it).
- \`resume\`: hand a stopped or suspended session back to an agent process.
- \`prune\`: remove dead sessions' records (and optionally worktrees).
- \`settings\`: default provider, models and host.
- \`guide\`: this playbook.
- \`workflow_run\`, \`workflow_list\`, \`workflow_status\`, \`workflow_logs\`, \`workflow_resume\`, \`workflow_retry\`, \`workflow_cancel\`, \`workflow_cleanup\`: workflows (see Workflows).`,
  },
];

/** The whole playbook as one markdown document. */
export function guideText(): string {
  return [
    '# orc lead playbook',
    '',
    'How to lead a team of coding agents with these tools. Sections: ' +
      GUIDE_SECTIONS.map((s) => `\`${s.slug}\``).join(', ') +
      ' (`guide` with `topic` returns one).',
    ...GUIDE_SECTIONS.flatMap((s) => ['', `## ${s.title}`, '', s.body]),
  ].join('\n');
}

/**
 * The sections matching `topic` (a slug, or words of a title; case-insensitive), as
 * markdown — or null when nothing matches.
 */
export function guideTopic(topic: string): string | null {
  const q = topic.trim().toLowerCase();
  if (q.length === 0) return guideText();
  const hits = GUIDE_SECTIONS.filter((s) => s.slug === q || s.slug.startsWith(q) || s.title.toLowerCase().includes(q));
  if (hits.length === 0) return null;
  return hits.map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n');
}

/** The topic keys, for an error message. */
export function guideTopics(): string[] {
  return GUIDE_SECTIONS.map((s) => s.slug);
}
