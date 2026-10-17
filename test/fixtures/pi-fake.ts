/**
 * Scripted fake `pi --mode rpc` for offline runtime tests (test/runtime-pi-fake.test.ts).
 * Speaks just enough of the pi 1.2.0 rpc wire (LF JSONL on stdio). Behaviour via FAKE_MODE:
 *
 *   slow       ack the prompt, stream deltas until `abort` → message_end(aborted),
 *              agent_settled{aborted:true}, abort response (default)
 *   hang       answer get_state, then ignore stdin EOF and SIGTERM (only SIGKILL ends it)
 *   mute       never answer get_state (boot timeout)
 *   race       on `abort` the run finishes NATURALLY first: settled{aborted:false}, then response
 *   noack      never answer a prompt (send() stays unacked) until stdin EOF
 *   dropabort  silently drop the FIRST abort, handle later ones like `slow`
 *   child      like `slow`, plus a long-lived child in pi's process group; its pid is written
 *              to $FAKE_CHILD_PID_FILE. pi exits on stdin EOF and leaves the child behind.
 *
 * Like pi: stdin EOF → exit 0 at once (an open run gets no settle); SIGTERM → default death.
 */
import readline from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'slow';
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const argv = process.argv.slice(2);
const sidIdx = argv.indexOf('--session-id');
const sessionId = sidIdx >= 0 ? argv[sidIdx + 1] : 'fake';

if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
if (mode === 'child') {
  const child = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  const pidFile = process.env.FAKE_CHILD_PID_FILE;
  if (pidFile) await Bun.write(pidFile, String(child.pid));
}

let open: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let abortsSeen = 0;

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
      if (mode === 'mute') return;
      out({
        id: cmd.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { id: 'fake-model', provider: 'fake' },
          thinkingLevel: 'off',
          sessionFile: `/nonexistent/${sessionId}.jsonl`,
          sessionId,
          messageCount: 0,
        },
      });
      return;
    case 'prompt':
      if (mode === 'noack') return;
      open = cmd.id as string;
      out({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      out({ type: 'agent_start' });
      out({ type: 'turn_start' });
      timer = setInterval(() => {
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x ' } });
      }, 50);
      return;
    case 'abort': {
      abortsSeen++;
      if (mode === 'dropabort' && abortsSeen === 1) return;
      if (timer) clearInterval(timer);
      timer = null;
      if (open) {
        const natural = mode === 'race';
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: natural ? 'done' : 'x ' }],
            stopReason: natural ? 'stop' : 'aborted',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          },
        });
        out({ type: 'turn_end' });
        out({ type: 'agent_end', messages: [], willRetry: false });
        out({ type: 'agent_settled', aborted: !natural });
        open = null;
      }
      out({ id: cmd.id, type: 'response', command: 'abort', success: true });
      return;
    }
    default:
      out({ id: cmd.id, type: 'response', command: String(cmd.type), success: false, error: `Unknown command: ${cmd.type}` });
  }
});
rl.on('close', () => {
  if (mode === 'hang') return;
  process.exit(0);
});
