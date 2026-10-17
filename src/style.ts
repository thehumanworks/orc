/**
 * Styling for orc's human-readable output. Zero dependencies, no I/O.
 *
 * - `sgr()` wraps text in ANSI SGR codes from the 16-colour palette plus bold/dim/italic
 *   only, so the user's terminal theme (light or dark) decides the actual colours.
 * - `Style` is what renderers take: semantic roles (`id`, `label`, `muted`, `status`, …).
 *   `PLAIN` — the default everywhere — returns every input unchanged, so SDK, daemon and
 *   MCP consumers never receive ANSI, and the CLI's colour-off output is byte-identical to
 *   the unstyled renderers. Glyphs (● ✓ ✗ …) appear only when colour is on.
 * - One status palette (`toneOf`): a status word gets the same colour in every view, and
 *   the same glyph wherever it stands on its own (`status`/`tag`: state, wait, detail
 *   views, a list row's lifecycle tag, step ok/FAIL, run results). Secondary statuses
 *   inside dense rows (`tone`) are colour only.
 * - `Style.sanitize` additionally makes dynamic text terminal-safe (terminal-text.ts); the
 *   CLI turns it on for a TTY destination, independent of colour.
 * - `decideColor()` — the CLI's per-stream colour decision.
 */
import { sanitizeTerminalText } from './terminal-text.ts';

export type Attr = 'bold' | 'dim' | 'italic' | 'red' | 'green' | 'yellow' | 'magenta' | 'cyan';

const OPEN: Readonly<Record<Attr, number>> = {
  bold: 1,
  dim: 2,
  italic: 3,
  red: 31,
  green: 32,
  yellow: 33,
  magenta: 35,
  cyan: 36,
};
/** Each attribute's own reset (22 = normal intensity, 23 = not italic, 39 = default fg). */
const CLOSE: Readonly<Record<Attr, number>> = {
  bold: 22,
  dim: 22,
  italic: 23,
  red: 39,
  green: 39,
  yellow: 39,
  magenta: 39,
  cyan: 39,
};

/**
 * `text` wrapped in the SGR `attrs`, closing exactly what it opened (never a full reset, so
 * nothing outside the span is disturbed). Wrapped per line — a span never crosses a newline
 * (safe for `less -R`, line-oriented tools and line-by-line restyling). Empty → empty.
 */
export function sgr(text: string, attrs: readonly Attr[]): string {
  // A malformed record (e.g. a field missing from a remote daemon's JSON) must print the
  // same text as plain mode (`${undefined}`), never throw.
  if (typeof text !== 'string') text = String(text);
  if (attrs.length === 0 || text.length === 0) return text;
  const open = `\x1b[${attrs.map((a) => OPEN[a]).join(';')}m`;
  const close = `\x1b[${[...new Set(attrs.map((a) => CLOSE[a]))].join(';')}m`;
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? `${open}${l}${close}` : l))
    .join('\n');
}

