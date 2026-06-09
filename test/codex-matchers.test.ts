import { describe, test, expect } from 'bun:test';
import { CodexAdapter } from '../src/providers/codex.ts';

/**
 * BUG 2 — codex readyMatch must be true ONLY on the live composer, and false on the
 * trust dialog and the "Update available" interstitial (whose default is a self-update).
 * The panes below are REAL captures from `codex --dangerously-bypass-approvals-and-sandbox`
 * (codex-cli 0.138.0) taken during the fix; the update pane is reconstructed from the
 * binary's interstitial strings (codex was already current, so it can't be shown live).
 */

// Real capture: trust dialog (the first screen). Contains '›' as the selection cursor.
const TRUST_PANE = `> You are in /private/var/folders/4m/3lqz/T/tmp.Em0Byw

  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue`;

// Real capture: live ready state (after dismissing the trust dialog). Bottom status
// line `gpt-5.5 high · /private/.../repo` is the stable ready marker.
const READY_PANE = `│ model:       gpt-5.5 high   /model to change            │
│ directory:   /private/var/folders/4m/3lqz/T/tmp.Em0Byw76Gp/repo │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯

  Tip: Try the Codex App. Run 'codex app' or visit
  https://chatgpt.com/codex?app-landing-page=true


› Find and fix a bug in @filename

  gpt-5.5 high · /private/var/folders/4m/3lqz345x4079phy2699l6bfc0000gn/T/tmp.E…`;

// Reconstructed from the binary's interstitial strings. Note it ALSO contains '›'.
const UPDATE_PANE = `  Update available!
  See full release notes:
  https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Not now

  Press enter to continue`;

describe('codex readyMatch (BUG 2)', () => {
  const a = new CodexAdapter();

  test('ready ONLY on the live composer status line', () => {
    expect(a.readyMatch(READY_PANE)).toBe(true);
  });

  test('NOT ready on the trust dialog (despite containing ›)', () => {
    expect(a.readyMatch(TRUST_PANE)).toBe(false);
  });

  test('NOT ready on the update interstitial (despite containing ›)', () => {
    expect(a.readyMatch(UPDATE_PANE)).toBe(false);
  });

  test('NOT ready on a bare › with no status line', () => {
    expect(a.readyMatch('› type here')).toBe(false);
  });

  test('does not key off the rotating composer placeholder', () => {
    // The placeholder rotates ('Explain this codebase', 'Write tests for @filename', …);
    // a pane showing only a placeholder but no status line must NOT count as ready.
    expect(a.readyMatch('› Explain this codebase')).toBe(false);
    expect(a.readyMatch('› Write tests for @filename')).toBe(false);
  });
});

describe('codex trustDialogMatch (BUG 2)', () => {
  const a = new CodexAdapter();

  test('matches the directory-trust QUESTION', () => {
    expect(a.trustDialogMatch(TRUST_PANE)).toBe(true);
  });

  test('does NOT over-match the full-access dialog ("Yes, continue anyway")', () => {
    // Keying off the option label would over-match this distinct dialog.
    const fullAccess = 'Enable full access? ... Yes, continue anyway';
    expect(a.trustDialogMatch(fullAccess)).toBe(false);
  });

  test('false on ready + update panes', () => {
    expect(a.trustDialogMatch(READY_PANE)).toBe(false);
    expect(a.trustDialogMatch(UPDATE_PANE)).toBe(false);
  });
});

describe('codex interstitialMatch (BUG 2 — never auto-Enter the update banner)', () => {
  const a = new CodexAdapter();

  test('matches the update interstitial', () => {
    expect(a.interstitialMatch(UPDATE_PANE)).toBe(true);
  });

  test('false on trust + ready panes', () => {
    expect(a.interstitialMatch(TRUST_PANE)).toBe(false);
    expect(a.interstitialMatch(READY_PANE)).toBe(false);
  });
});
