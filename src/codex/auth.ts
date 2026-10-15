/**
 * Credentials for the codex harness (OpenAI Responses API).
 *
 * Resolution order (first hit wins; decided per request, so a later `orc login chatgpt`
 * takes over without restarting anything):
 *   1. orc's own Sign in with ChatGPT credential: `$ORC_HOME/auth/chatgpt.json`
 *      (`{"openai": <oauth credential>}`, 0600, written atomically under the orc lock
 *      `auth-chatgpt`). Created by `orc login chatgpt`.
 *   2. pi's existing ChatGPT login: `auth.json` in pi's agent dir (`$PI_CODING_AGENT_DIR`,
 *      else `~/.pi/agent`), entry `openai` of type `oauth`. Used only when (1) is absent.
 *   3. `OPENAI_API_KEY` (plain API-key Responses API; resolved by pi-ai's ambient env auth).
 *   4. Otherwise: CodexAuthError ("run `orc login chatgpt` or set OPENAI_API_KEY").
 *
 * A refreshed OAuth credential is written back to the SAME store it was read from (refresh
 * tokens may rotate: forking pi's credential into orc's file would strand one copy).
 * pi's file is written under pi's own lock convention: pi 1.2.0 `FileAuthStorageBackend`
 * locks `auth.json` with proper-lockfile 4.1.2 (`realpath:false`), i.e. an atomic
 * `mkdir("<auth.json>.lock")` whose mtime the holder keeps fresh, a lock older than the
 * stale window (30 s for pi's async path) is reclaimed, and the file is rewritten IN PLACE
 * (`writeFileSync`, mode 0600 only on creation) with every other provider entry preserved.
 * `PiAuthFileStore` reproduces exactly that protocol (see PI_LOCK_* below), so orc and a
 * running pi exclude each other.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { orcHome } from '../paths.ts';
import { withLock } from '../lock.ts';
import { ensurePrivateDir } from '../private-fs.ts';
import { writeFileAtomic } from '../runtime/fsutil.ts';

/** pi-ai provider id of the OpenAI provider (Responses API + Sign in with ChatGPT). */
export const OPENAI_PROVIDER_ID = 'openai';

/** Where the harness credential came from. */
export type CodexAuthSource = 'orc' | 'pi' | 'env';

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

export const NO_CREDENTIAL_MESSAGE =
  'codex: no OpenAI credential — run `orc login chatgpt` (Sign in with ChatGPT) or set OPENAI_API_KEY';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------

/** `$ORC_HOME/auth` (0700). */
export function orcAuthDir(): string {
  return path.join(orcHome(), 'auth');
}

/** orc's own ChatGPT credential file. */
export function orcChatGPTAuthPath(): string {
  return path.join(orcAuthDir(), 'chatgpt.json');
}

/** Persistent per-installation device id for Sign in with ChatGPT (`ext_agent_host_id`). */
export function orcDeviceIdPath(): string {
  return path.join(orcAuthDir(), 'device-id');
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** pi's agent dir, resolved exactly like pi 1.2.0 `getAgentDir()`. */
export function piAgentDir(env: Env = process.env): string {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir();
  const override = env.PI_CODING_AGENT_DIR;
  if (override && override.length > 0) return path.resolve(expandTilde(override, home));
  return path.join(home, '.pi', 'agent');
}

/** pi's credential file (`<agentDir>/auth.json`). */
export function piAuthPath(env: Env = process.env): string {
  return path.join(piAgentDir(env), 'auth.json');
}

/** The device id (UUID), generated once and persisted 0600 under `$ORC_HOME/auth`. */
export function orcDeviceId(): string {
  const p = orcDeviceIdPath();
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
  } catch {
    // missing → create
  }
  ensurePrivateDir(orcAuthDir());
  const id = randomUUID();
  writeFileAtomic(p, `${id}\n`, { mode: 0o600, fsync: true });
  return id;
}

// ---------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A usable stored OAuth credential (the shape pi-ai's OAuth resolution expects). */
export function isOAuthCredential(v: unknown): v is OAuthCredential {
  return (
    isRecord(v) &&
    v.type === 'oauth' &&
    typeof v.access === 'string' &&
    typeof v.refresh === 'string' &&
    typeof v.expires === 'number' &&
    Number.isFinite(v.expires)
  );
}

function parseAuthJson(text: string, file: string): Record<string, unknown> {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`invalid ${file}: expected a JSON object`);
  return parsed;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// orc store
// ---------------------------------------------------------------------------------

/** `$ORC_HOME/auth/chatgpt.json`: `{"openai": <credential>}`, atomic writes under an orc lock. */
export class OrcChatGPTStore implements CredentialStore {
  readonly path: string;

  constructor(file: string = orcChatGPTAuthPath()) {
    this.path = file;
  }

