/**
 * src/style.ts: SGR helpers, semantic roles, the status palette and colour detection.
 */
import { describe, expect, test } from 'bun:test';
import {
  PLAIN,
  Style,
  TONE_STYLES,
  createStyle,
  decideColor,
  resolveStyle,
  sgr,
  stripAnsi,
  toneOf,
} from '../src/style.ts';
import type { ColorMode } from '../src/style.ts';
import type { AgentState, SessionStatus } from '../src/types.ts';
import type { AttemptPhase, WorkflowRunStatus } from '../src/run-schema.ts';
import type { StepSchedStatus } from '../src/workflow-scheduler.ts';
import type { SettingsView } from '../src/settings.ts';
import { renderJournalEntry } from '../src/journal-render.ts';
import { journal } from './fixtures/render-fixtures.ts';

const ANSI = new Style({ color: true });

/**
 * A tiny SGR interpreter: the attribute state after each line of `text`. Used to prove
 * every span closes what it opened (no attribute leaks past a line).
 */
function sgrStateAfterEachLine(text: string): string[] {
  let intensity = 0; // 0 normal, 1 bold, 2 dim
  let italic = false;
  let fg = 39;
  const states: string[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      for (const code of (m[1] || '0').split(';').map(Number)) {
        if (code === 0) [intensity, italic, fg] = [0, false, 39];
        else if (code === 1 || code === 2) intensity = code;
        else if (code === 22) intensity = 0;
        else if (code === 3) italic = true;
        else if (code === 23) italic = false;
        else if ((code >= 30 && code <= 37) || code === 39) fg = code;
        else throw new Error(`unexpected SGR code ${code}`);
      }
    }
    states.push(`${intensity}/${italic}/${fg}`);
  }
  return states;
}

