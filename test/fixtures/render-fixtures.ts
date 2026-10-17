/**
 * Synthetic data for the renderer golden tests (test/style-golden.test.ts): covers every
 * branch of the human renderers (session list/detail, workflow events and runs, settings,
 * transcripts, journals, login status). Pure data — no I/O.
 */
import type { SessionView, HostSessionView } from '../../src/cli/output.ts';
import type { WorkflowEvent, WorkflowRun, StepResult } from '../../src/workflow.ts';
import type { SettingsView } from '../../src/settings.ts';
import type { Turn } from '../../src/transcript.ts';
import type { JournalEntry } from '../../src/runtime/types.ts';
import type { LoginStatus } from '../../src/codex/login.ts';

const T0 = '2026-10-17T09:30:00.000Z';
const T1 = '2026-10-17T09:41:12.345Z';

export const sessionViews: SessionView[] = [
  {
    id: 'a1b2c3d4',
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    runtime: 'actor',
    providerSessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    provider: 'claude',
    model: 'haiku',
    agentName: 'reviewer',
    alias: 'dbg',
    cwd: '/home/u/src/orc/.orc/worktrees/a1b2c3d4',
    worktreePath: '/home/u/src/orc/.orc/worktrees/a1b2c3d4',
    branch: 'orc/a1b2c3d4',
    workspace: '/home/u/src/orc',
    createdAt: T0,
    status: 'running',
    state: 'done',
  },
  {
    id: 'e5f6a7b8',
    sessionId: 'e5f6a7b8-0000-4000-8000-000000000002',
    provider: 'codex',
    model: 'gpt-5-codex',
    cwd: '/home/u/src/orc',
    workspace: '/home/u/src/orc',
    createdAt: T0,
    rootRunId: 'r00t0001',
    parentRunId: 'run00002',
    stepId: 'build',
    depth: 1,
    status: 'suspended',
    state: 'failed',
  },
  {
    id: 'c9d0e1f2',
    sessionId: 'c9d0e1f2-0000-4000-8000-000000000003',
    provider: 'pi',
    cwd: '/tmp/scratch',
    workspace: '/tmp/scratch',
    createdAt: T0,
    status: 'dead',
    stoppedBy: 'takeover',
    killedAt: T1,
    state: 'failed',
  },
  {
    id: 'legacy01',
    sessionId: 'legacy01-0000-4000-8000-000000000004',
    provider: 'claude',
    cwd: '/home/u/old',
    workspace: '/home/u/old',
    createdAt: T0,
    legacy: 'tmux',
    legacyTmuxName: 'orc-legacy01',
    status: 'dead',
  },
  {
    id: 'minimal1',
    sessionId: 'minimal1-0000-4000-8000-000000000005',
    provider: 'pi',
    cwd: '/w',
    workspace: '/w',
    createdAt: T0,
  },
  {
    id: 'spawn001',
    sessionId: 'spawn001-0000-4000-8000-000000000006',
    provider: 'claude',
    cwd: '/w',
    workspace: '/w',
    createdAt: T0,
    status: 'spawning',
    state: 'starting',
    depth: 0,
  },
  {
    id: 'wait0001',
    sessionId: 'wait0001-0000-4000-8000-000000000007',
    provider: 'codex',
    cwd: '/w',
    workspace: '/w',
    createdAt: T0,
    status: 'running',
    state: 'waiting',
  },
  {
    id: 'busy0001',
    sessionId: 'busy0001-0000-4000-8000-000000000008',
    provider: 'claude',
    cwd: '/w',
    workspace: '/w',
    createdAt: T0,
    status: 'running',
    state: 'running',
  },
];

export const hostViews: HostSessionView[] = [
  { ...sessionViews[0]!, host: 'local' },
  { ...sessionViews[1]!, host: 'studio' },
  { ...sessionViews[6]!, host: 'build-box.tail1234.ts.net' },
];

const okResult: StepResult = {
  id: 'plan',
  sessionId: 'a1b2c3d4',
  provider: 'claude',
  state: 'done',
  ok: true,
  commitsAhead: 0,
};

const failResult: StepResult = {
  id: 'build',
  sessionId: 'e5f6a7b8',
  provider: 'codex',
  state: 'failed',
  ok: false,
  commitsAhead: 0,
  worktree: '/home/u/src/orc/.orc/worktrees/e5f6a7b8',
  branch: 'orc/e5f6a7b8',
};

const unverifiedResult: StepResult = {
  id: 'review',
  sessionId: '',
  provider: 'pi',
  state: 'done',
  ok: false,
  commitsAhead: 2,
  unverified: true,
};

