#!/usr/bin/env bun
/**
 * A tiny conversational stand-in for `pi --mode rpc` (pi 1.2.0 wire, LF JSONL on stdio),
 * so scripts/verify-runtime/all.ts and scripts/verify-runtime/pi.ts can exercise the pi
 * path on a host without pi:
 *
 *   bun scripts/verify-runtime/all.ts --providers pi --pi-bin test/fixtures/pi-chat-fake.ts
 *
 * Behaviour (deterministic, no network):
 * - `--version` prints 1.2.0.
 * - History persists in `<--session-dir>/0000_<--session-id>.jsonl` ({role, content} lines,
 *   readable by orc's pi transcript parser), so resume and recall survive restarts.
 * - A prompt asking to count / write every integer / an essay streams deltas until `abort`.
 * - Replies: "exactly one word…: X" → X; "same single word you replied with last time" →
 *   the last reply; "…first message…" → the first reply; "What codeword…" → the codeword
 *   from "Remember the codeword X" in history; otherwise "OK".
 * - stdin EOF → exit 0 (like pi).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('1.2.0\n');
  process.exit(0);
}
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = flag('--session-id') ?? 'fake';
const sessionDir = flag('--session-dir') ?? process.cwd();
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, `0000_${sessionId}.jsonl`);

interface Line {
  role: 'user' | 'assistant';
  content: string;
}
function history(): Line[] {
  try {
    return fs
      .readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
  } catch {
    return [];
  }
}
const append = (l: Line) => fs.appendFileSync(sessionFile, `${JSON.stringify(l)}\n`);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

function reply(text: string, h: Line[]): string {
  const replies = h.filter((l) => l.role === 'assistant').map((l) => l.content);
  const one = /exactly one word[^:]*:\s*([A-Za-z0-9-]+)/i.exec(text);
  if (one) return one[1]!;
  if (/same single word you replied with last time/i.test(text)) return replies.at(-1) ?? 'OK';
  if (/first message/i.test(text)) return replies[0] ?? 'OK';
  if (/what codeword/i.test(text)) {
    for (const l of h) {
      const m = l.role === 'user' ? /codeword\s+"?([A-Z][A-Z0-9-]+)/.exec(l.content) : null;
      if (m) return m[1]!;
    }
  }
  return 'OK';
}

let open: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function settle(text: string, stopReason: 'stop' | 'aborted'): void {
  out({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  });
  out({ type: 'turn_end' });
  out({ type: 'agent_end', messages: [], willRetry: false });
  out({ type: 'agent_settled', aborted: stopReason === 'aborted' });
  open = null;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let cmd: Record<string, unknown>;
  try {
    cmd = JSON.parse(line) as Record<string, unknown>;
  } catch {
    out({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
    return;
  }
  switch (cmd.type) {
    case 'get_state':
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { id: 'fake-chat', provider: 'fake' },
          thinkingLevel: 'off',
          sessionFile,
          sessionId,
          messageCount: history().length,
        },
      });
      return;
    case 'prompt': {
      const text = String(cmd.message ?? '');
      open = cmd.id as string;
      out({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_start' });
      out({ type: 'turn_start' });
      if (/count from 1|every integer|essay/i.test(text)) {
        timer = setInterval(() => {
          out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '1 ' } });
        }, 50);
        return;
      }
      const h = history();
      const r = reply(text, [...h, { role: 'user', content: text }]);
      append({ role: 'user', content: text });
      append({ role: 'assistant', content: r });
      setTimeout(() => settle(r, 'stop'), 20);
      return;
    }
    case 'abort':
      if (timer) clearInterval(timer);
      timer = null;
      if (open) settle('1 ', 'aborted');
      out({ id: cmd.id, type: 'response', command: 'abort', success: true });
      return;
    default:
      out({ id: cmd.id, type: 'response', command: String(cmd.type), success: false, error: `Unknown command: ${cmd.type}` });
  }
});
rl.on('close', () => process.exit(0));
