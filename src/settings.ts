/**
 * orc settings: the `ORC_HOST` env var and `settings.toml` files.
 *
 * Schema (v1):
 *
 *   host = "studio"        # default remote target: host or host:port (as --host)
 *   provider = "claude"    # default `orc spawn --provider`
 *   [models]               # default --model per provider
 *   claude = "haiku"
 *
 * Files:
 * - global: `$ORC_HOME/settings.toml` (default `~/.orc/settings.toml`).
 * - local: the NEAREST `<dir>/.orc/settings.toml`, searched from the realpath of the cwd up to
 *   its git toplevel (the nearest ancestor holding `.git` — a repo's dir or a linked worktree's
 *   file); outside a repo only the cwd itself. A candidate that is the global file (same
 *   realpath, e.g. running from `~`) is skipped. Only one local file is used.
 * - merge: local over global per key; `[models]` per provider.
 *
 * Default host: `ORC_HOST` (set and non-empty; set to "" = explicitly no default host) >
 * local > global > none. Inside an orc session (the process carries orc lineage:
 * `ORC_PARENT_SESSION_ID`, or `ORC_DEPTH` >= 1 — what every session's provider env has)
 * default hosts are ignored. The CLI puts `--local` > `--host` on top (`decideHost`) and
 * refuses a host from a LOCAL file unless it is a trusted peer (`orc remote add`).
 *
 * The SDK never reads these files on its own; `loadSettings()` is exported for SDK users
 * who want the same resolution. Parsing uses Bun's built-in TOML parser (no dependency;
 * it is part of the compiled binary).
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import type { Provider } from './types.ts';
import { ORC_ENV } from './types.ts';
import { globalSettingsPath } from './paths.ts';
import { DEFAULT_DAEMON_PORT, normalizeHost } from './daemon/peers.ts';
import type { PeerEntry } from './daemon/peers.ts';
import { parseHostArg } from './daemon/client.ts';

export const ORC_HOST_ENV = 'ORC_HOST';
/** A project-local settings file, relative to the directory it applies to. */
export const LOCAL_SETTINGS_FILE = path.join('.orc', 'settings.toml');
export const SETTINGS_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'pi'];

/** A settings file (or ORC_HOST) is unusable: the message names the file/var and the key. */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly key?: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** The values one settings file sets. */
export interface SettingsFileValues {
  host?: string;
  provider?: Provider;
  models: Partial<Record<Provider, string>>;
}

export interface ParsedSettingsFile {
  values: SettingsFileValues;
  /** Keys this version does not know (`extra`, `models.foo`): ignored with a warning. */
  unknown: string[];
}

export type SettingSource = 'flag' | 'env' | 'local' | 'global' | 'default';

export interface Setting<T> {
  value: T;
  source: SettingSource;
  /** The settings file path (local/global), the env var (env) or the flag (flag). */
  from: string;
}

export interface ConsideredFile {
  scope: 'local' | 'global';
  path: string;
  /** `same-as-global`: a local candidate that is the global file itself (skipped). */
  status: 'used' | 'missing' | 'same-as-global';
}

export interface Settings {
  /** Realpath of the directory the local search started from. */
  cwd: string;
  /** The git toplevel the local search stops at (undefined outside a repo: cwd only). */
  root?: string;
  /** Local candidates nearest first (up to the one used), then the global file. */
  files: ConsideredFile[];
  /** Unknown keys, one line per file. */
  warnings: string[];
  /** The process runs inside an orc session: default hosts are ignored. */
  nested: boolean;
  /** The default host (not trust-checked yet; see decideHost). Undefined = run locally. */
  host?: Setting<string>;
  /** Why no default host applies although one may be configured (nested / ORC_HOST=""). */
  hostNote?: string;
  provider?: Setting<Provider>;
  models: Partial<Record<Provider, Setting<string>>>;
  local?: { path: string; values: SettingsFileValues };
  global?: { path: string; values: SettingsFileValues };
}

