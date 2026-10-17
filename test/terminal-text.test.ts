/**
 * src/terminal-text.ts: agent-sourced text is made terminal-safe before it reaches a TTY.
 */
import { describe, expect, test } from 'bun:test';
import { TerminalSanitizer, sanitizeTerminalText as clean } from '../src/terminal-text.ts';

const ESC = '\x1b';

describe('sanitizeTerminalText', () => {
  test('removes CSI sequences (colours, cursor moves, erase, private modes)', () => {
    expect(clean(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(clean(`a${ESC}[2Jb`)).toBe('ab');
    expect(clean(`a${ESC}[1;1Hb${ESC}[2Kc`)).toBe('abc');
    expect(clean(`a${ESC}[?25lb${ESC}[?1049hc`)).toBe('abc');
    expect(clean(`a${ESC}[38;2;255;0;0mb`)).toBe('ab');
    expect(clean(`a${ESC}[ qb`)).toBe('ab'); // intermediate byte (DECSCUSR)
  });

  test('removes OSC strings with their payload (title, hyperlinks, clipboard), BEL- or ST-terminated', () => {
    expect(clean(`a${ESC}]0;pwned title\x07b`)).toBe('ab');
    expect(clean(`a${ESC}]2;pwned${ESC}\\b`)).toBe('ab');
    expect(clean(`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`)).toBe('click');
    expect(clean(`a${ESC}]52;c;cm0gLXJmIH4=\x07b`)).toBe('ab');
  });

  test('removes DCS / SOS / PM / APC strings', () => {
    expect(clean(`a${ESC}P1$r0m${ESC}\\b`)).toBe('ab');
    expect(clean(`a${ESC}Xsos${ESC}\\b`)).toBe('ab');
    expect(clean(`a${ESC}^pm${ESC}\\b`)).toBe('ab');
    expect(clean(`a${ESC}_Gf=100;AAAA${ESC}\\b`)).toBe('ab');
  });

  test('removes two-character escapes (reset, save/restore cursor, charsets, keypad)', () => {
    expect(clean(`a${ESC}cb`)).toBe('ab');
    expect(clean(`a${ESC}7b${ESC}8c`)).toBe('abc');
    expect(clean(`a${ESC}(0b${ESC}(Bc`)).toBe('abc');
    expect(clean(`a${ESC}#8b`)).toBe('ab');
    expect(clean(`a${ESC}=b${ESC}>c`)).toBe('abc');
  });

  test('removes 8-bit C1 sequences and every other C1 control', () => {
    expect(clean('a\u009b31mb')).toBe('ab'); // CSI
    expect(clean('a\u009d0;title\u009cb')).toBe('ab'); // OSC … ST
    expect(clean('a\u0090dcs\u009cb')).toBe('ab'); // DCS … ST
    // NEL, RI, a stray ST and PAD are dropped; APC (0x9f) opens a string that eats the rest of the line.
    expect(clean('a\u0085b\u008dc\u009cd\u0080e\u009ff')).toBe('abcde');
    expect(clean('a\u009fapc payload\nnext')).toBe('a\nnext');
  });

  test('removes C0 controls and DEL; keeps newline and tab', () => {
    expect(clean('a\x00b\x07c\x08d\x0be\x0cf\x7fg')).toBe('abcdefg');
    expect(clean('one\ttwo\nthree\n')).toBe('one\ttwo\nthree\n');
    expect(clean(`${ESC}`)).toBe('');
  });

  test('keeps the CR of a CRLF line ending; drops a lone CR (it could overwrite the line)', () => {
    expect(clean('a\r\nb\r\n')).toBe('a\r\nb\r\n');
    expect(clean('rm -rf ~\r# harmless')).toBe('rm -rf ~# harmless');
    expect(clean('a\r')).toBe('a');
    expect(clean('a\r\r\nb')).toBe('a\r\nb');
  });

  test('an unterminated string never swallows past the end of its line', () => {
    expect(clean(`keep${ESC}]0;never closed\nnext line`)).toBe('keep\nnext line');
  });

  test('a sequence broken by a newline or control aborts, keeping what follows', () => {
    expect(clean(`a${ESC}[12\nb`)).toBe('a\nb');
    expect(clean(`a${ESC}\nb`)).toBe('a\nb');
    expect(clean(`a${ESC}(\tb`)).toBe('a\tb');
    expect(clean(`a${ESC}]x${ESC}[31mb`)).toBe('ab'); // ESC inside a string starts a new escape
  });

  test('printable Unicode is untouched (and returned as-is when nothing needs removing)', () => {
    const s = 'héllo ✓ ● 日本語 🚀 — “quotes”  nbsp';
    expect(clean(s)).toBe(s);
  });

  test('idempotent', () => {
    const nasty = `x${ESC}[31m${ESC}]0;t\x07\u009b2J\r\n\x07y\rz`;
    expect(clean(clean(nasty))).toBe(clean(nasty));
    expect(clean(nasty)).toBe('x\r\nyz');
  });
});

describe('TerminalSanitizer (streaming)', () => {
  const samples = [
    `before ${ESC}[1;31mbold red${ESC}[0m after`,
    `t${ESC}]0;title\x07x${ESC}]8;;http://e${ESC}\\link${ESC}]8;;${ESC}\\`,
    `crlf\r\nlone\rcr\u009b2Jdone`,
    `${ESC}P1$r${ESC}\\${ESC}(B${ESC}c✓ 日本\n`,
  ];

  test('a sequence split at any chunk boundary is removed exactly as in one piece', () => {
    for (const s of samples) {
      const whole = clean(s);
      const cps = [...s];
      for (let i = 0; i <= cps.length; i++) {
        const z = new TerminalSanitizer();
        const got = z.push(cps.slice(0, i).join('')) + z.push(cps.slice(i).join('')) + z.end();
        expect(got).toBe(whole);
      }
      // One code point at a time.
      const z = new TerminalSanitizer();
      expect(cps.map((c) => z.push(c)).join('') + z.end()).toBe(whole);
    }
  });

  test('end() drops an unfinished sequence and resets', () => {
    const z = new TerminalSanitizer();
    expect(z.push(`ok${ESC}[3`)).toBe('ok');
    expect(z.end()).toBe('');
    expect(z.push('1m fresh')).toBe('1m fresh');
  });
});
