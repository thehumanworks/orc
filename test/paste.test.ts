import { describe, test, expect } from 'bun:test';
import { pasteProbe, normalizePane, literalPasteLanded } from '../src/paste.ts';

/**
 * The send() large-prompt bug: the probe checked the FIRST line, which scrolls OFF the
 * top of a multi-KB composer (only the tail, near the cursor, stays visible), so the
 * verify never matched → every retry re-pasted on top (compounding). The fix anchors the
 * probe to the END of the prompt. These tests pin that end-anchoring as a PURE property.
 */
describe('pasteProbe — end-anchored', () => {
  test('empty / whitespace-only → null (nothing to verify)', () => {
    expect(pasteProbe('')).toBeNull();
    expect(pasteProbe('   \n\t  \n')).toBeNull();
  });

  test('single-line prompt → the (collapsed) line itself', () => {
    expect(pasteProbe('do the thing now')).toBe('do the thing now');
    // Whitespace collapsed so it matches a wrapped/indented composer render.
    expect(pasteProbe('  hello   world  ')).toBe('hello world');
  });

  test('200-line prompt → a slice from the BOTTOM, not the top', () => {
    const lines: string[] = ['STARTTOK_head first content line'];
    for (let i = 0; i < 198; i++) lines.push(`filler line number ${i} with some words`);
    lines.push('ENDTOK_tail final content line');
    const text = lines.join('\n');

    const probe = pasteProbe(text)!;
    expect(probe).not.toBeNull();
    // The probe is drawn from the END of the prompt...
    expect(probe).toContain('ENDTOK_tail');
    expect(normalizePane(lines[lines.length - 1]!)).toContain(probe);
    // ...and is NOT present at the top (the first line — what scrolls off-screen).
    expect(probe).not.toContain('STARTTOK_head');
    expect(normalizePane(lines[0]!)).not.toContain(probe);
  });

  test('probe sits at the bottom of a rendered composer (head scrolled off)', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      i === 0 ? 'FIRSTLINE alpha beta' : `body line ${i} lorem ipsum dolor sit amet`,
    );
    lines.push('LASTLINE_distinctive omega');
    const text = lines.join('\n');
    const probe = pasteProbe(text)!;
    // A composer that only kept the LAST ~5 lines (head scrolled off) still verifies.
    const composerTail = lines.slice(-5).join('\n');
    expect(normalizePane(composerTail).includes(probe)).toBe(true);
    // The same probe would NOT be found if only the HEAD were visible.
    const composerHead = lines.slice(0, 5).join('\n');
    expect(normalizePane(composerHead).includes(probe)).toBe(false);
  });

  test('short last line pulls in preceding context for distinctiveness', () => {
    const text = 'a very distinctive penultimate line of content\ngo';
    const probe = pasteProbe(text)!;
    expect(probe.endsWith('go')).toBe(true);
    // "go" alone (2 chars) is not distinctive — preceding context is folded in.
    expect(probe.length).toBeGreaterThan(2);
    expect(probe).toContain('penultimate');
  });

  test('long last line → only the TAIL (capped, ≤48), near the cursor', () => {
    const last = 'x'.repeat(300) + ' DISTINCTIVE_TAIL_END';
    const probe = pasteProbe(`some earlier line\n${last}`)!;
    expect(probe.length).toBeLessThanOrEqual(48);
    expect(probe.endsWith('DISTINCTIVE_TAIL_END')).toBe(true);
  });
});

describe('literalPasteLanded', () => {
  test('matches when the end-probe is visible (whitespace-insensitive)', () => {
    const text = 'line one\nline two\nFINALTOK done';
    // A composer that wrapped/indented the tail still matches.
    const pane = '❯   line two\n    FINALTOK   done\n';
    expect(literalPasteLanded(pane, text)).toBe(true);
  });

  test('does not match when only the head is on screen', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `content row ${i} word word`);
    lines[0] = 'HEADTOK first';
    lines.push('TAILTOK last row');
    const text = lines.join('\n');
    const headOnlyPane = `❯ ${lines[0]}\n  ${lines[1]}\n`;
    expect(literalPasteLanded(headOnlyPane, text)).toBe(false);
  });

  test('empty prompt → treated as landed', () => {
    expect(literalPasteLanded('anything', '   ')).toBe(true);
  });
});