export const fullRun: WorkflowRun = {
  schemaVersion: 5,
  revision: 12,
  id: 'run00002',
  name: 'ship-it',
  startedAt: T0,
  finishedAt: T1,
  status: 'failed',
  rootRunId: 'run00002',
  definitionDigest: '9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a9c0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b',
  lease: { ownerId: 'owner-7', pid: 4242, updatedAt: T0, expiresAt: T1 },
  runner: { pid: 4243, startTime: '123', logPath: '/home/u/.orc/runs/run00002/runner.log', startedAt: T0 },
  steps: [okResult, failResult, unverifiedResult],
  plan: {
    name: 'ship-it',
    maxConcurrency: 2,
    steps: [
      { id: 'plan', provider: 'claude', needs: [] },
      { id: 'build', provider: 'codex', needs: ['plan'] },
      { id: 'review', provider: 'pi', needs: ['plan'] },
      { id: 'merge', provider: 'claude', needs: ['build', 'review'] },
    ],
  },
  attempts: [
    {
      attemptId: 'att-1',
      attemptNumber: 1,
      stepId: 'plan',
      phase: 'succeeded',
      provider: 'claude',
      sessionId: 'a1b2c3d4',
      startedAt: T0,
      updatedAt: T1,
      finishedAt: T1,
    },
    {
      attemptId: 'att-2',
      attemptNumber: 1,
      stepId: 'build',
      phase: 'failed',
      provider: 'codex',
      sessionId: 'e5f6a7b8',
      errorCategory: 'verify',
      errorMessage: 'verify failed: 0 commits ahead of main',
      startedAt: T0,
      updatedAt: T1,
    },
    {
      attemptId: 'att-3',
      attemptNumber: 1,
      stepId: 'review',
      phase: 'waiting',
      provider: 'pi',
      startedAt: T0,
      updatedAt: T1,
    },
  ],
};

export const legacyRun: WorkflowRun = {
  id: 'legacy99',
  name: 'old-flow',
  startedAt: T0,
  status: 'orphaned',
  legacyRunnerTmux: 'orc-wf-legacy99',
  steps: [],
};

export const minimalRun: WorkflowRun = {
  id: 'run00003',
  name: 'tiny',
  startedAt: T0,
  status: 'running',
  steps: [],
};

export const cancelledRun: WorkflowRun = {
  id: 'run00004',
  name: 'abandoned-idea',
  startedAt: T1,
  status: 'cancelled',
  steps: [okResult],
  plan: { name: 'abandoned-idea', steps: [{ id: 'plan', provider: 'claude' }] },
};

export const doneRun: WorkflowRun = {
  id: 'run00005',
  name: 'green',
  startedAt: T1,
  status: 'done',
  steps: [okResult, { ...okResult, id: 'test', commitsAhead: 1, worktree: '/w/t' }],
  plan: { name: 'green', maxConcurrency: 4, steps: [{ id: 'plan', provider: 'claude' }, { id: 'test', provider: 'claude' }] },
};

export const runs: WorkflowRun[] = [fullRun, legacyRun, minimalRun, cancelledRun, doneRun];

export const workflowEvents: WorkflowEvent[] = [
  { type: 'run-start', runId: 'run00002', name: 'ship-it', steps: 4, maxConcurrency: 2 },
  { type: 'run-start', runId: 'run00003', name: "it's tiny", steps: 1 },
  { type: 'step-scheduled', runId: 'run00002', stepId: 'plan', slotsRemaining: 1 },
  { type: 'step-scheduled', runId: 'run00002', stepId: 'build' },
  { type: 'step-start', runId: 'run00002', stepId: 'plan', provider: 'claude' },
  { type: 'attempt-transition', runId: 'run00002', attemptId: 'att-1', stepId: 'plan', phase: 'dispatched', sessionId: 'a1b2c3d4' },
  { type: 'attempt-transition', runId: 'run00002', attemptId: 'att-1', stepId: 'plan', phase: 'queued' },
  { type: 'lease-heartbeat', runId: 'run00002', expiresAt: T1, ownerId: 'owner-7' },
  { type: 'step-done', runId: 'run00002', result: okResult },
  { type: 'step-done', runId: 'run00002', result: failResult },
  { type: 'step-done', runId: 'run00002', result: unverifiedResult },
  { type: 'step-warn', runId: 'run00002', stepId: 'review', message: 'no done predicate; reported unverified' },
  { type: 'step-error', runId: 'run00002', stepId: 'build', error: 'provider exited (code=1)\nstderr: boom' },
  { type: 'step-blocked', runId: 'run00002', stepId: 'merge', reason: 'dependency build failed', blockedBy: ['build'] },
  { type: 'attempt-adopt', runId: 'run00002', attemptId: 'att-4', stepId: 'review', sessionId: 'c9d0e1f2' },
  { type: 'run-done', runId: 'run00002', status: 'failed', run: fullRun },
  { type: 'run-done', runId: 'run00005', status: 'done', run: doneRun },
  { type: 'run-done', runId: 'legacy99', status: 'orphaned', run: legacyRun },
  { type: 'run-resume', runId: 'run00002', fromStatus: 'orphaned' },
  { type: 'run-retry', runId: 'run00002', stepId: 'build' },
  { type: 'run-retry', runId: 'run00002' },
  { type: 'run-cancel', runId: 'run00002', cascade: true },
  { type: 'run-cancel', runId: 'run00003', cascade: false },
];

