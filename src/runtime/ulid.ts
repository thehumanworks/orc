/**
 * Monotonic ULIDs (https://github.com/ulid/spec): 48-bit ms timestamp + 80 random bits,
 * Crockford base32, 26 chars. Lexicographic order == creation order within a process
 * (same-millisecond ids increment the random part). Matches INBOX_FILE_RE.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;
const TIME_MAX = 2 ** 48 - 1;

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  return Array.from(randomBytes(RAND_LEN), (b) => b & 31);
}

/** Increment a base32 digit array in place; false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * A new ULID. Strictly increasing within this process, even when the clock stalls or
 * steps backwards (the previous timestamp is reused and the random part incremented).
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now < 0 || now > TIME_MAX) throw new Error(`ulid: bad time ${now}`);
  if (now <= lastTime) {
    if (!increment(lastRand)) {
      lastTime += 1;
      lastRand = randomDigits();
    }
  } else {
    lastTime = Math.floor(now);
    lastRand = randomDigits();
  }
  return encodeTime(lastTime) + lastRand.map((d) => ENCODING.charAt(d)).join('');
}

export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

/** Millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new Error(`not a ULID: '${id}'`);
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) t = t * 32 + ENCODING.indexOf(id.charAt(i));
  return t;
}
