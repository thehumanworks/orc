/**
 * Scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`
 * (shapes as observed from claude 2.1.299), used by test/claude-runtime-io.test.ts to
 * exercise the runtime's I/O offline. Behaviour is chosen by the user text:
 *   contains HANG        → stream nothing until interrupted (EOF does not end it)
 *   contains PERM        → ask can_use_tool over stdio, wait for the answer, then reply
 *   contains SPAWN_CHILD → leave a `sleep` child in our process group, then reply
 *   otherwise            → reply `echo: <text>` and a success result
 * `--resume 00000000-…` → "No conversation found" (stderr + error result), exit 1.
 * FAKE_CLAUDE_RECORD=<file> → writes {argv, env (CLAUDE_CODE_* / ORC_* keys)} there.
 * FAKE_CLAUDE_REPLY_DELAY_MS=<n> → a normal reply arrives after n ms (default: at once).
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sid = flag('--session-id') ?? flag('--resume') ?? 'unknown';
const resume = argv.includes('--resume');

if (process.env.FAKE_CLAUDE_RECORD) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (k.startsWith('CLAUDE_CODE_') || k.startsWith('ORC_'))) env[k] = v;
  }
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, env }));
}

const out = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

if (resume && sid.startsWith('00000000')) {
  process.stderr.write(`No conversation found with session ID: ${sid}\n`);
  out({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    total_cost_usd: 0,
    errors: [`No conversation found with session ID: ${sid}`],
    session_id: sid,
  });
  process.exit(1);
}

let total = resume ? 0.5 : 0; // a resumed process's first total includes saved spend
let initSent = false;
let hanging = null as string | null;
let waitingPerm = null as { uuid: string; reqId: string } | null;
let n = 0;

function result(uuid: string, text: string): void {
  total += 0.001;
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, user_message_uuid: uuid, session_id: sid });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    result: text,
    total_cost_usd: total,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 },
    user_message_uuid: uuid,
    session_id: sid,
  });
  out({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
}

function onUser(o: { uuid: string; message: { content: Array<{ type: string; text: string }> } }): void {
  const text = o.message.content.map((b) => b.text).join('');
  const uuid = o.uuid;
  out({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' });
  out({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  if (!initSent) {
    initSent = true;
    out({
      type: 'system',
      subtype: 'init',
      session_id: sid,
      model: 'fake-model',
      apiKeySource: 'none',
      claude_code_version: '2.1.299',
      permissionMode: 'bypassPermissions',
      agents: ['general-purpose'],
      skills: ['a', 'b'],
      capabilities: ['interrupt_receipt_v1'],
    });
  }
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'user', message: o.message, parent_tool_use_id: null, uuid, isReplay: true });
  if (text.includes('HANG')) {
    hanging = uuid;
    return;
  }
  if (text.includes('PERM')) {
    const reqId = `perm-${++n}`;
    waitingPerm = { uuid, reqId };
    out({ type: 'control_request', request_id: reqId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } } });
    return;
  }
  if (text.includes('SPAWN_CHILD')) {
    Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
  }
  const delay = Number(process.env.FAKE_CLAUDE_REPLY_DELAY_MS ?? 0);
  if (delay > 0) setTimeout(() => result(uuid, `echo: ${text}`), delay);
  else result(uuid, `echo: ${text}`);
}

let buf = '';
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.type === 'control_request' && o.request?.subtype === 'initialize') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: o.request_id,
          response: {
            pid: process.pid,
            claude_code_version: '2.1.299',
            session_state: 'idle',
            current_permission_mode: 'bypassPermissions',
            capabilities: ['ui_surface_v1'],
            account: { email: 'secret@example.com' },
          },
        },
      });
    } else if (o.type === 'control_request' && o.request?.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { still_queued: [] } } });
      if (hanging) {
        const uuid = hanging;
        hanging = null;
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', total_cost_usd: total, errors: ['[ede_diagnostic]'], user_message_uuid: uuid });
        out({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' });
      }
    } else if (o.type === 'control_response' && waitingPerm && o.response?.request_id === waitingPerm.reqId) {
      const { uuid } = waitingPerm;
      waitingPerm = null;
      out(o); // the real CLI echoes the answer back
      result(uuid, `perm answer: ${o.response.response.behavior}`);
    } else if (o.type === 'user') {
      onUser(o);
    }
  }
}
// EOF: like claude, finish nothing that is hanging (a HANG turn keeps us alive until killed).
if (hanging) setInterval(() => {}, 1_000);
else process.exit(0);
