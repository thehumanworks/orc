import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import {
  classifyState,
  isSettled,
  reduceWait,
  INITIAL_TRACKING,
  type StateMatchers,
} from '../src/state.ts';
import type { AgentState } from '../src/types.ts';
import { ClaudeAdapter } from '../src/providers/claude.ts';
import { CodexAdapter } from '../src/providers/codex.ts';
import { PiAdapter } from '../src/providers/pi.ts';

/**
 * The classifier is fed REAL pane captures (test/fixtures/pane-<provider>-<state>.txt,
 * captured live: claude 2.1.170, codex-cli 0.138.0, pi 0.79.0) through each provider's
 * actual matchers. This pins both the per-provider busy/ready/trust signals AND the
 * first-match-wins ordering in `classifyState` without needing a live session.
 */
const FIXTURES = path.join(import.meta.dir, 'fixtures');
function fixture(name: string): string {
  // Bun.file().text() is async; tests load synchronously via the readable text decoder.
  return require('node:fs').readFileSync(path.join(FIXTURES, name), 'utf8') as string;
}

const adapters = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  pi: new PiAdapter(),
};

describe('classifyState over real pane captures', () => {
  const cases: Array<{ prov: keyof typeof adapters; file: string; want: AgentState }> = [
    { prov: 'claude', file: 'pane-claude-done.txt', want: 'done' },
    { prov: 'claude', file: 'pane-claude-running.txt', want: 'running' },
    { prov: 'codex', file: 'pane-codex-done.txt', want: 'done' },
    { prov: 'codex', file: 'pane-codex-running.txt', want: 'running' },
    { prov: 'codex', file: 'pane-codex-waiting.txt', want: 'waiting' },
    { prov: 'pi', file: 'pane-pi-done.txt', want: 'done' },
    { prov: 'pi', file: 'pane-pi-running.txt', want: 'running' },
  ];

  for (const { prov, file, want } of cases) {
    test(`${prov} ${file} → ${want}`, () => {
      expect(classifyState(adapters[prov], true, fixture(file))).toBe(want);
    });
  }

  test('not-alive → failed regardless of pane content', () => {
    // Even a perfectly idle "done" composer classifies as failed once the pane is gone.
    expect(classifyState(adapters.claude, false, fixture('pane-claude-done.txt'))).toBe('failed');
    expect(classifyState(adapters.codex, false, fixture('pane-codex-running.txt'))).toBe('failed');
    expect(classifyState(adapters.pi, false, '')).toBe('failed');
  });

  test('no signals → starting (booted, composer not up yet)', () => {
    // Representative pre-composer pane: a boot banner with NO ready/busy/trust signal.
    const early = '  Loading…\n  starting up the session\n';
    expect(classifyState(adapters.claude, true, early)).toBe('starting');
    expect(classifyState(adapters.codex, true, early)).toBe('starting');
    expect(classifyState(adapters.pi, true, early)).toBe('starting');
  });
});

describe('classifyState ordering (busy before ready)', () => {
  // claude/codex render BOTH the ready footer and the working indicator mid-turn — the
  // running fixtures contain both signals, so a working turn must classify as `running`.
  test('claude running fixture has BOTH busy and ready signals', () => {
    const pane = fixture('pane-claude-running.txt');
    expect(adapters.claude.busyMatch(pane)).toBe(true);
    expect(adapters.claude.readyMatch(pane)).toBe(true);
    expect(classifyState(adapters.claude, true, pane)).toBe('running');
  });

  test('codex running fixture has BOTH busy and ready signals', () => {
    const pane = fixture('pane-codex-running.txt');
    expect(adapters.codex.busyMatch(pane)).toBe(true);
    expect(adapters.codex.readyMatch(pane)).toBe(true);
    expect(classifyState(adapters.codex, true, pane)).toBe('running');
  });

  test('pi running fixture has BOTH busy and ready signals', () => {
    const pane = fixture('pane-pi-running.txt');
    expect(adapters.pi.busyMatch(pane)).toBe(true);
    expect(adapters.pi.readyMatch(pane)).toBe(true);
    expect(classifyState(adapters.pi, true, pane)).toBe('running');
  });

  test('waiting wins over busy/ready (synthetic: trust dialog + busy hint)', () => {
    // A stub where every matcher is true: the trust/interstitial check must win.
    const all: StateMatchers = {
      busyMatch: () => true,
      readyMatch: () => true,
      trustDialogMatch: () => true,
      interstitialMatch: () => true,
    };
    expect(classifyState(all, true, 'x')).toBe('waiting');
  });

  test('interstitial alone (no trust) → waiting', () => {
    const m: StateMatchers = {
      busyMatch: () => false,
      readyMatch: () => true,
      trustDialogMatch: () => false,
      interstitialMatch: () => true,
    };
    expect(classifyState(m, true, 'x')).toBe('waiting');
  });

  test('missing optional interstitialMatch is treated as false', () => {
    const m: StateMatchers = {
      busyMatch: () => false,
      readyMatch: () => true,
      trustDialogMatch: () => false,
    };
    expect(classifyState(m, true, 'x')).toBe('done');
  });
});

