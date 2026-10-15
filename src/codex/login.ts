/**
 * `orc login chatgpt` / `orc login status` / `orc logout chatgpt` — Sign in with ChatGPT
 * for the codex harness, stored in orc's own credential file ($ORC_HOME/auth/chatgpt.json).
 *
 * Login is a foreground flow (pi-ai's `openai-chatgpt` OAuth): it prints the authorize URL
 * (and opens it with `open`/`xdg-open` when available), listens on
 * http://127.0.0.1:1455/auth/callback for the browser redirect, and also accepts the final
 * redirect URL pasted on stdin (for a browser on another machine). The installation is
 * identified by a device id generated once and kept 0600 in $ORC_HOME/auth/device-id.
 *
 * `--import-pi` copies pi's existing ChatGPT credential into orc's store instead of
 * logging in (the two copies then refresh independently; if OpenAI rotates refresh tokens,
 * the one refreshed second may need a new login).
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { createModels, type AuthEvent, type AuthInteraction, type AuthPrompt, type Credential } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import {
  OPENAI_PROVIDER_ID,
  OrcChatGPTStore,
  PiAuthFileStore,
  codexCredentialStore,
  describeOAuth,
  orcChatGPTAuthPath,
  orcDeviceId,
  piAuthPath,
  resolveCodexAuth,
} from './auth.ts';
import { installTestEndpoint, testEndpoint } from './endpoint.ts';
import { listLiveModels } from './models.ts';

/** Give up on an unfinished browser login after this long. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

type Out = (line: string) => void;

export interface LoginOptions {
  importPi?: boolean;
  /** Do not try to open a browser (always print the URL). */
  noBrowser?: boolean;
  env?: Record<string, string | undefined>;
  out?: Out;
  err?: Out;
}

function openBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const bin = Bun.which(cmd);
  if (!bin) return false;
  try {
    const p = Bun.spawn([bin, url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** A line-at-a-time stdin reader whose pending read rejects on abort. */
function stdinPrompter(): { ask: (p: AuthPrompt) => Promise<string>; close: () => void } {
  let rl: readline.Interface | null = null;
  const lines: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  const ensure = () => {
    if (rl) return;
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else lines.push(line);
    });
    // EOF: nothing more can be pasted; the browser callback can still complete the login.
  };
  return {
    ask(p: AuthPrompt): Promise<string> {
      ensure();
      return new Promise<string>((resolve, reject) => {
        const signal = p.signal;
        if (signal?.aborted) {
          reject(new Error('prompt cancelled'));
          return;
        }
        const onAbort = () => {
          waiter = null;
          reject(new Error('prompt cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const take = (line: string) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(line.trim());
        };
        const queued = lines.shift();
        if (queued !== undefined) take(queued);
        else waiter = take;
      });
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

/** `orc login chatgpt [--import-pi] [--no-browser]`. Returns the exit code. */
export async function loginChatGPT(opts: LoginOptions = {}): Promise<number> {
  const out = opts.out ?? ((l) => process.stdout.write(`${l}\n`));
  const err = opts.err ?? ((l) => process.stderr.write(`${l}\n`));
  const env = opts.env ?? process.env;
  registerBunOAuthFlows();
  installTestEndpoint(env);
  const redirected = testEndpoint(env);
  if (redirected) err(`note: ORC_CODEX_TEST_ENDPOINT is set: OpenAI requests go to ${redirected}`);
  const orc = new OrcChatGPTStore();

  if (opts.importPi) {
    const pi = new PiAuthFileStore(piAuthPath(env));
    const cred = await pi.read(OPENAI_PROVIDER_ID);
    if (!cred) {
      err(`no ChatGPT login found in pi's ${piAuthPath(env)}; run \`orc login chatgpt\` to sign in directly`);
      return 1;
    }
    await orc.modify(OPENAI_PROVIDER_ID, async () => cred);
    out(`imported pi's ChatGPT credential into ${orcChatGPTAuthPath()}`);
    out('note: the two copies now refresh independently; if OpenAI rotates refresh tokens, pi or orc may need a new login.');
    return 0;
  }

  const models = createModels({ credentials: orc });
  models.setProvider(openaiProvider());
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('login timed out')), LOGIN_TIMEOUT_MS);
  const onSigint = () => abort.abort(new Error('login cancelled'));
  process.once('SIGINT', onSigint);
  const prompter = stdinPrompter();
  const interaction: AuthInteraction = {
    signal: abort.signal,
    notify(e: AuthEvent) {
      if (e.type === 'auth_url') {
        const opened = !opts.noBrowser && openBrowser(e.url);
        out(opened ? 'Opening your browser to sign in with ChatGPT. If it did not open, visit:' : 'Sign in with ChatGPT by visiting:');
        out(`  ${e.url}`);
        out('Waiting for the browser to return to http://127.0.0.1:1455/auth/callback …');
        out('(On another machine? Paste the final redirect URL here and press Enter.)');
      } else if (e.type === 'progress' || e.type === 'info') {
        out(e.message);
      }
    },
    prompt: (p) => prompter.ask(p),
  };
  try {
    await models.login(OPENAI_PROVIDER_ID, 'oauth', interaction, { getDeviceId: () => orcDeviceId(), agentName: 'orc' });
  } catch (e) {
    err(`orc login chatgpt failed: ${(e as Error).message}`);
    return 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSigint);
    prompter.close();
  }
  out(`signed in with ChatGPT; credential stored in ${orcChatGPTAuthPath()}`);
  try {
    const auth = await resolveCodexAuth(env);
    const listed = await listLiveModels({ models, accountKey: auth.accountKey, force: true });
    out(`default codex model: ${listed.ids[0]} (${listed.ids.length} models available)`);
  } catch (e) {
    out(`(could not list models yet: ${(e as Error).message}; pass --model when spawning)`);
  }
  return 0;
}

export interface LoginStatus {
  /** What the codex harness would use now. */
  active: 'orc' | 'pi' | 'env' | 'none';
  orc: { path: string; credential: string };
  pi: { path: string; credential: string };
  openaiApiKey: boolean;
}

/** Non-secret summary of every credential source, in resolution order. */
export async function loginStatus(env: Record<string, string | undefined> = process.env): Promise<LoginStatus> {
  const store = codexCredentialStore(env);
  const orcCred: Credential | undefined = await store.orc.read(OPENAI_PROVIDER_ID).catch(() => undefined);
  const piCred: Credential | undefined = await store.pi?.read(OPENAI_PROVIDER_ID).catch(() => undefined);
  let active: LoginStatus['active'] = 'none';
  try {
    active = (await resolveCodexAuth(env)).source;
  } catch {
    active = 'none';
  }
  return {
    active,
    orc: { path: orcChatGPTAuthPath(), credential: describeOAuth(orcCred) },
    pi: { path: piAuthPath(env), credential: describeOAuth(piCred) },
    openaiApiKey: !!env.OPENAI_API_KEY,
  };
}

export function renderLoginStatus(s: LoginStatus): string {
  const mark = (k: LoginStatus['active']) => (s.active === k ? '→' : ' ');
  return [
    'codex credentials (first match is used):',
    `${mark('orc')} 1. orc login     ${s.orc.credential}  [${s.orc.path}]`,
    `${mark('pi')} 2. pi login      ${s.pi.credential}  [${s.pi.path}]`,
    `${mark('env')} 3. OPENAI_API_KEY ${s.openaiApiKey ? 'set' : 'not set'}`,
    s.active === 'none' ? 'none configured: run `orc login chatgpt` or set OPENAI_API_KEY' : `active: ${s.active}`,
  ].join('\n');
}

/** `orc logout chatgpt`: remove orc's credential (pi's login is never touched). */
export async function logoutChatGPT(opts: { env?: Record<string, string | undefined>; out?: Out } = {}): Promise<number> {
  const out = opts.out ?? ((l) => process.stdout.write(`${l}\n`));
  const env = opts.env ?? process.env;
  const had = fs.existsSync(orcChatGPTAuthPath());
  await new OrcChatGPTStore().delete(OPENAI_PROVIDER_ID);
  out(had ? `removed orc's ChatGPT credential (${orcChatGPTAuthPath()})` : 'no orc ChatGPT credential to remove');
  const pi = await new PiAuthFileStore(piAuthPath(env)).read(OPENAI_PROVIDER_ID).catch(() => undefined);
  if (pi) out(`note: pi's ChatGPT login (${piAuthPath(env)}) is still present and will be used; log out in pi to remove it`);
  return 0;
}