/** The filesystem surface settings discovery uses (injectable for tests). */
export interface SettingsFs {
  /** The file's text, or undefined when it does not exist. Other errors throw. */
  readFile(p: string): string | undefined;
  /** realpath(p), or the resolved path unchanged when it cannot be resolved. */
  realpath(p: string): string;
  /** Whether anything exists at p (used for the `.git` marker). */
  exists(p: string): boolean;
}

export const nodeSettingsFs: SettingsFs = {
  readFile(p) {
    try {
      return nodeFs.readFileSync(p, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw e;
    }
  },
  realpath(p) {
    try {
      return nodeFs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  },
  exists(p) {
    try {
      nodeFs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
};

export interface LoadSettingsOptions {
  /** Where the local search starts (default: process.cwd() — never a command's `--cwd`). */
  cwd?: string;
  /** Environment for ORC_HOME, ORC_HOST and the lineage marker (default: process.env). */
  env?: NodeJS.ProcessEnv;
  fs?: SettingsFs;
}

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (SETTINGS_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Whether this process runs inside an orc session. Every session's provider env carries
 * `ORC_PARENT_SESSION_ID` (the spawning session) and `ORC_DEPTH` >= 1 (agent.ts lineage
 * env); either one marks a nested orc.
 */
export function hasOrcLineage(env: NodeJS.ProcessEnv = process.env): boolean {
  const parent = env[ORC_ENV.PARENT_SESSION_ID];
  if (parent !== undefined && parent.trim().length > 0) return true;
  const raw = env[ORC_ENV.DEPTH];
  if (raw === undefined || raw.trim().length === 0) return false;
  const depth = Number(raw);
  return Number.isFinite(depth) && depth >= 1;
}

const HOST_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Why `raw` is not a valid host spec (`host` or `host:port`), or undefined when it is. */
export function invalidHostReason(raw: string): string | undefined {
  const s = raw.trim();
  if (s.length === 0) return 'empty';
  let host = s;
  const idx = s.lastIndexOf(':');
  if (idx !== -1) {
    const port = s.slice(idx + 1);
    host = s.slice(0, idx);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return `bad port '${port}' (1-65535)`;
  }
  if (!HOST_NAME_RE.test(host)) return `bad host name '${host}'`;
  return undefined;
}

function describe(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return 'an array';
  if (v !== null && typeof v === 'object') return 'a table';
  return `${typeof v} ${String(v)}`;
}

function invalid(file: string, key: string, why: string): SettingsError {
  return new SettingsError(`${file}: \`${key}\` ${why}`, file, key);
}

/** Parse + validate one settings file's text. Throws SettingsError naming `file` (and the key). */
export function parseSettingsToml(text: string, file: string): ParsedSettingsFile {
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new SettingsError(`${file}: invalid TOML: ${(e as Error).message}`, file);
  }
  const values: SettingsFileValues = { models: {} };
  const unknown: string[] = [];
  for (const [key, v] of Object.entries(raw)) {
    switch (key) {
      case 'host': {
        if (typeof v !== 'string') throw invalid(file, 'host', `must be a string (host or host:port), got ${describe(v)}`);
        const why = invalidHostReason(v);
        if (why) throw invalid(file, 'host', `must be host or host:port, got '${v}' (${why})`);
        values.host = v.trim();
        break;
      }
      case 'provider': {
        const p = typeof v === 'string' ? v.trim() : v;
        if (!isProvider(p)) throw invalid(file, 'provider', `must be claude|codex|pi, got ${describe(v)}`);
        values.provider = p;
        break;
      }
      case 'models': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          throw invalid(file, 'models', `must be a table ([models] claude = "…"), got ${describe(v)}`);
        }
        for (const [p, m] of Object.entries(v as Record<string, unknown>)) {
          if (!isProvider(p)) {
            unknown.push(`models.${p}`);
            continue;
          }
          if (typeof m !== 'string' || m.trim().length === 0) {
            throw invalid(file, `models.${p}`, `must be a non-empty string, got ${describe(m)}`);
          }
          values.models[p] = m.trim();
        }
        break;
      }
      default:
        unknown.push(key);
    }
  }
  return { values, unknown };
}

function readSettingsFile(fsx: SettingsFs, file: string): string | undefined {
  try {
    return fsx.readFile(file);
  } catch (e) {
    throw new SettingsError(`${file}: cannot read: ${(e as Error).message}`, file);
  }
}

/** The git toplevel of `dir`: the nearest ancestor (inclusive) holding `.git`. */
export function gitRootOf(dir: string, fsx: SettingsFs = nodeSettingsFs): string | undefined {
  let cur = dir;
  for (;;) {
    if (fsx.exists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * Local settings candidates for a realpath'd `cwd`, nearest first: `<dir>/.orc/settings.toml`
 * for every dir from cwd up to its git toplevel (outside a repo: cwd only).
 */
export function localSettingsCandidates(
  cwd: string,
  fsx: SettingsFs = nodeSettingsFs,
): { root?: string; candidates: string[] } {
  const root = gitRootOf(cwd, fsx);
  const candidates: string[] = [];
  let cur = cwd;
  for (;;) {
    candidates.push(path.join(cur, LOCAL_SETTINGS_FILE));
    if (root === undefined || cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ...(root !== undefined ? { root } : {}), candidates };
}

function unknownWarning(file: string, keys: string[]): string {
  return `${file}: unknown setting(s) ignored: ${keys.join(', ')}`;
}

/**
 * Discover, parse and merge the settings files, then layer ORC_HOST and the lineage rule.
 * Throws SettingsError (naming the file/var and key) on unreadable/invalid files or ORC_HOST.
 */
export function loadSettings(opts: LoadSettingsOptions = {}): Settings {
  const env = opts.env ?? process.env;
  const fsx = opts.fs ?? nodeSettingsFs;
  const cwd = fsx.realpath(path.resolve(opts.cwd ?? process.cwd()));
  const files: ConsideredFile[] = [];
  const warnings: string[] = [];

  const globalPath = globalSettingsPath(env);
  const globalReal = fsx.realpath(globalPath);
  let global: Settings['global'];
  const globalText = readSettingsFile(fsx, globalPath);
  if (globalText !== undefined) {
    const parsed = parseSettingsToml(globalText, globalPath);
    global = { path: globalPath, values: parsed.values };
    if (parsed.unknown.length > 0) warnings.push(unknownWarning(globalPath, parsed.unknown));
  }

  const { root, candidates } = localSettingsCandidates(cwd, fsx);
  let local: Settings['local'];
  for (const candidate of candidates) {
    const text = readSettingsFile(fsx, candidate);
    if (text === undefined) {
      files.push({ scope: 'local', path: candidate, status: 'missing' });
      continue;
    }
    if (fsx.realpath(candidate) === globalReal) {
      files.push({ scope: 'local', path: candidate, status: 'same-as-global' });
      continue;
    }
    const parsed = parseSettingsToml(text, candidate);
    local = { path: candidate, values: parsed.values };
    if (parsed.unknown.length > 0) warnings.unshift(unknownWarning(candidate, parsed.unknown));
    files.push({ scope: 'local', path: candidate, status: 'used' });
    break;
  }
  files.push({ scope: 'global', path: globalPath, status: global ? 'used' : 'missing' });

  const fromFile = <T>(pick: (v: SettingsFileValues) => T | undefined): Setting<T> | undefined => {
    const l = local ? pick(local.values) : undefined;
    if (l !== undefined) return { value: l, source: 'local', from: local!.path };
    const g = global ? pick(global.values) : undefined;
    if (g !== undefined) return { value: g, source: 'global', from: global!.path };
    return undefined;
  };

  const nested = hasOrcLineage(env);
  let host: Setting<string> | undefined;
  let hostNote: string | undefined;
  const envHost = env[ORC_HOST_ENV];
  if (nested) {
    if ((envHost !== undefined && envHost.trim().length > 0) || fromFile((v) => v.host)) {
      hostNote = `default hosts are ignored inside an orc session (${ORC_ENV.PARENT_SESSION_ID}/${ORC_ENV.DEPTH} set); pass --host explicitly`;
    }
  } else if (envHost !== undefined) {
    const t = envHost.trim();
    if (t.length === 0) {
      hostNote = `${ORC_HOST_ENV} is set to an empty string: no default host`;
    } else {
      const why = invalidHostReason(t);
      if (why) {
        throw new SettingsError(`${ORC_HOST_ENV}: must be host or host:port, got '${envHost}' (${why})`, undefined, ORC_HOST_ENV);
      }
      host = { value: t, source: 'env', from: ORC_HOST_ENV };
    }
  } else {
    host = fromFile((v) => v.host);
  }

  const models: Settings['models'] = {};
  for (const p of SETTINGS_PROVIDERS) {
    const m = fromFile((v) => v.models[p]);
    if (m) models[p] = m;
  }
  const provider = fromFile((v) => v.provider);

  return {
    cwd,
    ...(root !== undefined ? { root } : {}),
    files,
    warnings,
    nested,
    ...(host ? { host } : {}),
    ...(hostNote ? { hostNote } : {}),
    ...(provider ? { provider } : {}),
    models,
    ...(local ? { local } : {}),
    ...(global ? { global } : {}),
  };
}

/** Whether `spec` (host or host:port) names a trusted peer, matched as `--host`/peers.json do. */
export function isTrustedPeer(spec: string, peers: readonly PeerEntry[]): boolean {
  const t = parseHostArg(spec);
  const key = normalizeHost(t.host);
  return peers.some((p) => normalizeHost(p.host) === key && (p.port ?? DEFAULT_DAEMON_PORT) === t.port);
}

export type HostDecision =
  | { kind: 'local'; why: 'flag' | 'none' }
  | { kind: 'remote'; host: string; explicit: boolean; from: string }
  | { kind: 'refused'; message: string };

/**
 * Where a remote-capable command runs: `--local` > `--host` > the settings' default host
 * (ORC_HOST > local file > global file, already resolved by loadSettings) > local. A host
 * from a LOCAL settings file must be a trusted peer (`peers`); otherwise the command is
 * refused — a checked-in project file must not be able to send your commands anywhere.
 */
export function decideHost(input: {
  local?: boolean;
  host?: string;
  settings?: Pick<Settings, 'host'>;
  peers?: readonly PeerEntry[];
}): HostDecision {
  if (input.local) return { kind: 'local', why: 'flag' };
  if (input.host !== undefined) return { kind: 'remote', host: input.host, explicit: true, from: '--host' };
  const h = input.settings?.host;
  if (!h) return { kind: 'local', why: 'none' };
  if (h.source === 'local' && !isTrustedPeer(h.value, input.peers ?? [])) {
    const name = parseHostArg(h.value).host;
    return {
      kind: 'refused',
      message:
        `host '${h.value}' from ${h.from} is not a trusted peer — a project settings file may only name a ` +
        `host you trust: run \`orc remote add ${name}\`, or pass --local (run here) or --host <h>`,
    };
  }
  return { kind: 'remote', host: h.value, explicit: false, from: h.from };
}

/** The stderr line printed when a command goes remote because of a DEFAULT host. */
export function defaultHostNotice(host: string, from: string): string {
  return `orc: → ${host} (from ${from})\n`;
}

/**
 * `orc spawn` provider/model: `--provider` > settings `provider`; `--model` > settings
 * `[models].<provider>` > the provider's own default (undefined). A named `--agent` owns its
 * model (a codex TOML `model`, a claude agent's frontmatter), so `[models]` does not apply.
 */
export function resolveSpawnDefaults(input: {
  provider?: string;
  model?: string;
  agent?: string;
  settings?: Pick<Settings, 'provider' | 'models'>;
}): { provider?: string; model?: string } {
  const provider = input.provider ?? input.settings?.provider?.value;
  let model = input.model;
  if (model === undefined && input.agent === undefined && isProvider(provider)) {
    model = input.settings?.models[provider]?.value;
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** `[models]` as a plain provider → model map (workflow step defaults). */
export function defaultModelsOf(settings: Pick<Settings, 'models'>): Partial<Record<Provider, string>> {
  const out: Partial<Record<Provider, string>> = {};
  for (const p of SETTINGS_PROVIDERS) {
    const m = settings.models[p];
    if (m) out[p] = m.value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// `orc settings` view
// ---------------------------------------------------------------------------------------

export interface SettingView {
  value: string | null;
  source: SettingSource;
  from?: string;
  note?: string;
}

export interface SettingsView {
  cwd: string;
  root: string | null;
  nested: boolean;
  host: SettingView;
  provider: SettingView;
  models: Record<Provider, SettingView>;
  files: ConsideredFile[];
  warnings: string[];
}

/** The effective settings per key with their source, as `orc settings` reports them. */
export function settingsView(
  settings: Settings,
  opts: { local?: boolean; peers?: readonly PeerEntry[] } = {},
): SettingsView {
  let host: SettingView;
  if (opts.local) {
    host = { value: null, source: 'flag', from: '--local', note: 'commands run on this host' };
  } else if (settings.host) {
    host = { value: settings.host.value, source: settings.host.source, from: settings.host.from };
    const d = decideHost({ settings, peers: opts.peers ?? [] });
    if (d.kind === 'refused') host.note = `refused: not a trusted peer (orc remote add ${parseHostArg(settings.host.value).host}, or --local/--host)`;
  } else {
    host = { value: null, source: 'default', note: settings.hostNote ?? 'commands run on this host' };
  }
  const provider: SettingView = settings.provider
    ? { value: settings.provider.value, source: settings.provider.source, from: settings.provider.from }
    : { value: null, source: 'default', note: 'spawn requires --provider' };
  const models = {} as Record<Provider, SettingView>;
  for (const p of SETTINGS_PROVIDERS) {
    const m = settings.models[p];
    models[p] = m
      ? { value: m.value, source: m.source, from: m.from }
      : { value: null, source: 'default', note: "the provider's own default" };
  }
  return {
    cwd: settings.cwd,
    root: settings.root ?? null,
    nested: settings.nested,
    host,
    provider,
    models,
    files: settings.files,
    warnings: settings.warnings,
  };
}

function viewLine(label: string, v: SettingView): string {
  const value = v.value ?? '-';
  const origin = v.from ? `${v.source}: ${v.from}` : v.source;
  const note = v.note ? ` — ${v.note}` : '';
  return `${label.padEnd(14)}${value.padEnd(16)} (${origin})${note}`;
}

/** Human rendering of `orc settings`. */
export function renderSettingsView(view: SettingsView): string {
  const lines = [
    viewLine('host', view.host),
    viewLine('provider', view.provider),
    ...SETTINGS_PROVIDERS.map((p) => viewLine(`models.${p}`, view.models[p])),
    '',
    `files (nearest first; local search ${view.root ? `${view.cwd} → ${view.root}` : `${view.cwd} only (not in a git repo)`}):`,
    ...view.files.map((f) => `  ${f.scope.padEnd(7)}${f.status.padEnd(15)}${f.path}`),
  ];
  if (view.nested) lines.push('', 'inside an orc session: default hosts (ORC_HOST, settings host) are ignored');
  if (view.warnings.length > 0) lines.push('', 'warnings:', ...view.warnings.map((w) => `  ${w}`));
  return lines.join('\n');
}