describe('isSettled', () => {
  test('done/waiting/failed settle; running/starting do not', () => {
    expect(isSettled('done')).toBe(true);
    expect(isSettled('waiting')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('running')).toBe(false);
    expect(isSettled('starting')).toBe(false);
  });
});

/**
 * The 2-poll debounce IS the reliability guarantee, and it lives in `reduceWait`.
 * Folding a scripted poll sequence asserts it deterministically — no live session, no
 * timing flake. This is the real proof the "sub-second gap between tool calls is never
 * misread as done" requirement holds.
 */
describe('reduceWait debounce', () => {
  const DEFAULT_UNTIL: AgentState[] = ['done', 'waiting', 'failed'];

  /** Fold a sequence of observed states; return the first state it settles on (or null). */
  function fold(seq: AgentState[], until: AgentState[] = DEFAULT_UNTIL): AgentState | null {
    let tracking = INITIAL_TRACKING;
    for (const observed of seq) {
      const r = reduceWait(tracking, observed, until);
      tracking = r.tracking;
      if (r.settled) return r.settled;
    }
    return null;
  }

  test('a single done never settles (needs 2 consecutive)', () => {
    expect(fold(['running', 'done', 'running'])).toBeNull();
  });

  test('a lone done flanked by running (a sub-second tool-call gap) is NOT settled', () => {
    // This is the exact misread the debounce exists to prevent.
    expect(fold(['running', 'running', 'done', 'running', 'running'])).toBeNull();
  });

  test('two consecutive done settles to done', () => {
    expect(fold(['running', 'done', 'done'])).toBe('done');
  });

  test('a running between two done blips resets the counter', () => {
    // [done, running, done, done]: first done (count 1), running resets, then the pair.
    expect(fold(['done', 'running', 'done', 'done'])).toBe('done');
  });

  test('starting also resets the debounce (progressing)', () => {
    expect(fold(['done', 'starting', 'done'])).toBeNull();
    expect(fold(['starting', 'done', 'done'])).toBe('done');
  });

  test('waiting and failed settle with 2 consecutive too', () => {
    expect(fold(['running', 'waiting', 'waiting'])).toBe('waiting');
    expect(fold(['running', 'failed', 'failed'])).toBe('failed');
  });

  test('respects `until`: a settled state not in `until` does not return', () => {
    // until=['done'] only: two consecutive waiting must NOT settle.
    expect(fold(['waiting', 'waiting'], ['done'])).toBeNull();
    // ...but two consecutive done does.
    expect(fold(['done', 'done'], ['done'])).toBe('done');
  });

  test('switching between distinct settled states does not settle (needs SAME state x2)', () => {
    // done then waiting then failed: never the SAME settled state twice in a row.
    expect(fold(['done', 'waiting', 'failed'])).toBeNull();
  });

  test('reducer is pure: same inputs, same outputs; tracking advances correctly', () => {
    const r1 = reduceWait(INITIAL_TRACKING, 'done', DEFAULT_UNTIL);
    expect(r1.settled).toBeNull();
    expect(r1.tracking).toEqual({ stableState: 'done', stableCount: 1 });
    const r2 = reduceWait(r1.tracking, 'done', DEFAULT_UNTIL);
    expect(r2.settled).toBe('done');
    expect(r2.tracking).toEqual({ stableState: 'done', stableCount: 2 });
    // A progressing observation resets to INITIAL_TRACKING.
    const r3 = reduceWait(r2.tracking, 'running', DEFAULT_UNTIL);
    expect(r3.settled).toBeNull();
    expect(r3.tracking).toEqual(INITIAL_TRACKING);
  });

  test('custom needed=3 requires three consecutive', () => {
    let tracking = INITIAL_TRACKING;
    const obs: AgentState[] = ['done', 'done', 'done'];
    const settled: Array<AgentState | null> = [];
    for (const o of obs) {
      const r = reduceWait(tracking, o, DEFAULT_UNTIL, 3);
      tracking = r.tracking;
      settled.push(r.settled);
    }
    expect(settled).toEqual([null, null, 'done']);
  });
});
