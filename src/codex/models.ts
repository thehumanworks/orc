/**
 * Model selection for the codex harness.
 *
 * Order: `--model` (spec.model) → on resume, the model the session last used → the LIVE
 * default: the first model the active credential's model listing returns
 * (`GET https://api.openai.com/v1/models`). No hard-coded fallback: when the listing fails
 * or is empty the harness refuses to start and asks for `--model`.
 *
 * Listing shapes:
 *   - Sign in with ChatGPT: `{"models":[{"slug","display_name","visibility",…}]}` — entries
 *     with `visibility:"list"` (or no visibility), in the SERVER's order (OpenAI's SIWC
 *     guide: "preserves the server's ordering"; pass `slug` as `model`).
 *   - API key: `{"object":"list","data":[{"id","created",…}]}` — unordered and mixes
 *     embeddings/audio/image models, so it is narrowed to the chat models pi-ai's OpenAI
 *     catalog knows and ordered newest `created` first.
 * The list is cached per account for CODEX_MODEL_CACHE_TTL_MS under
 * `$ORC_HOME/cache/codex-models.json` (ids only, never credentials).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import { orcHome } from '../paths.ts';
import { ensurePrivateDir } from '../private-fs.ts';
import { writeFileAtomic } from '../runtime/fsutil.ts';
import { OPENAI_PROVIDER_ID } from './auth.ts';
import { OPENAI_API_BASE } from './endpoint.ts';

export const CODEX_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 20_000;

export type ModelSource = 'flag' | 'session' | 'live-default';

export function modelCachePath(): string {
  return path.join(orcHome(), 'cache', 'codex-models.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a `/v1/models` body into model ids, in listing order. `knownChat` narrows the
 * API-key shape (see the header).
 */
export function parseModelList(body: unknown, knownChat: ReadonlySet<string>): string[] {
  if (!isRecord(body)) throw new Error('model listing is not a JSON object');
  if (Array.isArray(body.models)) {
    const out: string[] = [];
    for (const m of body.models) {
      if (!isRecord(m)) continue;
      const id = typeof m.slug === 'string' ? m.slug : typeof m.id === 'string' ? m.id : undefined;
      if (!id) continue;
      if (m.visibility !== undefined && m.visibility !== 'list') continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
  if (Array.isArray(body.data)) {
    const rows = body.data
      .filter(isRecord)
      .filter((m) => typeof m.id === 'string' && knownChat.has(m.id as string))
      .map((m) => ({ id: m.id as string, created: typeof m.created === 'number' ? m.created : 0 }));
    rows.sort((a, b) => b.created - a.created);
    return [...new Set(rows.map((r) => r.id))];
  }
  throw new Error('model listing has neither "models" nor "data"');
}

interface CacheFile {
  [accountKey: string]: { ids: string[]; fetchedAt: number };
}

function readCache(): CacheFile {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(modelCachePath(), 'utf8'));
    return isRecord(v) ? (v as CacheFile) : {};
  } catch {
    return {};
  }
}

function writeCache(c: CacheFile): void {
  try {
    ensurePrivateDir(path.dirname(modelCachePath()));
    writeFileAtomic(modelCachePath(), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // cache only
  }
}

export interface ListModelsOptions {
  models: Models;
  accountKey: string;
  fetch?: typeof fetch;
  /** Bypass the cache. */
  force?: boolean;
  now?: number;
}

/** The live model ids for the active credential (cached briefly). Throws on failure. */
export async function listLiveModels(o: ListModelsOptions): Promise<{ ids: string[]; cached: boolean }> {
  const now = o.now ?? Date.now();
  const cache = readCache();
  const hit = cache[o.accountKey];
  if (!o.force && hit && Array.isArray(hit.ids) && hit.ids.length > 0 && now - hit.fetchedAt < CODEX_MODEL_CACHE_TTL_MS) {
    return { ids: hit.ids, cached: true };
  }
  const auth = await o.models.getAuth(OPENAI_PROVIDER_ID);
  const bearer = auth?.auth.apiKey;
  if (!bearer) throw new Error('no usable OpenAI credential to list models with');
  const f = o.fetch ?? fetch;
  const res = await f(`${OPENAI_API_BASE}/models`, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`GET /v1/models → HTTP ${res.status}${body ? `: ${body}` : ''}`);
  }
  const knownChat = new Set(o.models.getModels(OPENAI_PROVIDER_ID).map((m) => m.id));
  const ids = parseModelList(await res.json(), knownChat);
  if (ids.length === 0) throw new Error('the model listing is empty for this account');
  // Prune other accounts' expired entries while writing ours.
  const next: CacheFile = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k !== o.accountKey && isRecord(v) && now - (v.fetchedAt as number) < CODEX_MODEL_CACHE_TTL_MS) next[k] = v;
  }
  next[o.accountKey] = { ids, fetchedAt: now };
  writeCache(next);
  return { ids, cached: false };
}

/**
 * The pi-ai Model for `id`: the catalog entry when pi-ai knows it, else a conservative
 * synthetic OpenAI Responses model (reasoning on; no cost data, so no costUsd).
 */
export function buildModel(models: Models, id: string): { model: Model<Api>; known: boolean } {
  const known = models.getModel(OPENAI_PROVIDER_ID, id);
  if (known) return { model: known, known: true };
  const model: Model<'openai-responses'> = {
    id,
    name: id,
    api: 'openai-responses',
    provider: OPENAI_PROVIDER_ID,
    baseUrl: OPENAI_API_BASE,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    type: 'chat',
  } as Model<'openai-responses'>;
  return { model: model as Model<Api>, known: false };
}

export interface ResolveModelOptions {
  specModel?: string;
  sessionModel?: string;
  list: () => Promise<{ ids: string[]; cached: boolean }>;
  authLabel: string;
}

/** Pick the model id per the order in the header. Throws a --model hint when it cannot. */
export async function resolveModelId(o: ResolveModelOptions): Promise<{ id: string; source: ModelSource; cached?: boolean }> {
  if (o.specModel && o.specModel.trim().length > 0) return { id: o.specModel.trim(), source: 'flag' };
  if (o.sessionModel) return { id: o.sessionModel, source: 'session' };
  let listed: { ids: string[]; cached: boolean };
  try {
    listed = await o.list();
  } catch (e) {
    throw new Error(
      `codex: no --model given and the live model list for ${o.authLabel} is unavailable (${(e as Error).message}); ` +
        'pass --model <id>',
    );
  }
  return { id: listed.ids[0]!, source: 'live-default', cached: listed.cached };
}
