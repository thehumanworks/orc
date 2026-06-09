/**
 * Pure state classification + wait-debounce logic. No I/O, no driver — fed canned
 * pane strings + a liveness flag so it is fully unit-testable without a live session.
 * `Session.state()` and `Session.waitFor()` are thin wrappers over these functions.
 */
import type { AgentState } from './types.ts';

/**
 * The pane matchers a classifier needs. `ProviderAdapter` satisfies this structurally,
 * but the narrower shape keeps `classifyState` testable with stub matchers too.
 */
export interface StateMatchers {
  /** True when the provider's "actively working" indicator is present. */
  busyMatch(pane: string): boolean;
  /** True when the idle/ready composer is rendered (boot complete, turn yielded). */
  readyMatch(pane: string): boolean;
  /** True when a first-run trust dialog is showing and needs a response. */
  trustDialogMatch(pane: string): boolean;
  /** True when a non-trust modal interstitial (e.g. an update banner) is showing. */
  interstitialMatch?(pane: string): boolean;
}

/**
 * Classify the agent state from liveness + a single pane capture. ORDER MATTERS
 * (first match wins) and is load-bearing:
 *   1. not alive            → `failed`   (pane gone: crash OR clean exit)
 *   2. trust/interstitial   → `waiting`  (a TUI modal needs a response)
 *   3. busy indicator       → `running`  (a turn is in progress)
 *   4. ready composer       → `done`     (turn yielded; ready for input)
 *   5. otherwise            → `starting` (booted, composer not up yet)
 *
 * `busy` is checked BEFORE `ready` on purpose: claude/codex render the ready footer
 * (`bypass permissions on` / the status line) AND the working indicator
 * (`esc to interrupt`) simultaneously mid-turn, so a working turn must classify as
 * `running`, not `done`.
 */
export function classifyState(m: StateMatchers, alive: boolean, pane: string): AgentState {
  if (!alive) return 'failed';
  if (m.trustDialogMatch(pane) || (m.interstitialMatch?.(pane) ?? false)) return 'waiting';
  if (m.busyMatch(pane)) return 'running';
  if (m.readyMatch(pane)) return 'done';
  return 'starting';
}

/** A non-progressing state: one `waitFor` can settle on (vs `running`/`starting`). */
export function isSettled(s: AgentState): boolean {
  return s === 'done' || s === 'waiting' || s === 'failed';
}

/**
 * Map a `--for` value (CLI) / `for` field (daemon `POST .../wait`) to the set of states
 * `waitFor` should settle on. `settled` (default) = any non-progressing state. Returns
 * null for an invalid value. Pure + synchronous; lives here (not in the CLI) so both the
 * CLI and the daemon route mapping can share it without a circular import.
 */
export function resolveUntil(forArg: string): AgentState[] | null {
  switch (forArg) {
    case 'settled':
      return ['done', 'waiting', 'failed'];
    case 'done':
      return ['done'];
    case 'waiting':
      return ['waiting'];
    case 'failed':
      return ['failed'];
    default:
      return null;
  }
}

/** Debounce tracking carried across polls by `waitFor`. */
export interface WaitTracking {
  /** The non-progressing state observed on the previous poll (null if progressing). */
  stableState: AgentState | null;
  /** How many consecutive polls have observed `stableState`. */
  stableCount: number;
}

export const INITIAL_TRACKING: WaitTracking = { stableState: null, stableCount: 0 };

/** Default number of consecutive non-progressing polls required to settle. */
export const DEBOUNCE_POLLS = 2;

/**
 * Pure debounce reducer: fold ONE observed state into the tracking. Returns the
 * settled state to return from `waitFor` once a non-progressing state in `until` has
 * been observed for `needed` CONSECUTIVE polls, else null. A `running`/`starting`
 * observation resets the counter — so a sub-second gap between tool calls (a lone
 * `done` flanked by `running`) is never misread as end-of-turn.
 *
 * Folding `[running, done, running, done, done]` settles `done` only at the trailing
 * pair; a lone `done` between `running`s never settles. This reducer IS the reliability
 * guarantee, and it is unit-tested directly.
 */
export function reduceWait(
  tracking: WaitTracking,
  observed: AgentState,
  until: AgentState[],
  needed: number = DEBOUNCE_POLLS,
): { tracking: WaitTracking; settled: AgentState | null } {
  if (!isSettled(observed)) {
    return { tracking: INITIAL_TRACKING, settled: null };
  }
  const stableCount = observed === tracking.stableState ? tracking.stableCount + 1 : 1;
  const next: WaitTracking = { stableState: observed, stableCount };
  const settled = stableCount >= needed && until.includes(observed) ? observed : null;
  return { tracking: next, settled };
}
