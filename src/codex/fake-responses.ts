/**
 * Canned OpenAI Responses API server-sent-event streams, shaped like the real API (the
 * subset pi-ai's `openai-responses` stream processor consumes). Used by the compiled
 * binary's offline self-test (`orc __codex-harness --self-test`) and the test suite's fake
 * Responses server — never by a real session.
 */
export interface FakeUsage {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e, i) => `event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
}

function usageOf(u: FakeUsage): Record<string, unknown> {
  return {
    input_tokens: u.input,
    output_tokens: u.output,
    total_tokens: u.input + u.output,
    input_tokens_details: { cached_tokens: u.cached ?? 0 },
    output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
  };
}

let seq = 0;
const nextId = (p: string) => `${p}_${(++seq).toString(36)}`;

/** The opening events of a text reply (no completion): for slow / interrupted streams. */
export function textStreamHead(): { id: string; msgId: string; chunk: string } {
  const id = nextId('resp');
  const msgId = nextId('msg');
  return {
    id,
    msgId,
    chunk: sse([
      { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: msgId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ]),
  };
}

/** A complete assistant text reply. */
export function textReplySse(text: string, usage: FakeUsage = { input: 10, output: 2 }): string {
  const id = nextId('resp');
  const msgId = nextId('msg');
  const done = { type: 'message', id: msgId, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [done], usage: usageOf(usage) } },
  ]);
}

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One or more function calls in a single response (the model then waits for results). */
export function toolCallsSse(calls: FakeToolCall[], usage: FakeUsage = { input: 10, output: 5 }): string {
  const id = nextId('resp');
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
  ];
  const items: Array<Record<string, unknown>> = [];
  calls.forEach((c, i) => {
    const fcId = nextId('fc');
    const callId = nextId('call');
    const args = JSON.stringify(c.args);
    const item = { type: 'function_call', id: fcId, call_id: callId, name: c.name, arguments: args, status: 'completed' };
    items.push(item);
    events.push(
      { type: 'response.output_item.added', output_index: i, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: fcId, output_index: i, delta: args },
      { type: 'response.function_call_arguments.done', item_id: fcId, output_index: i, arguments: args },
      { type: 'response.output_item.done', output_index: i, item },
    );
  });
  events.push({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: items, usage: usageOf(usage) } });
  return sse(events);
}

/** A `response.failed` stream (e.g. a plan usage limit reported after streaming started). */
export function failedResponseSse(code: string, message: string): string {
  const id = nextId('resp');
  return sse([
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.failed', response: { id, object: 'response', status: 'failed', output: [], error: { code, message } } },
  ]);
}