  private load(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return {};
      throw e;
    }
    return parseAuthJson(text, this.path);
  }

  private save(data: Record<string, unknown>): void {
    ensurePrivateDir(path.dirname(this.path));
    if (Object.keys(data).length === 0) {
      fs.rmSync(this.path, { force: true });
      return;
    }
    writeFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, fsync: true });
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const v = this.load()[providerId];
    return isOAuthCredential(v) || (isRecord(v) && v.type === 'api_key') ? (structuredClone(v) as Credential) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.load())
      .filter(([, v]) => isRecord(v) && (v.type === 'oauth' || v.type === 'api_key'))
      .map(([providerId, v]) => ({ providerId, type: (v as { type: Credential['type'] }).type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return withLock(
      'auth-chatgpt',
      async () => {
        const data = this.load();
        const raw = data[providerId];
        const current =
          isOAuthCredential(raw) || (isRecord(raw) && raw.type === 'api_key') ? (structuredClone(raw) as Credential) : undefined;
        const next = await fn(current);
        if (next === undefined) return current;
        this.save({ ...data, [providerId]: next });
        return next;
      },
      { timeoutMs: 60_000 },
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await withLock('auth-chatgpt', async () => {
      const data = this.load();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.save(data);
    });
  }
}

// ---------------------------------------------------------------------------------
// pi store (pi's auth.json, pi's lock convention)
// ---------------------------------------------------------------------------------

/** pi's async lock window (FileAuthStorageBackend.acquireLockAsync `staleMs`). */
export const PI_LOCK_STALE_MS = 30_000;
/**
 * How often the holder refreshes the lock dir mtime. proper-lockfile refreshes at stale/2;
 * pi's synchronous path uses the default 10 s stale window, so stay well under 5 s.
 */
export const PI_LOCK_UPDATE_MS = 2_000;
/** Give up waiting for another holder after this long (pi waits the same 30 s). */
export const PI_LOCK_WAIT_MS = 30_000;

/**
 * Acquire pi's `auth.json` lock: proper-lockfile 4.1.2 semantics with pi's options
 * (`realpath:false`, `stale:30000`, retried with capped exponential backoff for up to
 * 30 s). Returns the release function.
 */
export async function acquirePiAuthLock(authPath: string, signal?: AbortSignal): Promise<() => void> {
  const lockPath = `${path.resolve(authPath)}.lock`;
  const deadline = Date.now() + PI_LOCK_WAIT_MS;
  let retry = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
    }
    // Held: reclaim it when stale (mtime older than the window), else back off.
    let stale = false;
    try {
      stale = fs.statSync(lockPath).mtimeMs < Date.now() - PI_LOCK_STALE_MS;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') continue; // released meanwhile
      throw e;
    }
    if (stale) {
      try {
        fs.rmdirSync(lockPath);
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') throw e;
      }
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error(`pi auth lock is held by another process: ${lockPath}`), { code: 'ELOCKED' });
    }
    const base = Math.min(10 * 2 ** retry, 1_000);
    retry++;
    await sleep(Math.min(Math.round(base * (1 + Math.random())), remaining));
  }
  const touch = () => {
    const now = new Date();
    try {
      fs.utimesSync(lockPath, now, now);
    } catch {
      // removed under us: detected before the write (assertHeld)
    }
  };
  touch();
  const timer = setInterval(touch, PI_LOCK_UPDATE_MS);
  timer.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // already gone
    }
  };
}

/**
 * pi's `auth.json` as a CredentialStore. Exposes only the OpenAI ChatGPT OAuth entry
 * (api-key entries may hold `!command` values that pi resolves itself). Writes happen
 * only under pi's lock and only when the file already exists — orc never creates pi's
 * credential file.
 */
export class PiAuthFileStore implements CredentialStore {
  readonly path: string;

  constructor(file: string) {
    this.path = file;
  }

  /** Unlocked read (as pi's ReadOnlyAuthStorage); retried briefly over a torn in-place write. */
  private async load(): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = fs.readFileSync(this.path, 'utf8');
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return {};
        throw e;
      }
      try {
        return parseAuthJson(text, this.path);
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(25);
      }
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== OPENAI_PROVIDER_ID) return undefined;
    const v = (await this.load())[providerId];
    return isOAuthCredential(v) ? structuredClone(v) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const c = await this.read(OPENAI_PROVIDER_ID, options);
    return c ? [{ providerId: OPENAI_PROVIDER_ID, type: c.type }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_PROVIDER_ID) throw new Error(`pi auth store: refusing to modify '${providerId}'`);
    if (!fs.existsSync(this.path)) throw new Error(`pi auth store: ${this.path} does not exist`);
    const release = await acquirePiAuthLock(this.path, options?.signal);
    try {
      const data = parseAuthJson(fs.readFileSync(this.path, 'utf8'), this.path);
      const raw = data[providerId];
      const current = isOAuthCredential(raw) ? structuredClone(raw) : undefined;
      const next = await fn(current);
      if (next === undefined) return current;
      if (!fs.existsSync(`${path.resolve(this.path)}.lock`)) {
        throw new Error(`pi auth lock was lost while refreshing; ${this.path} left unchanged`);
      }
      // pi's write: in place, full document, other providers preserved, 0600 on creation.
      const merged = { ...data, [providerId]: next };
      fs.writeFileSync(this.path, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
      return next;
    } finally {
      release();
    }
  }

  async delete(): Promise<void> {
    throw new Error("orc does not log out of pi: run pi's own /logout");
  }
}

