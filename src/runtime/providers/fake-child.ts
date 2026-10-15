/**
 * The scripted fake provider process (see ./fake.ts for the protocol and script format).
 *
 *   bun fake-child.ts --orc-session <sid> --provider-session <id> --mode fresh|resume
 *   env ORC_FAKE_SCRIPT = JSON FakeScript
 *
 * One turn at a time; behaviour per turn is chosen by the first rule whose `match` is a
 * substring of the message text. Survives a broken stdout (EPIPE) once orphaned.
 */
import type { FakeBehaviour, FakeScript } from './fake.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let script: FakeScript = {};
try {
  script = JSON.parse(process.env.ORC_FAKE_SCRIPT || '{}') as FakeScript;
} catch {
  process.stderr.write('fake-child: invalid ORC_FAKE_SCRIPT\n');
  process.exit(2);
}

const providerSessionId = arg('--provider-session') ?? 'fake-unknown';
const mode = arg('--mode') === 'resume' ? 'resume' : 'fresh';

// Once the actor dies our stdout is a broken pipe: swallow EPIPE and keep running.
process.stdout.on('error', () => {});

function emit(ev: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify(ev)}\n`);
  } catch {
    /* orphaned */
  }
}

if (typeof script.exitAtStart === 'number') process.exit(script.exitAtStart);
if (typeof script.exitOnResume === 'number' && mode === 'resume') {
  process.stderr.write(`fake-child: no conversation found for ${providerSessionId}\n`);
  process.exit(script.exitOnResume);
}

interface Turn {
  messageId: string;
  timers: ReturnType<typeof setTimeout>[];
  ignoreInterrupt: boolean;
}
let turn: Turn | undefined;

function pick(text: string): FakeBehaviour {
  for (const r of script.rules ?? []) if (text.includes(r.match)) return r;
  return script.default ?? {};
}

function onSend(messageId: string, text: string): void {
  if (turn) {
    emit({ type: 'turn.failed', messageId, error: 'fake: a turn is already open' });
    return;
  }
  const b = pick(text);
  const t: Turn = { messageId, timers: [], ignoreInterrupt: b.ignoreInterrupt === true };
  turn = t;
  const schedule = (ms: number, fn: () => void) => {
    t.timers.push(
      setTimeout(() => {
        if (turn === t) fn();
      }, Math.max(0, ms)),
    );
  };
  const delay = b.delayMs ?? 10;
  schedule(b.ackDelayMs ?? 0, () => {
    emit({ type: 'turn.started', messageId });
    switch (b.action ?? 'reply') {
      case 'reply':
        schedule(delay, () => {
          const reply = b.text ?? `echo: ${text}`;
          emit({ type: 'assistant.text', messageId, text: reply });
          turn = undefined;
          emit({
            type: 'turn.completed',
            messageId,
            result: reply,
            usage: { inputTokens: text.length, outputTokens: reply.length },
            costUsd: 0,
          });
        });
        break;
      case 'fail':
        schedule(delay, () => {
          turn = undefined;
          emit({ type: 'turn.failed', messageId, error: b.error ?? 'fake failure' });
        });
        break;
      case 'permission':
        schedule(delay, () =>
          emit({
            type: 'permission.requested',
            messageId,
            detail: b.detail ?? { tool: 'Bash', input: { command: 'true' } },
          }),
        );
        break;
      case 'exit':
        schedule(delay, () => process.exit(b.exitCode ?? 1));
        break;
      case 'crash':
        schedule(delay, () => process.kill(process.pid, 'SIGKILL'));
        break;
      case 'hang':
        break;
    }
  });
}

function onInterrupt(): void {
  const t = turn;
  if (t && !t.ignoreInterrupt) {
    for (const x of t.timers) clearTimeout(x);
    turn = undefined;
    emit({ type: 'turn.interrupted', messageId: t.messageId });
  }
  emit({ type: 'interrupt.acked' });
}

function onLine(line: string): void {
  if (line.trim().length === 0) return;
  let cmd: { op?: string; messageId?: string; text?: string };
  try {
    cmd = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-child: bad command line: ${line}\n`);
    return;
  }
  if (cmd.op === 'send' && typeof cmd.messageId === 'string') onSend(cmd.messageId, cmd.text ?? '');
  else if (cmd.op === 'interrupt') onInterrupt();
}

let buf = '';
process.stdin.on('data', (chunk: Buffer | string) => {
  buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    onLine(line);
  }
});
process.stdin.on('end', () => {
  const linger = script.ignoreStdinEofMs;
  if (typeof linger === 'number' && linger > 0) setTimeout(() => process.exit(0), linger);
  else process.exit(0);
});

setTimeout(
  () =>
    emit({
      type: 'ready',
      providerSessionId,
      capabilities: ['interrupt'],
      info: {
        fake: true,
        mode,
        pid: process.pid,
        ...(script.reportEnv
          ? { env: Object.fromEntries(script.reportEnv.filter((k) => k in process.env).map((k) => [k, process.env[k]])) }
          : {}),
      },
    }),
  Math.max(0, script.readyDelayMs ?? 0),
);
