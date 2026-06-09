/**
 * Pure helpers for verifying a pasted prompt actually landed in a provider's composer
 * before `Session.send()` submits. Split out of session.ts so both the Session and the
 * provider adapters can share them without an import cycle.
 *
 * Two rendering regimes, BOTH observed live (claude 2.1.x, codex-cli 0.138.0, pi 0.79.0):
 *
 *  - SMALL paste → shown LITERALLY in the composer. We confirm a distinctive slice from
 *    the END of the prompt is visible. The END (not the start): a composer always keeps
 *    the cursor — the tail of the paste — on screen, whereas a multi-KB head scrolls off
 *    the top. (The old probe checked the FIRST line, which is exactly what scrolls away,
 *    so large prompts never verified and every retry re-pasted on top — the compounding
 *    bug.) Matching is whitespace-insensitive because the TUI wraps/indents.
 *
 *  - LARGE / multi-line paste → COLLAPSED into a placeholder chip; the literal text is
 *    NOT rendered, so the literal probe cannot match. The chip itself is the "landed"
 *    signal and is matched per-provider (`ProviderAdapter.pasteLanded`), since the format
 *    differs: claude `[Pasted text #N +M lines]`, codex `[Pasted Content B chars]`,
 *    pi `[paste #N +L lines]`.
 */

/** Collapse every whitespace run to a single space so a probe matches despite the
 *  composer's wrapping/indentation. */
export function normalizePane(pane: string): string {
  return pane.replace(/\s+/g, ' ');
}

/** Below this many chars an end slice isn't distinctive, so we pull in preceding lines. */
const PROBE_MIN = 12;
/** Cap the probe so it sits on a single composer row (a wrap would split it after
 *  normalization, inserting a space mid-token). */
const PROBE_CAP = 48;

/**
 * End-anchored literal probe: a distinctive slice from the END of `text` — the part
 * nearest the cursor, which the composer keeps on screen. Anchors on the last non-empty
 * line; if that line is short, pulls in preceding line(s) until the slice is distinctive,
 * then keeps the TAIL (capped). Whitespace is collapsed (the TUI wraps/indents). Returns
 * null for an empty/whitespace-only prompt (nothing to verify). PURE.
 */
export function pasteProbe(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let probe = lines[lines.length - 1]!;
  for (let i = lines.length - 2; i >= 0 && probe.length < PROBE_MIN; i--) {
    probe = `${lines[i]} ${probe}`;
  }
  const collapsed = probe.replace(/\s+/g, ' ');
  return collapsed.length > PROBE_CAP ? collapsed.slice(-PROBE_CAP) : collapsed;
}

/**
 * Whether the literal end-probe is visible in the pane (the SMALL-paste regime). Returns
 * true for an empty/whitespace prompt (nothing to verify). Whitespace-insensitive. PURE.
 */
export function literalPasteLanded(pane: string, text: string): boolean {
  const probe = pasteProbe(text);
  if (probe === null) return true;
  return normalizePane(pane).includes(probe);
}
