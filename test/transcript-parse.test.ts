import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  conversationTurns,
  parseClaude,
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

/** A historical Codex harness session file (Pi session JSONL v3). */
const HARNESS_SESSION = [
  { type: 'session', version: 3, id: 'sid-1', timestamp: '2026-10-15T10:00:00.000Z', cwd: '/w' },
  { type: 'model_change', id: 'a0000001', parentId: null, timestamp: '2026-10-15T10:00:00.000Z', provider: 'openai', modelId: 'gpt-5.5' },
  { type: 'message', id: 'a0000002', parentId: 'a0000001', timestamp: 't', message: { role: 'system', content: 'SYSTEM PROMPT DROPME', timestamp: 0 } },
  { type: 'message', id: 'a0000003', parentId: 'a0000002', timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }], timestamp: 1 } },
  {
    type: 'message',
    id: 'a0000004',
    parentId: 'a0000003',
    timestamp: 't',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'THINKING DROPME' },
        { type: 'text', text: 'Running them.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'bun test' } },
        { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: 'src/a.ts', edits: [] } },
      ],
      stopReason: 'toolUse',
    },
  },
  { type: 'message', id: 'a0000005', parentId: 'a0000004', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'TOOL OUTPUT DROPME' }], isError: false } },
  { type: 'message', id: 'a0000006', parentId: 'a0000005', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'All green.' }], stopReason: 'stop' } },
].map((l) => JSON.stringify(l)).join('\n');

describe('parsePi', () => {
  test('codex harness session file: text + toolCall summaries; system/thinking/toolResult dropped', () => {
    expect(parsePi(HARNESS_SESSION)).toEqual([
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'Running them.' },
      { role: 'tool', text: 'bash: bun test' },
      { role: 'tool', text: 'edit src/a.ts' },
      { role: 'assistant', text: 'All green.' },
    ] satisfies Turn[]);
  });

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
    // Historical Codex harness sessions use Pi's format and remain readable.
    expect(parseTranscript('codex', HARNESS_SESSION)).toEqual(parsePi(HARNESS_SESSION));
    expect(parseTranscript('pi', HARNESS_SESSION)).toEqual(parsePi(HARNESS_SESSION));
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
