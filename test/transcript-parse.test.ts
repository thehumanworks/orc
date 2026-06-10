import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  conversationTurns,
  parseClaude,
  parseCodex,
  parsePi,
  parseTranscript,
  renderTurns,
  selectTurns,
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

  test('ignores non-object JSONL and malformed nested blocks', () => {
    const turns = parseClaude(
      [
        'null',
        '"string noise"',
        '[]',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              null,
              1,
              {},
              { type: 'text', text: '  ' },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', name: 'Read', input: null },
            ],
          },
        }),
      ].join('\n'),
    );
    expect(turns).toEqual([
      { role: 'assistant', text: 'ok' },
      { role: 'tool', text: 'Read' },
    ]);
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

  test('falls back to response_item message text without duplicating event text', () => {
    const fallbackOnly = parseCodex(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'fallback answer' }],
        },
      }),
    );
    expect(fallbackOnly).toEqual([{ role: 'assistant', text: 'fallback answer' }]);

    const normal = parseCodex(
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'same answer' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'same answer' }],
          },
        }),
      ].join('\n'),
    );
    expect(normal).toEqual([{ role: 'assistant', text: 'same answer' }]);
  });

  test('tolerates non-object tool arguments', () => {
    expect(() =>
      parseCodex(
        [
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'fn', arguments: 'null' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'fn', arguments: '[]' },
          }),
        ].join('\n'),
      ),
    ).not.toThrow();
    expect(
      parseCodex(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'local_shell_call',
            action: { command: ['bash', '-lc', 'echo hi'] },
          },
        }),
      ),
    ).toEqual([{ role: 'tool', text: 'local_shell_call: bash -lc echo hi' }]);
  });
});

describe('parsePi', () => {
  test('ignores non-object JSONL and malformed nested blocks', () => {
    expect(
      parsePi(
        [
          'null',
          JSON.stringify({
            role: 'assistant',
            content: [
              null,
              { type: 'text', text: 'hi' },
              { type: 'tool_use', name: 'Read', input: 'bad' },
            ],
          }),
        ].join('\n'),
      ),
    ).toEqual([
      { role: 'assistant', text: 'hi' },
      { role: 'tool', text: 'Read' },
    ]);
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

describe('conversation turn selection', () => {
  const turns: Turn[] = [
    { role: 'user', text: 'first' },
    { role: 'tool', text: 'Bash: echo first' },
    { role: 'assistant', text: 'first done' },
    { role: 'user', text: 'second' },
    { role: 'tool', text: 'Read src/x.ts' },
    { role: 'tool', text: 'Edit src/x.ts' },
    { role: 'assistant', text: 'second done' },
  ];

  test('groups by user turn boundaries', () => {
    expect(conversationTurns(turns)).toEqual([
      turns.slice(0, 3),
      turns.slice(3),
    ]);
  });

  test('selects latest, full, and zero-based index', () => {
    expect(selectTurns(turns)).toEqual(turns.slice(3));
    expect(selectTurns(turns, { mode: 'full' })).toEqual(turns);
    expect(selectTurns(turns, { mode: 'index', index: 0 })).toEqual(turns.slice(0, 3));
  });

  test('out-of-range index fails instead of selecting an empty fallback', () => {
    expect(() => selectTurns(turns, { mode: 'index', index: 99 })).toThrow(
      /turn index 99 out of range/,
    );
    expect(() => selectTurns([], { mode: 'index', index: 0 })).toThrow(
      /no parsed turns/,
    );
  });
});