// ---------------------------------------------------------------------------------
// Chained store (orc → pi)
// ---------------------------------------------------------------------------------

/**
 * orc's store first, then pi's. Reads return the first store holding a credential;
 * writes go back to the store the current credential lives in (a refresh of pi's
 * credential is written to pi's file). A brand-new credential goes to orc's store.
 */
export class ChainedCredentialStore implements CredentialStore {
  constructor(
    readonly orc: CredentialStore,
    readonly pi: CredentialStore | undefined,
  ) {}

  /** Which store currently holds `providerId` (undefined: neither). */
  async sourceOf(providerId: string, options?: AuthOperationOptions): Promise<'orc' | 'pi' | undefined> {
    if (await this.orc.read(providerId, options)) return 'orc';
    if (this.pi && (await this.pi.read(providerId, options))) return 'pi';
    return undefined;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return (await this.orc.read(providerId, options)) ?? (await this.pi?.read(providerId, options));
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const seen = new Map<string, CredentialInfo>();
    for (const c of [...(await this.orc.list(options)), ...((await this.pi?.list(options)) ?? [])]) {
      if (!seen.has(c.providerId)) seen.set(c.providerId, c);
    }
    return [...seen.values()];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const source = await this.sourceOf(providerId, options);
    if (source === 'pi' && this.pi) return this.pi.modify(providerId, fn, options);
    return this.orc.modify(providerId, fn, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.orc.delete(providerId, options);
  }
}

// ---------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------

export interface CodexAuth {
  source: CodexAuthSource;
  /** Human label for ready.info / status (never a secret). */
  label: string;
  /** Pass to pi-ai `createModels({credentials})`. Empty for `env` (ambient OPENAI_API_KEY). */
  store: ChainedCredentialStore;
  /** Cache key for per-account data (model list); never a secret. */
  accountKey: string;
}

/** The chained store for this environment (orc store + pi's file). */
export function codexCredentialStore(env: Env = process.env): ChainedCredentialStore {
  return new ChainedCredentialStore(new OrcChatGPTStore(), new PiAuthFileStore(piAuthPath(env)));
}

/**
 * Decide which credential the harness uses now. Throws CodexAuthError when there is
 * none. Never returns or logs a secret.
 */
export async function resolveCodexAuth(env: Env = process.env): Promise<CodexAuth> {
  const store = codexCredentialStore(env);
  const orcCred = await store.orc.read(OPENAI_PROVIDER_ID);
  if (orcCred) {
    return {
      source: 'orc',
      label: `chatgpt (orc: ${orcChatGPTAuthPath()})`,
      store,
      accountKey: `orc:${oauthAccountKey(orcCred)}`,
    };
  }
  const piCred = await store.pi?.read(OPENAI_PROVIDER_ID);
  if (piCred) {
    return {
      source: 'pi',
      label: `chatgpt (pi: ${piAuthPath(env)})`,
      store,
      accountKey: `pi:${oauthAccountKey(piCred)}`,
    };
  }
  const key = env.OPENAI_API_KEY;
  if (key && key.length > 0) {
    return { source: 'env', label: 'api-key (OPENAI_API_KEY)', store, accountKey: `env:${shortHash(key)}` };
  }
  throw new CodexAuthError(NO_CREDENTIAL_MESSAGE);
}

/** A non-secret, stable identity for an OAuth credential: its issued client id (per login). */
function oauthAccountKey(c: Credential): string {
  const clientId = isRecord(c) && typeof (c as Record<string, unknown>).clientId === 'string'
    ? String((c as Record<string, unknown>).clientId)
    : '';
  return clientId.length > 0 ? `client:${shortHash(clientId)}` : `refresh:${shortHash(String((c as OAuthCredential).refresh ?? ''))}`;
}

function shortHash(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 16);
}

/** Non-secret summary of a stored OAuth credential for `orc login status`. */
export function describeOAuth(c: Credential | undefined): string {
  if (!c) return 'none';
  if (c.type !== 'oauth') return c.type;
  const left = c.expires - Date.now();
  const when = left > 0 ? `access token valid ~${Math.round(left / 60_000)} min (auto-refresh)` : 'access token expired (refresh on next use)';
  const scopes = Array.isArray((c as Record<string, unknown>).scopes) ? ((c as Record<string, unknown>).scopes as unknown[]) : [];
  const direct = scopes.includes('chatgpt.tokens.use.direct') ? '' : ' — missing scope chatgpt.tokens.use.direct';
  return `chatgpt oauth, ${when}${direct}`;
}
