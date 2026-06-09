import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseClaude,
  parseCodex,
  parseTranscript,
  renderTurns,
} from '../src/transcript.ts';
import type { Turn } from '../src/transcript.ts';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(import.meta.dir, 'fixtures', name), 'utf8');

describe('parseClaude', () => {
  const turns = parseClaude(fixture('claude-transcript.jsonl'));

  test('normalizes user/assistant turns and tool summaries in order', () => {
    expect(turns).toEqual([
      { role: 'user', text: 'hello, please help' },
      { role: 'assistant', text: "Sure, I'll run a command." },
      { role: 'tool', text: 'Bash: echo hi' },
      { role: 'tool', text: 'Edit src/x.ts' },
      { role: 'assistant', text: 'All done.' },
    ] satisfies Turn[]);
  });

  test('drops tool_result output, thinking, system, and sidechain turns', () => {
    const texts = turns.map((t) => t.text).join('\n');
    expect(texts).not.toContain('TOOL_RESULT_BODY_DROPME'); // tool_result content
    expect(texts).not.toContain('private chain of thought'); // thinking
    expect(texts).not.toContain('system bookkeeping noise'); // type:system
    expect(texts).not.toContain('subagent turn'); // isSidechain
  });

  test('tolerates a truncated trailing line', () => {
    // The fixture's last line is half-written; parsing must not throw and must not
    // emit a turn for it.
    expect(turns.every((t) => !t.text.includes('truncated half-written'))).toBe(true);
  });
});

describe('parseCodex', () => {
  const turns = parseCodex(fixture('codex-transcript.jsonl'));

  test('takes text from event_msg and tool calls from response_item', () => {
    expect(turns).toEqual([
      { role: 'user', text: 'run echo HELLO_DOGFOOD' },
      { role: 'tool', text: 'exec_command: echo HELLO_DOGFOOD' },
      { role: 'tool', text: 'shell: bash -lc ls -la' },
      { role: 'assistant', text: 'Done — it printed HELLO_DOGFOOD.' },
    ] satisfies Turn[]);
  });

  test('does not duplicate assistant text from response_item message', () => {
    const assistantTurns = turns.filter((t) => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
  });

  test('drops session_meta/turn_context/token_count/*_output/reasoning', () => {
    const texts = turns.map((t) => t.text).join('\n');
    expect(texts).not.toContain('gpt-5.5'); // turn_context
    expect(texts).not.toContain('FUNCTION_CALL_OUTPUT_DROPME'); // function_call_output
  });
});

describe('tool-call summaries', () => {
  test('Bash uses the command; file tools use the path', () => {
    const turns = parseClaude(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: 'src/y.ts' } },
              { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            ],
          },
        }),
      ].join('\n'),
    );
    expect(turns).toEqual([
      { role: 'tool', text: 'Read src/y.ts' },
      { role: 'tool', text: 'Bash: git status' },
    ]);
  });

  test('long command hints are collapsed to one line and truncated', () => {
    const long = `echo ${'x'.repeat(200)}`;
    const turns = parseClaude(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }] },
      }),
    );
    const summary = turns[0]!.text;
    expect(summary.startsWith('Bash: echo ')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual('Bash: '.length + 60);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('parseTranscript dispatch + renderTurns', () => {
  test('dispatches by provider', () => {
    expect(parseTranscript('claude', fixture('claude-transcript.jsonl'))).toEqual(
      parseClaude(fixture('claude-transcript.jsonl')),
    );
    expect(parseTranscript('codex', fixture('codex-transcript.jsonl'))).toEqual(
      parseCodex(fixture('codex-transcript.jsonl')),
    );
  });

  test('renders compact text with indented tool lines', () => {
    const rendered = renderTurns([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'ok' },
      { role: 'tool', text: 'Bash: echo hi' },
    ]);
    expect(rendered).toBe('<user> hi\n<assistant> ok\n  [Bash: echo hi]');
  });
});