export const settingsViews: SettingsView[] = [
  {
    cwd: '/home/u/src/orc/pkg',
    root: '/home/u/src/orc',
    nested: true,
    host: {
      value: 'studio:8787',
      source: 'local',
      from: '/home/u/src/orc/.orc/settings.toml',
      note: 'refused: not a trusted peer (orc remote add studio, or --local/--host)',
    },
    provider: { value: null, source: 'default', note: 'spawn requires --provider' },
    models: {
      claude: { value: 'haiku', source: 'global', from: '/home/u/.orc/settings.toml' },
      codex: { value: null, source: 'default', note: "the provider's own default" },
      pi: { value: 'openai/gpt-5-with-a-long-name', source: 'local', from: '/home/u/src/orc/.orc/settings.toml' },
    },
    files: [
      { scope: 'local', path: '/home/u/src/orc/pkg/.orc/settings.toml', status: 'missing' },
      { scope: 'local', path: '/home/u/src/orc/.orc/settings.toml', status: 'used' },
      { scope: 'global', path: '/home/u/.orc/settings.toml', status: 'used' },
    ],
    warnings: ['/home/u/.orc/settings.toml: unknown setting(s) ignored: colour, models.gemini'],
  },
  {
    cwd: '/tmp/x',
    root: null,
    nested: false,
    host: { value: null, source: 'flag', from: '--local', note: 'commands run on this host' },
    provider: { value: 'claude', source: 'env', from: 'ORC_PROVIDER' },
    models: {
      claude: { value: null, source: 'default', note: "the provider's own default" },
      codex: { value: null, source: 'default' },
      pi: { value: null, source: 'default', note: "the provider's own default" },
    },
    files: [
      { scope: 'local', path: '/home/u/.orc/settings.toml', status: 'same-as-global' },
      { scope: 'global', path: '/home/u/.orc/settings.toml', status: 'missing' },
    ],
    warnings: [],
  },
];

export const turns: Turn[] = [
  { role: 'user', text: 'Fix the flaky test\nand explain why it flaked.' },
  { role: 'tool', text: 'Bash: bun test test/wait.test.ts' },
  { role: 'tool', text: 'Read …/src/session.ts' },
  { role: 'assistant', text: 'The wait loop raced the journal fsync.\n\n- Added a barrier\n- Re-ran 50x: green' },
  { role: 'system', text: 'context compacted' },
];

let seq = 0;
const at = (e: Record<string, unknown>): JournalEntry => ({ seq: ++seq, ts: T0, ...e }) as JournalEntry;

export const journal: JournalEntry[] = [
  at({ type: 'actor.started', pid: 9001, mode: 'fresh' }),
  at({ type: 'provider.spawned', pid: 9002, startTime: '77' }),
  at({ type: 'provider.ready', providerSessionId: 'prov-123', providerPid: 9002 }),
  at({ type: 'inbox.accepted', ulid: '01J', kind: 'message', messageId: 'm1' }),
  at({ type: 'turn.intent', messageId: 'm1', ulid: '01J', text: 'hello there\nsecond line' }),
  at({ type: 'turn.started', messageId: 'm1' }),
  at({ type: 'assistant.text', messageId: 'm1', text: 'Hi! Working on it.\nDone.\n' }),
  at({ type: 'turn.completed', messageId: 'm1', costUsd: 0.01234 }),
  at({ type: 'turn.intent', messageId: 'm2', ulid: '01K', text: 'do the risky thing' }),
  at({ type: 'permission.requested', messageId: 'm2', detail: { tool: 'Bash' } }),
  at({ type: 'turn.failed', messageId: 'm2', error: 'permission denied' }),
  at({ type: 'interrupt.requested', messageId: 'm3' }),
  at({ type: 'turn.interrupted', messageId: 'm3', reason: 'user' }),
  at({ type: 'turn.completed', messageId: 'm4' }),
  at({ type: 'provider.exited', code: 0, signal: null }),
  at({ type: 'actor.stopped', reason: 'stop' }),
  at({ type: 'actor.reopened', reason: 'resume' }),
  at({ type: 'actor.stopped', reason: 'error', error: 'lease lost to pid 77' }),
];

export const loginStatuses: LoginStatus[] = [
  {
    active: 'orc',
    orc: { path: '/home/u/.orc/auth/chatgpt.json', credential: 'oauth (expires in 9d)' },
    pi: { path: '/home/u/.pi/agent/auth.json', credential: 'none' },
    openaiApiKey: true,
  },
  {
    active: 'none',
    orc: { path: '/home/u/.orc/auth/chatgpt.json', credential: 'none' },
    pi: { path: '/home/u/.pi/agent/auth.json', credential: 'none' },
    openaiApiKey: false,
  },
  {
    active: 'error',
    error: 'invalid JSON in /home/u/.orc/auth/chatgpt.json',
    orc: { path: '/home/u/.orc/auth/chatgpt.json', credential: 'unreadable', error: 'invalid JSON in /home/u/.orc/auth/chatgpt.json' },
    pi: { path: '/home/u/.pi/agent/auth.json', credential: 'unreadable', error: 'EACCES' },
    openaiApiKey: false,
  },
];
