/**
 * Terminal-safe text. Agent-sourced text (transcripts, journal entries, workflow logs,
 * provider errors) is untrusted: printed raw to a terminal, an escape sequence in it can
 * retitle the window, rewrite or erase what is on screen, plant OSC 8 hyperlinks or worse.
 * `sanitizeTerminalText` removes every ESC-initiated sequence (CSI, OSC, DCS/SOS/PM/APC
 * strings, two-character escapes), their 8-bit C1 equivalents, and every other C0/C1
 * control character, keeping `\n`, `\t` and a `\r` that ends a CRLF line ending. A lone
 * `\r` (which could overwrite the visible line) is dropped.
 *
 * Pure: the CLI applies it only when the destination stream is a TTY — piped/redirected
 * output and `--json` are never altered (see Style.sanitize in style.ts).
 */

const enum State {
  Ground,
  /** After ESC. */
  Esc,
  /** ESC + intermediate bytes (0x20-0x2f), awaiting the final byte. */
  EscIntermediate,
  /** Control sequence (ESC [ or 8-bit CSI): parameter/intermediate bytes until a final byte. */
  Csi,
  /** OSC / DCS / SOS / PM / APC payload: dropped until BEL or ST. */
  Str,
  /** ESC inside a string payload: `\` completes ST; anything else starts a new escape. */
  StrEsc,
}

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
/** 8-bit DCS, SOS, OSC, PM, APC: each opens a string terminated by ST (or BEL). */
const C1_STRING_OPENERS: ReadonlySet<number> = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
/** `]` OSC, `P` DCS, `X` SOS, `^` PM, `_` APC after ESC. */
const ESC_STRING_OPENERS: ReadonlySet<number> = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

/** Anything the sanitizer would touch: C0 except TAB/LF (CR included), DEL, C1. */
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * Streaming sanitizer: feed chunks with `push` (an escape sequence or CRLF may span
 * chunks), then call `end` once. Never emits ESC or any C0/C1 control except `\t`, `\n`
 * and the `\r` of a CRLF.
 */
export class TerminalSanitizer {
  private state: State = State.Ground;
  private pendingCR = false;

  push(chunk: string): string {
    if (this.state === State.Ground && !this.pendingCR && !UNSAFE_RE.test(chunk)) return chunk;
    let out = '';
    for (const ch of chunk) {
      const c = ch.codePointAt(0)!;
      // `again`: an aborted sequence re-reads the current character in Ground.
      for (let again = true; again; ) {
        again = false;
        switch (this.state) {
          case State.Ground:
            if (this.pendingCR) {
              this.pendingCR = false;
              if (c === LF) {
                out += '\r\n';
                break;
              }
              // A lone CR is dropped; handle `c` normally.
            }
            if (c === CR) this.pendingCR = true;
            else if (c === ESC) this.state = State.Esc;
            else if (c === C1_CSI) this.state = State.Csi;
            else if (C1_STRING_OPENERS.has(c)) this.state = State.Str;
            else if (c === LF || c === TAB) out += ch;
            else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
              /* other C0, DEL, C1 (incl. a stray ST): dropped */
            } else out += ch;
            break;
          case State.Esc:
            if (c === 0x5b) this.state = State.Csi;
            else if (ESC_STRING_OPENERS.has(c)) this.state = State.Str;
            else if (c >= 0x20 && c <= 0x2f) this.state = State.EscIntermediate;
            else if (c >= 0x30 && c <= 0x7e) this.state = State.Ground; // ESC 7, ESC c, ESC =, …
            else if (c !== ESC) {
              this.state = State.Ground;
              again = true;
            }
            break;
          case State.EscIntermediate:
            if (c >= 0x30 && c <= 0x7e) this.state = State.Ground;
            else if (c < 0x20 || c > 0x2f) {
              this.state = State.Ground;
              again = true;
            }
            break;
          case State.Csi:
            if (c >= 0x40 && c <= 0x7e) this.state = State.Ground;
            else if (c < 0x20 || c > 0x3f) {
              // Not a parameter/intermediate byte (e.g. a newline): abort the sequence.
              this.state = State.Ground;
              again = true;
            }
            break;
          case State.Str:
            if (c === BEL || c === C1_ST) this.state = State.Ground;
            else if (c === ESC) this.state = State.StrEsc;
            else if (c === LF) {
              // Never swallow past the end of a line, even for an unterminated string.
              this.state = State.Ground;
              again = true;
            }
            break;
          case State.StrEsc:
            if (c === 0x5c) this.state = State.Ground;
            else {
              this.state = State.Esc;
              again = true;
            }
            break;
        }
      }
    }
    return out;
  }

  /** End of stream: an unfinished sequence and a trailing lone CR are dropped. */
  end(): string {
    this.state = State.Ground;
    this.pendingCR = false;
    return '';
  }
}

/** `text` with escape sequences and control characters removed (see the module doc). */
export function sanitizeTerminalText(text: string): string {
  if (!UNSAFE_RE.test(text)) return text;
  const s = new TerminalSanitizer();
  return s.push(text) + s.end();
}