const SGR_RE = /\x1b\[[0-9;]*m/g;

/** `text` without SGR sequences (the inverse of `sgr` for widths and tests). */
export function stripAnsi(text: string): string {
  return text.replace(SGR_RE, '');
}

// ---------------------------------------------------------------------------------------
// The status palette
// ---------------------------------------------------------------------------------------

/**
 * What a status means at a glance: in progress, not started, succeeded, failed, needs
 * attention, crashed but resumable, or finished/inert.
 */
export type Tone = 'active' | 'pending' | 'success' | 'danger' | 'attention' | 'paused' | 'inert';

export const TONE_STYLES: Readonly<Record<Tone, { readonly attrs: readonly Attr[]; readonly glyph: string }>> = {
  active: { attrs: ['cyan'], glyph: '●' },
  pending: { attrs: ['dim'], glyph: '◦' },
  success: { attrs: ['green'], glyph: '✓' },
  danger: { attrs: ['red'], glyph: '✗' },
  attention: { attrs: ['yellow'], glyph: '!' },
  paused: { attrs: ['magenta'], glyph: '◌' },
  inert: { attrs: ['dim'], glyph: '○' },
};

/** Every status word orc prints, mapped once (unknown words stay unstyled). */
const STATUS_TONES: ReadonlyMap<string, Tone> = new Map<string, Tone>([
  // session lifecycle (SessionStatus)
  ['running', 'active'],
  ['spawning', 'active'],
  ['suspended', 'paused'],
  ['dead', 'inert'],
  // agent state (AgentState)
  ['starting', 'active'],
  ['done', 'success'],
  ['waiting', 'attention'],
  ['failed', 'danger'],
  // workflow run status
  ['orphaned', 'paused'],
  ['cancelled', 'inert'],
  // attempt phases + scheduler statuses
  ['queued', 'pending'],
  ['pending', 'pending'],
  ['ready', 'pending'],
  ['dispatched', 'active'],
  ['verifying', 'active'],
  ['succeeded', 'success'],
  ['blocked', 'attention'],
  ['skipped', 'inert'],
  ['abandoned', 'inert'],
  // step result marks
  ['ok', 'success'],
  ['FAIL', 'danger'],
  ['UNVERIFIED', 'attention'],
  // send delivery phases
  ['acknowledged', 'success'],
  ['submitted', 'success'],
  ['unknown', 'attention'],
  // settings files
  ['used', 'success'],
  ['missing', 'inert'],
  ['same-as-global', 'inert'],
]);

export function toneOf(word: string): Tone | undefined {
  return STATUS_TONES.get(word);
}

// ---------------------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------------------

export interface StyleOptions {
  /** Emit ANSI SGR codes (and status glyphs). */
  color?: boolean;
  /** Make dynamic text terminal-safe (strip escape sequences and control characters). */
  sanitize?: boolean;
}

/**
 * Semantic styling roles. Every method takes DYNAMIC text (it is sanitized when
 * `sanitize`) and colours it when `color`; with neither it is the identity. Methods are
 * bound (arrow properties), so they can be passed around as callbacks.
 */
export class Style {
  /** Brand checked by `resolveStyle` (survives duplicate module copies). */
  readonly kind = 'orc.style' as const;
  readonly color: boolean;
  readonly sanitize: boolean;

  constructor(opts: StyleOptions = {}) {
    this.color = opts.color === true;
    this.sanitize = opts.sanitize === true;
  }

  /** Dynamic text, never coloured (terminal-safe when `sanitize`). */
  readonly text = (s: string): string => (this.sanitize ? sanitizeTerminalText(String(s)) : s);
  /** Dynamic text in explicit SGR attributes. */
  readonly paint = (s: string, ...attrs: Attr[]): string => {
    const t = this.text(s);
    return this.color ? sgr(t, attrs) : t;
  };

  readonly bold = (s: string): string => this.paint(s, 'bold');
  /** Section headings. */
  readonly heading = (s: string): string => this.paint(s, 'bold');
  /** Session / run / step ids: the thing a row is about. */
  readonly id = (s: string): string => this.paint(s, 'bold');
  /** `@alias` handles. */
  readonly alias = (s: string): string => this.paint(s, 'cyan');
  /** Labels of key–value blocks and `key=` prefixes. */
  readonly label = (s: string): string => this.paint(s, 'dim');
  /** Secondary detail: paths, timestamps, digests, hosts, notices. */
  readonly muted = (s: string): string => this.paint(s, 'dim');
  /** A command the user can run. */
  readonly command = (s: string): string => this.paint(s, 'cyan');
  readonly accent = (s: string): string => this.paint(s, 'cyan');
  readonly success = (s: string): string => this.paint(s, 'green');
  readonly danger = (s: string): string => this.paint(s, 'red');
  readonly warning = (s: string): string => this.paint(s, 'yellow');
  /** `error:` / `fatal:` prefixes. */
  readonly errorLabel = (s: string): string => this.paint(s, 'bold', 'red');
  /** `warning:` prefixes. */
  readonly warningLabel = (s: string): string => this.paint(s, 'bold', 'yellow');

  /** `s` (default: `word`) in the colour of `word`'s status tone; no glyph. */
  readonly tone = (word: string, s: string = word): string => {
    const t = toneOf(word);
    return t ? this.paint(s, ...TONE_STYLES[t].attrs) : this.text(s);
  };

  /**
   * A status word, optionally padded to `pad` columns. Plain: the (padded) word. Colour:
   * `<glyph> <word>` in its tone colour — an unknown word gets two spaces instead of a
   * glyph when padded, so columns stay aligned.
   */
  readonly status = (word: string, pad?: number): string => {
    const text = this.text(word);
    const padded = pad !== undefined ? text.padEnd(pad) : text;
    if (!this.color) return padded;
    const t = toneOf(word);
    if (!t) return pad !== undefined ? `  ${padded}` : padded;
    return sgr(`${TONE_STYLES[t].glyph} ${padded}`, TONE_STYLES[t].attrs);
  };

  /** A status in brackets: plain `[word]`; colour → `status(word)` (the glyph replaces the brackets). */
  readonly tag = (word: string): string =>
    this.color && toneOf(word) ? this.status(word) : `[${this.text(word)}]`;
}

/** No colour, no sanitizing: every method is the identity. The default for every renderer. */
export const PLAIN: Style = new Style();

export function isStyle(x: unknown): x is Style {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'orc.style';
}

/**
 * `x` when it is a Style, else PLAIN — so a renderer passed to `Array.prototype.map` (which
 * hands it an index as the second argument) still renders plain.
 */
export function resolveStyle(x: unknown): Style {
  return isStyle(x) ? x : PLAIN;
}

export function createStyle(opts: StyleOptions = {}): Style {
  return opts.color || opts.sanitize ? new Style(opts) : PLAIN;
}

// ---------------------------------------------------------------------------------------
// Colour detection
// ---------------------------------------------------------------------------------------

export type ColorMode = 'auto' | 'always' | 'never';
export const COLOR_MODES: readonly ColorMode[] = ['auto', 'always', 'never'];

export interface ColorDecisionInput {
  /** `--color[=WHEN]` / `--no-color`; undefined = auto. */
  mode?: ColorMode;
  env?: Record<string, string | undefined>;
  /** Whether the destination stream is a terminal. */
  isTTY?: boolean;
}

/**
 * Whether to colour one output stream. Precedence: `--color=always|never` (`--no-color`)
 * > `NO_COLOR` (any non-empty value disables) > `FORCE_COLOR` (`0`/`false` disable;
 * ``/`1`/`2`/`3`/`true` enable; other values are ignored) > `CLICOLOR_FORCE` (non-empty
 * and not `0` enables) > `TERM=dumb` (disables) > whether the stream is a TTY.
 */
export function decideColor(input: ColorDecisionInput): boolean {
  if (input.mode === 'always') return true;
  if (input.mode === 'never') return false;
  const env = input.env ?? {};
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    const v = force.trim().toLowerCase();
    if (v === '0' || v === 'false') return false;
    if (v === '' || v === '1' || v === '2' || v === '3' || v === 'true') return true;
  }
  const cliForce = env.CLICOLOR_FORCE;
  if (cliForce !== undefined && cliForce !== '' && cliForce !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return input.isTTY === true;
}