describe('sgr', () => {
  test('emits the 16-colour/bold/dim/italic codes and closes each with its own reset', () => {
    expect(sgr('x', ['bold'])).toBe('\x1b[1mx\x1b[22m');
    expect(sgr('x', ['dim'])).toBe('\x1b[2mx\x1b[22m');
    expect(sgr('x', ['italic'])).toBe('\x1b[3mx\x1b[23m');
    expect(sgr('x', ['red'])).toBe('\x1b[31mx\x1b[39m');
    expect(sgr('x', ['green'])).toBe('\x1b[32mx\x1b[39m');
    expect(sgr('x', ['yellow'])).toBe('\x1b[33mx\x1b[39m');
    expect(sgr('x', ['magenta'])).toBe('\x1b[35mx\x1b[39m');
    expect(sgr('x', ['cyan'])).toBe('\x1b[36mx\x1b[39m');
    expect(sgr('x', ['bold', 'cyan'])).toBe('\x1b[1;36mx\x1b[22;39m');
    // bold and dim share one reset (22): emitted once.
    expect(sgr('x', ['bold', 'dim'])).toBe('\x1b[1;2mx\x1b[22m');
  });

  test('never emits truecolor/256-colour or a full reset', () => {
    const all = sgr('x', ['bold', 'dim', 'italic', 'red', 'green', 'yellow', 'magenta', 'cyan']);
    expect(all).not.toMatch(/\x1b\[[0-9;]*\b(38|48)\b/);
    expect(all).not.toContain('\x1b[0m');
  });

  test('wraps per line, leaves empty lines and empty text alone, identity without attrs', () => {
    expect(sgr('a\n\nb\n', ['dim'])).toBe('\x1b[2ma\x1b[22m\n\n\x1b[2mb\x1b[22m\n');
    expect(sgr('', ['bold'])).toBe('');
    expect(sgr('plain', [])).toBe('plain');
  });

  test('every line ends with the default SGR state (spans never leak)', () => {
    const st = ANSI;
    const samples = [
      st.heading('h') + st.label('k:') + st.muted(' v\nw') + st.errorLabel('error:'),
      st.status('running') + st.status('done', 7) + st.tag('failed') + st.tone('waiting'),
      st.paint('a\nb\nc', 'bold', 'italic', 'magenta') + st.warningLabel('warning:'),
    ];
    for (const s of samples) for (const state of sgrStateAfterEachLine(s)) expect(state).toBe('0/false/39');
  });

  test('a non-string (malformed data) prints as plain mode would, never throws', () => {
    expect(sgr(undefined as unknown as string, ['bold'])).toBe('\x1b[1mundefined\x1b[22m');
    expect(ANSI.muted(undefined as unknown as string)).toBe('\x1b[2mundefined\x1b[22m');
    expect(`${PLAIN.muted(undefined as unknown as string)}`).toBe('undefined');
  });

  test('stripAnsi removes exactly the SGR codes', () => {
    expect(stripAnsi(sgr('a\nb', ['bold', 'red']) + 'c')).toBe('a\nbc');
  });
});

describe('PLAIN and Style roles', () => {
  const tricky = 'id\x1b]0;t\x07 \x1b[31mred\x1b[0m\ttab\nline';
  const roles = [
    'text',
    'bold',
    'dim',
    'italic',
    'heading',
    'id',
    'alias',
    'label',
    'muted',
    'command',
    'accent',
    'success',
    'danger',
    'warning',
    'errorLabel',
    'warningLabel',
  ] as const;

  test('PLAIN returns every input unchanged (no colour, no sanitizing)', () => {
    expect(PLAIN.color).toBe(false);
    expect(PLAIN.sanitize).toBe(false);
    for (const r of roles) expect(PLAIN[r](tricky)).toBe(tricky);
    expect(PLAIN.paint(tricky, 'bold', 'red')).toBe(tricky);
    expect(PLAIN.tone('done', tricky)).toBe(tricky);
    expect(PLAIN.status('running')).toBe('running');
    expect(PLAIN.status('done', 7)).toBe('done   ');
    expect(PLAIN.tag('running')).toBe('[running]');
    expect(PLAIN.tag('no-such-status')).toBe('[no-such-status]');
  });

  test('colour roles', () => {
    expect(ANSI.id('a1')).toBe('\x1b[1ma1\x1b[22m');
    expect(ANSI.heading('Usage:')).toBe('\x1b[1mUsage:\x1b[22m');
    expect(ANSI.label('cwd=')).toBe('\x1b[2mcwd=\x1b[22m');
    expect(ANSI.muted('/p')).toBe('\x1b[2m/p\x1b[22m');
    expect(ANSI.alias('@ws:x')).toBe('\x1b[36m@ws:x\x1b[39m');
    expect(ANSI.command('orc attach x')).toBe('\x1b[36morc attach x\x1b[39m');
    expect(ANSI.errorLabel('error:')).toBe('\x1b[1;31merror:\x1b[22;39m');
    expect(ANSI.warningLabel('warning:')).toBe('\x1b[1;33mwarning:\x1b[22;39m');
    expect(ANSI.success('ok')).toBe('\x1b[32mok\x1b[39m');
    expect(ANSI.danger('bad')).toBe('\x1b[31mbad\x1b[39m');
    expect(ANSI.warning('hm')).toBe('\x1b[33mhm\x1b[39m');
    expect(ANSI.text('t')).toBe('t');
  });

  test('status / tag / tone: one glyph + colour per status word; padding keeps columns', () => {
    expect(ANSI.status('running')).toBe('\x1b[36m● running\x1b[39m');
    expect(ANSI.status('done')).toBe('\x1b[32m✓ done\x1b[39m');
    expect(ANSI.status('failed')).toBe('\x1b[31m✗ failed\x1b[39m');
    expect(ANSI.status('waiting')).toBe('\x1b[33m! waiting\x1b[39m');
    expect(ANSI.status('suspended')).toBe('\x1b[35m◌ suspended\x1b[39m');
    expect(ANSI.status('dead')).toBe('\x1b[2m○ dead\x1b[22m');
    expect(ANSI.status('queued')).toBe('\x1b[2m◦ queued\x1b[22m');
    expect(ANSI.status('done', 7)).toBe('\x1b[32m✓ done   \x1b[39m');
    // An unknown word is never coloured; padded, it gets the glyph's width in spaces.
    expect(ANSI.status('mystery')).toBe('mystery');
    expect(ANSI.status('mystery', 9)).toBe('  mystery  ');
    expect(ANSI.tag('running')).toBe('\x1b[36m● running\x1b[39m');
    expect(ANSI.tag('mystery')).toBe('[mystery]');
    expect(ANSI.tone('done')).toBe('\x1b[32mdone\x1b[39m');
    expect(ANSI.tone('used', 'used   ')).toBe('\x1b[32mused   \x1b[39m');
    expect(ANSI.tone('mystery')).toBe('mystery');
  });

  test('methods are bound (safe to pass as callbacks)', () => {
    const { id, muted } = ANSI;
    expect(['a'].map(id)).toEqual(['\x1b[1ma\x1b[22m']);
    expect(muted('m')).toBe('\x1b[2mm\x1b[22m');
  });

  test('a sanitizing style makes dynamic text terminal-safe, with or without colour', () => {
    const safe = new Style({ sanitize: true });
    // The OSC (window title) is dropped with its payload; the CSI colour codes are dropped.
    expect(safe.text(tricky)).toBe('id red\ttab\nline');
    expect(safe.id(tricky)).toBe('id red\ttab\nline');
    const both = new Style({ color: true, sanitize: true });
    expect(both.id('a\x1b[2Jb')).toBe('\x1b[1mab\x1b[22m');
    expect(both.status('done\x07')).toBe('done'); // sanitized to an unknown word → no tone
  });

  test('resolveStyle: a non-Style (e.g. a .map index) means PLAIN', () => {
    expect(resolveStyle(undefined)).toBe(PLAIN);
    expect(resolveStyle(3)).toBe(PLAIN);
    expect(resolveStyle({ color: true })).toBe(PLAIN);
    expect(resolveStyle(ANSI)).toBe(ANSI);
    // SDK callers that pass a renderer straight to Array.prototype.map still get plain text.
    const viaMap = journal.map(renderJournalEntry as unknown as (e: (typeof journal)[number], i: number) => string | null);
    expect(viaMap).toEqual(journal.map((e) => renderJournalEntry(e)));
  });

  test('createStyle returns PLAIN when there is nothing to do', () => {
    expect(createStyle({})).toBe(PLAIN);
    expect(createStyle({ color: false, sanitize: false })).toBe(PLAIN);
    expect(createStyle({ color: true }).color).toBe(true);
    expect(createStyle({ sanitize: true }).sanitize).toBe(true);
  });
});

describe('the status palette', () => {
  test('every status word orc prints has exactly one tone', () => {
    const sessionStatuses: SessionStatus[] = ['running', 'suspended', 'spawning', 'dead'];
    const agentStates: AgentState[] = ['starting', 'running', 'done', 'waiting', 'failed'];
    const runStatuses: WorkflowRunStatus[] = ['running', 'done', 'failed', 'orphaned', 'cancelled'];
    const phases: AttemptPhase[] = [
      'queued',
      'spawning',
      'dispatched',
      'running',
      'verifying',
      'succeeded',
      'failed',
      'waiting',
      'cancelled',
      'abandoned',
      'blocked',
      'skipped',
    ];
    const sched: StepSchedStatus[] = ['pending', 'ready', 'blocked', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'];
    const fileStatuses: SettingsView['files'][number]['status'][] = ['used', 'missing', 'same-as-global'];
    const marks = ['ok', 'FAIL', 'UNVERIFIED', 'acknowledged', 'queued', 'unknown', 'submitted'];
    for (const w of [...sessionStatuses, ...agentStates, ...runStatuses, ...phases, ...sched, ...fileStatuses, ...marks]) {
      expect(toneOf(w)).toBeDefined();
    }
  });

  test('the same word means the same thing everywhere', () => {
    expect(toneOf('running')).toBe('active');
    expect(toneOf('starting')).toBe('active');
    expect(toneOf('done')).toBe('success');
    expect(toneOf('succeeded')).toBe('success');
    expect(toneOf('ok')).toBe('success');
    expect(toneOf('failed')).toBe('danger');
    expect(toneOf('FAIL')).toBe('danger');
    expect(toneOf('waiting')).toBe('attention');
    expect(toneOf('suspended')).toBe('paused');
    expect(toneOf('orphaned')).toBe('paused');
    expect(toneOf('dead')).toBe('inert');
    expect(toneOf('cancelled')).toBe('inert');
    expect(toneOf('toString')).toBeUndefined();
    expect(toneOf('constructor')).toBeUndefined();
  });

  test('restraint: five hues plus dim, one single-column glyph per tone', () => {
    const hues = new Set(Object.values(TONE_STYLES).flatMap((t) => t.attrs.filter((a) => a !== 'dim')));
    expect([...hues].sort()).toEqual(['cyan', 'green', 'magenta', 'red', 'yellow']);
    for (const t of Object.values(TONE_STYLES)) expect([...t.glyph]).toHaveLength(1);
  });
});

describe('decideColor (per stream)', () => {
  type Row = [label: string, mode: ColorMode | undefined, env: Record<string, string>, isTTY: boolean, expected: boolean];
  const rows: Row[] = [
    ['auto on a TTY', undefined, {}, true, true],
    ['auto piped', undefined, {}, false, false],
    ['explicit auto behaves like auto', 'auto', {}, false, false],
    ['--color=always beats a pipe', 'always', {}, false, true],
    ['--color=always beats NO_COLOR', 'always', { NO_COLOR: '1' }, false, true],
    ['--color=always beats TERM=dumb', 'always', { TERM: 'dumb' }, false, true],
    ['--no-color beats a TTY', 'never', {}, true, false],
    ['--no-color beats FORCE_COLOR', 'never', { FORCE_COLOR: '1' }, true, false],
    ['NO_COLOR=1 disables on a TTY', undefined, { NO_COLOR: '1' }, true, false],
    ['NO_COLOR=anything disables', undefined, { NO_COLOR: 'yes please' }, true, false],
    ['NO_COLOR="" is ignored', undefined, { NO_COLOR: '' }, true, true],
    ['NO_COLOR beats FORCE_COLOR', undefined, { NO_COLOR: '1', FORCE_COLOR: '1' }, false, false],
    ['NO_COLOR beats CLICOLOR_FORCE', undefined, { NO_COLOR: '1', CLICOLOR_FORCE: '1' }, false, false],
    ['FORCE_COLOR=1 enables piped', undefined, { FORCE_COLOR: '1' }, false, true],
    ['FORCE_COLOR=2 enables', undefined, { FORCE_COLOR: '2' }, false, true],
    ['FORCE_COLOR=3 enables', undefined, { FORCE_COLOR: '3' }, false, true],
    ['FORCE_COLOR=true enables', undefined, { FORCE_COLOR: 'true' }, false, true],
    ['FORCE_COLOR set but empty enables', undefined, { FORCE_COLOR: '' }, false, true],
    ['FORCE_COLOR=0 disables on a TTY', undefined, { FORCE_COLOR: '0' }, true, false],
    ['FORCE_COLOR=false disables on a TTY', undefined, { FORCE_COLOR: 'false' }, true, false],
    ['FORCE_COLOR=0 beats CLICOLOR_FORCE', undefined, { FORCE_COLOR: '0', CLICOLOR_FORCE: '1' }, false, false],
    ['FORCE_COLOR=1 beats TERM=dumb', undefined, { FORCE_COLOR: '1', TERM: 'dumb' }, false, true],
    ['unrecognised FORCE_COLOR falls through (TTY)', undefined, { FORCE_COLOR: 'sometimes' }, true, true],
    ['unrecognised FORCE_COLOR falls through (pipe)', undefined, { FORCE_COLOR: 'sometimes' }, false, false],
    ['CLICOLOR_FORCE=1 enables piped', undefined, { CLICOLOR_FORCE: '1' }, false, true],
    ['CLICOLOR_FORCE=0 is ignored', undefined, { CLICOLOR_FORCE: '0' }, false, false],
    ['CLICOLOR_FORCE beats TERM=dumb', undefined, { CLICOLOR_FORCE: '1', TERM: 'dumb' }, false, true],
    ['TERM=dumb disables on a TTY', undefined, { TERM: 'dumb' }, true, false],
    ['TERM=xterm on a TTY', undefined, { TERM: 'xterm-256color' }, true, true],
  ];
  for (const [label, mode, env, isTTY, expected] of rows) {
    test(label, () => {
      expect(decideColor({ mode, env, isTTY })).toBe(expected);
    });
  }
});
