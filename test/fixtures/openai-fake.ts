/**
 * Local fake of the OpenAI endpoints the codex harness uses (Bun.serve, loopback):
 *   POST /v1/responses              SSE Responses stream, scripted by the last user text
 *   GET  /v1/models                 model listing (Sign in with ChatGPT shape by default)
 *   POST /api/accounts/oauth/token  OAuth refresh (rotates the refresh token)
 * The harness reaches it through ORC_CODEX_TEST_ENDPOINT (src/codex/endpoint.ts), so the
 * request shaping is the production one. Every request is recorded.
 *
 * Responses scripting — markers in the LAST user message:
 *   FAKE:SLOW          stream starts, then stays open (deltas every 200 ms) until aborted
 *   FAKE:HTTP400       HTTP 400 invalid_request_error (not retried)
 *   FAKE:HTTP500       HTTP 500 (retried by the harness, then fails)
 *   FAKE:RECALL        reply lists every user text in the request input, joined by " | "
 *   FAKE:SCRIPT <json> steps: [{"tools":[{"name","args"}]} | {"text":"…"}]; the step is
 *                      chosen by how many tool outputs follow the last user message
 *   (anything else)    reply "ok"
 * After the last scripted tool step with no text step, the reply quotes the tool outputs.
 */
import { failedResponseSse, textReplySse, textStreamHead, toolCallsSse } from '../../src/codex/fake-responses.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ResponsesRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** Every user text in `input`, in order. */
  userTexts: string[];
  /** `function_call_output` outputs after the last user message. */
  toolOutputs: string[];
  /** input item kinds: role or type. */
  kinds: string[];
}

export interface FakeOpenAI {
  origin: string;
  requests: RecordedRequest[];
  responses: () => ResponsesRequest[];
  tokenRequests: () => URLSearchParams[];
  modelRequests: () => RecordedRequest[];
  /** Replace the /v1/models reply. */
  setModels(status: number, body: unknown): void;
  /** Make the next `failResponses` POST /v1/responses fail with this status (then normal). */
  failNext(status: number, n?: number): void;
  /** Number of FAKE:SLOW streams currently open. */
  openSlowStreams: () => number;
  stop(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
}

export function analyze(body: Record<string, unknown>, headers: Record<string, string>): ResponsesRequest {
  const input = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
  const userTexts: string[] = [];
  let lastUser = -1;
  input.forEach((item, i) => {
    if (item.role === 'user') {
      userTexts.push(textOf(item.content));
      lastUser = i;
    }
  });
  const toolOutputs = input
    .slice(lastUser + 1)
    .filter((i) => i.type === 'function_call_output')
    .map((i) => (typeof i.output === 'string' ? i.output : JSON.stringify(i.output)));
  const kinds = input.map((i) => String(i.role ?? i.type));
  return { body, headers, userTexts, toolOutputs, kinds };
}

const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

export function startFakeOpenAI(): FakeOpenAI {
  const requests: RecordedRequest[] = [];
  let modelsStatus = 200;
  let modelsBody: unknown = {
    models: [
      { slug: 'gpt-fake-1', display_name: 'Fake One', visibility: 'list' },
      { slug: 'gpt-fake-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-fake-2', display_name: 'Fake Two', visibility: 'list' },
    ],
  };
  let failStatus = 0;
  let failCount = 0;
  let slow = 0;
  let tokenSeq = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = Object.fromEntries(req.headers.entries());
      const raw = await req.text();
      let body: unknown = raw;
      if ((headers['content-type'] ?? '').includes('json')) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method: req.method, path: url.pathname, headers, body });

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json(modelsBody, { status: modelsStatus });
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/oauth/token') {
        tokenSeq++;
        return Response.json({
          access_token: `access-refreshed-${tokenSeq}`,
          refresh_token: `rt-rotated-${tokenSeq}`,
          id_token: 'id.token.x',
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          expires_in: 3600,
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses' && isRecord(body)) {
        if (failCount > 0) {
          failCount--;
          return Response.json({ error: { message: `fake forced ${failStatus}`, type: 'server_error' } }, { status: failStatus });
        }
        const r = analyze(body, headers);
        const last = r.userTexts.at(-1) ?? '';
        if (last.includes('FAKE:HTTP400')) {
          return Response.json(
            { error: { message: 'fake bad request: unsupported parameter', type: 'invalid_request_error', code: 'unsupported_parameter' } },
            { status: 400 },
          );
        }
        if (last.includes('FAKE:HTTP500')) {
          return Response.json(
            { error: { message: 'fake upstream exploded', type: 'server_error' } },
            { status: 500, headers: { 'retry-after-ms': '5' } },
          );
        }
        if (last.includes('FAKE:USAGE_LIMIT')) {
          return new Response(failedResponseSse('subscription_sharing_usage_limit_exceeded', 'usage limit reached'), { headers: sseHeaders });
        }
        if (last.includes('FAKE:SLOW') && r.toolOutputs.length === 0) {
          const head = textStreamHead();
          let timer: ReturnType<typeof setInterval> | undefined;
          slow++;
          let closed = false;
          const done = () => {
            if (closed) return;
            closed = true;
            slow--;
            clearInterval(timer);
          };
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode(head.chunk));
              let n = 0;
              timer = setInterval(() => {
                try {
                  const delta = { type: 'response.output_text.delta', item_id: head.msgId, output_index: 0, content_index: 0, delta: `tick${n++} `, sequence_number: 100 + n };
                  controller.enqueue(enc.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`));
                } catch {
                  done();
                }
              }, 200);
            },
            cancel() {
              done();
            },
          });
          req.signal.addEventListener('abort', done);
          return new Response(stream, { headers: sseHeaders });
        }
        if (last.includes('FAKE:RECALL')) {
          return new Response(textReplySse(`recall: ${r.userTexts.join(' | ')}`), { headers: sseHeaders });
        }
        const m = /FAKE:SCRIPT (\[.*\])\s*$/s.exec(last);
        if (m) {
          const steps = JSON.parse(m[1]!) as Array<{ tools?: Array<{ name: string; args: Record<string, unknown> }>; text?: string }>;
          let outputs = r.toolOutputs.length;
          for (const step of steps) {
            if (step.tools) {
              if (outputs <= 0) return new Response(toolCallsSse(step.tools), { headers: sseHeaders });
              outputs -= step.tools.length;
              continue;
            }
            if (outputs <= 0) return new Response(textReplySse(step.text ?? ''), { headers: sseHeaders });
          }
          return new Response(textReplySse(`tool outputs: ${r.toolOutputs.join(' || ')}`), { headers: sseHeaders });
        }
        return new Response(textReplySse('ok', { input: 21, output: 3, cached: 4 }), { headers: sseHeaders });
      }
      return new Response('not found', { status: 404 });
    },
  });

  const responses = () =>
    requests
      .filter((r) => r.method === 'POST' && r.path === '/v1/responses' && isRecord(r.body))
      .map((r) => analyze(r.body as Record<string, unknown>, r.headers));
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    responses,
    tokenRequests: () =>
      requests.filter((r) => r.path === '/api/accounts/oauth/token').map((r) => new URLSearchParams(String(r.body))),
    modelRequests: () => requests.filter((r) => r.path === '/v1/models'),
    setModels(status, body) {
      modelsStatus = status;
      modelsBody = body;
    },
    failNext(status, n = 1) {
      failStatus = status;
      failCount = n;
    },
    openSlowStreams: () => slow,
    stop() {
      server.stop(true);
    },
  };
}
