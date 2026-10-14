/**
 * Stub OpenAI Responses API (SSE) for codex runtime contract tests: lets the REAL
 * `codex app-server` run turns with no credentials. A temp CODEX_HOME's config.toml
 * selects it as a custom model provider (retries disabled so failures are immediate).
 *
 * Behaviour is chosen from the LAST user message of each request:
 *   STUB:SLOW    response.created, then the stream stays open until the client aborts
 *   STUB:FAIL    HTTP 400 with an error body (codex: turn/completed status "failed")
 *   STUB:MULTI   two assistant message items in one response ("first part", "final part")
 *   STUB:RECALL  replies with the text of the first assistant message in the history
 *   "exactly one word: X"  replies X
 *   anything else          replies "ok"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StubRequest {
  body: Record<string, unknown>;
  /** Text of the last user message (the prompt). */
  prompt: string;
  /** input_text parts of every developer-role message, in order. */
  developerTexts: string[];
  /** Text of every assistant message in the input history. */
  assistantHistory: string[];
  /** Text of every user message in the input history (incl. codex's environment context). */
  userHistory: string[];
}

export interface CodexStub {
  port: number;
  requests: StubRequest[];
  stop(): void;
}

const enc = new TextEncoder();
const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const usage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 14,
};

function created(n: number): string {
  return ev('response.created', {
    type: 'response.created',
    response: { id: `resp_${n}`, object: 'response', created_at: 0, status: 'in_progress', model: 'gpt-fake', output: [] },
  });
}

function messageItem(id: string, text: string, index: number): string {
  return [
    ev('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: index,
      item: { type: 'message', id, status: 'in_progress', role: 'assistant', content: [] },
    }),
    ev('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: id,
      output_index: index,
      content_index: 0,
      delta: text,
    }),
    ev('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: index,
      item: {
        type: 'message',
        id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }),
  ].join('');
}

function completed(n: number): string {
  return ev('response.completed', {
    type: 'response.completed',
    response: { id: `resp_${n}`, object: 'response', created_at: 0, status: 'completed', model: 'gpt-fake', output: [], usage },
  });
}

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : null))
    .filter((t): t is string => t !== null);
}

function parseRequest(body: Record<string, unknown>): StubRequest {
  const input = (Array.isArray(body.input) ? body.input : []) as Array<{ role?: string; type?: string; content?: unknown }>;
  const developerTexts: string[] = [];
  const assistantHistory: string[] = [];
  const userHistory: string[] = [];
  for (const it of input) {
    if (it.type !== undefined && it.type !== 'message') continue;
    const texts = textsOf(it.content);
    if (it.role === 'developer' || it.role === 'system') developerTexts.push(...texts);
    else if (it.role === 'assistant') assistantHistory.push(texts.join(''));
    else if (it.role === 'user') userHistory.push(texts.join(''));
  }
  return { body, prompt: userHistory.at(-1) ?? '', developerTexts, assistantHistory, userHistory };
}

export function startCodexStub(): CodexStub {
  let n = 0;
  const stub: CodexStub = {
    port: 0,
    requests: [],
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0, // SLOW streams must stay open until codex aborts them
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) {
        return Response.json({ models: [] });
      }
      const body = (await req.json()) as Record<string, unknown>;
      const r = parseRequest(body);
      stub.requests.push(r);
      const k = ++n;
      const sse = { 'content-type': 'text/event-stream' };
      if (r.prompt.includes('STUB:FAIL')) {
        return Response.json(
          { error: { message: 'stub-forced failure', type: 'invalid_request_error', code: 'stub' } },
          { status: 400 },
        );
      }
      if (r.prompt.includes('STUB:SLOW')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(created(k)));
          },
        });
        return new Response(stream, { headers: sse });
      }
      let body1: string;
      if (r.prompt.includes('STUB:MULTI')) {
        body1 = messageItem(`msg_${k}_a`, 'first part', 0) + messageItem(`msg_${k}_b`, 'final part', 1);
      } else if (r.prompt.includes('STUB:RECALL')) {
        body1 = messageItem(`msg_${k}`, r.assistantHistory[0] ?? 'none', 0);
      } else {
        const word = /exactly one word:\s*(\S+)/i.exec(r.prompt)?.[1] ?? 'ok';
        body1 = messageItem(`msg_${k}`, word, 0);
      }
      return new Response(created(k) + body1 + completed(k), { headers: sse });
    },
  });
  stub.port = server.port ?? 0;
  return stub;
}

/** A fresh temp CODEX_HOME whose config routes codex to the stub (never touches ~/.codex). */
export function makeStubCodexHome(port: number): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-home-'));
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    [
      'model = "gpt-fake"',
      'model_provider = "orcfake"',
      '',
      '[model_providers.orcfake]',
      'name = "orc stub responses"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
    ].join('\n'),
  );
  return home;
}
