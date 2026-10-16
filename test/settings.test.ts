/**
 * S10 — `ORC_HOST` + `.orc/settings.toml`: parse/validate, discovery (nearest local file up
 * to the git root; global skipped when it IS the local candidate; symlinked cwd), merge,
 * the host precedence table, the trusted-peer rule for local hosts, the lineage rule and
 * spawn/workflow defaults. Pure: every call injects cwd + env (and once, the fs).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideHost,
  defaultHostNotice,
  defaultModelsOf,
  hasOrcLineage,
  invalidHostReason,
  isTrustedPeer,
  loadSettings,
  parseSettingsToml,
  renderSettingsView,
  resolveSpawnDefaults,
  settingsView,
  SettingsError,
} from '../src/settings.ts';
import type { SettingsFs } from '../src/settings.ts';
import { mkTmp } from './runtime-helpers.ts';

const root = fs.realpathSync(mkTmp('orc-settings-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh sandbox: an ORC_HOME and a work area. */
function sandbox(): { home: string; dir: string; env: NodeJS.ProcessEnv } {
  const base = path.join(root, `s${n++}`);
  const home = path.join(base, 'orc-home');
  const dir = path.join(base, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir, env: { ORC_HOME: home } };
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const localFile = (dir: string) => path.join(dir, '.orc', 'settings.toml');
const globalFile = (home: string) => path.join(home, 'settings.toml');

describe('parse + validate', () => {
  test('the v1 schema', () => {
    const r = parseSettingsToml(
      'host = " studio:9000 "\nprovider = "codex"\n[models]\nclaude = "haiku"\ncodex = "gpt-5.5"\npi = "openai/gpt-5"\n',
      '/x/settings.toml',
    );
    expect(r).toEqual({
      values: { host: 'studio:9000', provider: 'codex', models: { claude: 'haiku', codex: 'gpt-5.5', pi: 'openai/gpt-5' } },
      unknown: [],
    });
    expect(parseSettingsToml('', '/x/settings.toml')).toEqual({ values: { models: {} }, unknown: [] });
  });

  test('unknown keys and tables are collected (forward compatible), never an error', () => {
    const r = parseSettingsToml('theme = "dark"\n[models]\nclaude = "haiku"\ngemini = "x"\n[future]\nx = 1\n', '/x/s.toml');
    expect(r.values.models).toEqual({ claude: 'haiku' });
    expect(r.unknown).toEqual(['theme', 'models.gemini', 'future']);
  });

  test.each([
    ['host = 1', 'host'],
    ['host = ""', 'host'],
    ['host = "a b"', 'host'],
    ['host = "http://studio"', 'host'],
    ['host = "studio:0"', 'host'],
    ['host = "studio:99999"', 'host'],
    ['provider = "gpt"', 'provider'],
    ['provider = ""', 'provider'],
    ['provider = 3', 'provider'],
    ['models = "haiku"', 'models'],
    ['[models]\nclaude = ""', 'models.claude'],
    ['[models]\ncodex = 5', 'models.codex'],
    ['[models.claude]\nx = 1', 'models.claude'],
  ])('%p → error naming the file and key %p', (text, key) => {
    let err: unknown;
    try {
      parseSettingsToml(text, '/proj/.orc/settings.toml');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).key).toBe(key);
    expect((err as Error).message).toStartWith(`/proj/.orc/settings.toml: \`${key}\``);
  });

  test('a file that fails to parse names the file', () => {
    expect(() => parseSettingsToml('host = \nprovider', '/p/settings.toml')).toThrow(/^\/p\/settings\.toml: invalid TOML: /);
  });

  test('host syntax', () => {
    for (const ok of ['studio', 'mini.taila038d5.ts.net', '100.64.0.1', 'h:8787', 'a']) expect(invalidHostReason(ok)).toBeUndefined();
    for (const bad of ['', ' ', 'a b', 'h:', 'h:x', ':80', '-h', 'h/x', 'user@h']) expect(invalidHostReason(bad)).toBeDefined();
  });
});

describe('discovery', () => {
  test('nearest local file wins (no cascading); local over global per key; [models] per provider', () => {
    const { home, dir, env } = sandbox();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(globalFile(home), 'host = "global-host"\nprovider = "pi"\n[models]\nclaude = "g-claude"\ncodex = "g-codex"\n');
    write(localFile(repo), 'provider = "claude"\n[models]\npi = "repo-pi"\n');
    const sub = path.join(repo, 'pkg');
    write(localFile(sub), '[models]\nclaude = "sub-claude"\n');
    const deeper = path.join(sub, 'src', 'deep');
    fs.mkdirSync(deeper, { recursive: true });

    const s = loadSettings({ cwd: deeper, env });
    expect(s.local?.path).toBe(localFile(sub));
    expect(s.root).toBe(repo);
    // repo/.orc is NOT merged in: only the nearest local file is used.
    expect(s.provider).toEqual({ value: 'pi', source: 'global', from: globalFile(home) });
    expect(s.models).toEqual({
      claude: { value: 'sub-claude', source: 'local', from: localFile(sub) },
      codex: { value: 'g-codex', source: 'global', from: globalFile(home) },
    });
    expect(s.host).toEqual({ value: 'global-host', source: 'global', from: globalFile(home) });
    expect(s.files.map((f) => [f.scope, f.status, f.path])).toEqual([
      ['local', 'missing', localFile(deeper)],
      ['local', 'missing', localFile(path.join(sub, 'src'))],
      ['local', 'used', localFile(sub)],
      ['global', 'used', globalFile(home)],
    ]);

    const atRepo = loadSettings({ cwd: repo, env });
    expect(atRepo.provider).toEqual({ value: 'claude', source: 'local', from: localFile(repo) });
    expect(defaultModelsOf(atRepo)).toEqual({ claude: 'g-claude', codex: 'g-codex', pi: 'repo-pi' });
  });

  test('the search stops at the git toplevel (a linked worktree `.git` file counts)', () => {
    const { dir, env } = sandbox();
    write(localFile(dir), 'provider = "codex"\n');
    const repo = path.join(dir, 'repo');
    write(path.join(repo, '.git'), 'gitdir: /elsewhere\n');
    const sub = path.join(repo, 'a');
    fs.mkdirSync(sub, { recursive: true });
    const s = loadSettings({ cwd: sub, env });
    expect(s.root).toBe(repo);
    expect(s.local).toBeUndefined();
    expect(s.provider).toBeUndefined();
    expect(s.files.filter((f) => f.scope === 'local').map((f) => f.path)).toEqual([localFile(sub), localFile(repo)]);
  });

  test('outside a repo only the cwd itself is searched', () => {
    const { dir, env } = sandbox();
    write(localFile(dir), 'provider = "codex"\n');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const below = loadSettings({ cwd: sub, env });
    expect(below.root).toBeUndefined();
    expect(below.provider).toBeUndefined();
    expect(below.files.filter((f) => f.scope === 'local').map((f) => f.path)).toEqual([localFile(sub)]);
    expect(loadSettings({ cwd: dir, env }).provider).toEqual({ value: 'codex', source: 'local', from: localFile(dir) });
  });

  test('a local candidate that IS the global file is skipped (running from ~)', () => {
    const { dir } = sandbox();
    // ~ is a git repo (dotfiles) and ORC_HOME is ~/.orc: from ~/proj the walk reaches ~/.orc/settings.toml.
    fs.mkdirSync(path.join(dir, '.git'));
    const g = write(localFile(dir), 'host = "studio"\nprovider = "pi"\n');
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const env = { ORC_HOME: path.join(dir, '.orc') };
    for (const cwd of [dir, proj]) {
      const s = loadSettings({ cwd, env });
      expect(s.local).toBeUndefined();
      expect(s.global?.path).toBe(g);
      expect(s.files.find((f) => f.path === g && f.scope === 'local')?.status).toBe('same-as-global');
      // Global, so the host is NOT subject to the trusted-peer rule.
      expect(s.host).toEqual({ value: 'studio', source: 'global', from: g });
      expect(decideHost({ settings: s, peers: [] })).toEqual({ kind: 'remote', host: 'studio', explicit: false, from: g });
    }
    // Also through a symlinked ORC_HOME.
    const link = path.join(dir, 'orc-link');
    fs.symlinkSync(path.join(dir, '.orc'), link);
    expect(loadSettings({ cwd: dir, env: { ORC_HOME: link } }).local).toBeUndefined();
  });

  test('a symlinked cwd resolves to its real location first', () => {
    const { dir, env } = sandbox();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(localFile(repo), 'provider = "codex"\n');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const link = path.join(dir, 'elsewhere', 'link');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(sub, link);
    const s = loadSettings({ cwd: link, env });
    expect(s.cwd).toBe(sub);
    expect(s.root).toBe(repo);
    expect(s.provider?.from).toBe(localFile(repo));
  });

  test('the fs is injectable (in-memory)', () => {
    const files = new Map<string, string>([
      ['/h/settings.toml', 'host = "g"\n'],
      ['/r/.orc/settings.toml', 'provider = "claude"\nfoo = 1\n'],
    ]);
    const mem: SettingsFs = {
      readFile: (p) => files.get(p),
      realpath: (p) => path.resolve(p),
      exists: (p) => p === '/r/.git',
    };
    const s = loadSettings({ cwd: '/r/x', env: { ORC_HOME: '/h' }, fs: mem });
    expect(s.root).toBe('/r');
    expect(s.provider?.value).toBe('claude');
    expect(s.host?.value).toBe('g');
    expect(s.warnings).toEqual(['/r/.orc/settings.toml: unknown setting(s) ignored: foo']);
  });

  test('unreadable/invalid files are errors naming the file', () => {
    const { home, dir, env } = sandbox();
    write(globalFile(home), 'provider = "nope"\n');
    expect(() => loadSettings({ cwd: dir, env })).toThrow(`${globalFile(home)}: \`provider\``);
    fs.rmSync(globalFile(home));
    fs.mkdirSync(localFile(dir), { recursive: true }); // a directory where the file should be
    expect(() => loadSettings({ cwd: dir, env })).toThrow(`${localFile(dir)}: cannot read`);
  });
});

describe('host precedence', () => {
  function withFiles(): { s: (env?: NodeJS.ProcessEnv) => ReturnType<typeof loadSettings>; local: string; global: string } {
    const { home, dir, env } = sandbox();
    const g = write(globalFile(home), 'host = "global-host"\n');
    const l = write(localFile(dir), 'host = "studio"\n');
    return { s: (extra = {}) => loadSettings({ cwd: dir, env: { ...env, ...extra } }), local: l, global: g };
  }
  const studio = [{ host: 'studio' }];

  test('--local > --host > ORC_HOST > local > global > none', () => {
    const { s, local, global } = withFiles();
    const env = s({ ORC_HOST: 'from-env:9000' });
    expect(env.host).toEqual({ value: 'from-env:9000', source: 'env', from: 'ORC_HOST' });
    expect(decideHost({ local: true, host: 'x', settings: env })).toEqual({ kind: 'local', why: 'flag' });
    expect(decideHost({ host: 'x', settings: env })).toEqual({ kind: 'remote', host: 'x', explicit: true, from: '--host' });
    expect(decideHost({ settings: env })).toEqual({ kind: 'remote', host: 'from-env:9000', explicit: false, from: 'ORC_HOST' });
    expect(decideHost({ settings: s(), peers: studio })).toEqual({ kind: 'remote', host: 'studio', explicit: false, from: local });

    fs.rmSync(local);
    expect(decideHost({ settings: s() })).toEqual({ kind: 'remote', host: 'global-host', explicit: false, from: global });
    fs.rmSync(global);
    expect(decideHost({ settings: s() })).toEqual({ kind: 'local', why: 'none' });
  });

  test('ORC_HOST="" is explicitly no default host (settings host ignored too)', () => {
    const { s } = withFiles();
    const empty = s({ ORC_HOST: '' });
    expect(empty.host).toBeUndefined();
    expect(empty.hostNote).toMatch(/empty string/);
    expect(decideHost({ settings: empty, peers: studio })).toEqual({ kind: 'local', why: 'none' });
    expect(s({ ORC_HOST: '  ' }).host).toBeUndefined();
  });

  test('an invalid ORC_HOST is an error naming it', () => {
    const { s } = withFiles();
    expect(() => s({ ORC_HOST: 'a b' })).toThrow(/^ORC_HOST: must be host or host:port/);
  });

  test('a LOCAL host must be a trusted peer (host and host:port matched like peers.json)', () => {
    const { s, local } = withFiles();
    const d = decideHost({ settings: s(), peers: [{ host: 'mini' }] });
    expect(d.kind).toBe('refused');
    const msg = (d as { message: string }).message;
    expect(msg).toContain(local);
    expect(msg).toContain('orc remote add studio');
    expect(msg).toContain('--local');
    expect(msg).toContain('--host');

    expect(isTrustedPeer('studio', [{ host: 'Studio.' }])).toBe(true);
    expect(isTrustedPeer('studio:8787', [{ host: 'studio' }])).toBe(true);
    expect(isTrustedPeer('studio:9000', [{ host: 'studio' }])).toBe(false);
    expect(isTrustedPeer('studio:9000', [{ host: 'studio', port: 9000 }])).toBe(true);
    expect(isTrustedPeer('studio', [{ host: 'studio', port: 9000 }])).toBe(false);

    // ORC_HOST and --host are the user's own intent: never peer-checked.
    expect(decideHost({ settings: s({ ORC_HOST: 'anywhere' }), peers: [] }).kind).toBe('remote');
    expect(decideHost({ host: 'anywhere', settings: s(), peers: [] }).kind).toBe('remote');
    // --local skips the check entirely.
    expect(decideHost({ local: true, settings: s(), peers: [] })).toEqual({ kind: 'local', why: 'flag' });
  });

  test('inside an orc session default hosts are ignored; provider/model defaults still apply', () => {
    const { home, dir, env } = sandbox();
    write(globalFile(home), 'host = "global-host"\nprovider = "codex"\n[models]\ncodex = "gpt-x"\n');
    for (const lineage of [{ ORC_PARENT_SESSION_ID: 'abcd1234' }, { ORC_DEPTH: '1' }, { ORC_DEPTH: '3' }]) {
      const s = loadSettings({ cwd: dir, env: { ...env, ORC_HOST: 'studio', ...lineage } });
      expect(s.nested).toBe(true);
      expect(s.host).toBeUndefined();
      expect(s.hostNote).toMatch(/inside an orc session/);
      expect(decideHost({ settings: s })).toEqual({ kind: 'local', why: 'none' });
      expect(decideHost({ host: 'explicit', settings: s })).toMatchObject({ kind: 'remote', host: 'explicit', explicit: true });
      expect(resolveSpawnDefaults({ settings: s })).toEqual({ provider: 'codex', model: 'gpt-x' });
    }
  });

  test('the lineage marker', () => {
    expect(hasOrcLineage({})).toBe(false);
    expect(hasOrcLineage({ ORC_DEPTH: '0' })).toBe(false);
    expect(hasOrcLineage({ ORC_DEPTH: '' })).toBe(false);
    expect(hasOrcLineage({ ORC_DEPTH: 'x' })).toBe(false);
    expect(hasOrcLineage({ ORC_PARENT_SESSION_ID: '' })).toBe(false);
    // A detached workflow runner carries run lineage at depth 0: not a session.
    expect(hasOrcLineage({ ORC_ROOT_RUN_ID: 'r', ORC_PARENT_RUN_ID: 'r', ORC_DEPTH: '0' })).toBe(false);
    expect(hasOrcLineage({ ORC_DEPTH: '1' })).toBe(true);
    expect(hasOrcLineage({ ORC_PARENT_SESSION_ID: 'abcd1234' })).toBe(true);
  });

  test('the default-host notice', () => {
    expect(defaultHostNotice('studio', 'ORC_HOST')).toBe('orc: → studio (from ORC_HOST)\n');
  });
});

describe('spawn + workflow defaults', () => {
  const settings = {
    provider: { value: 'claude' as const, source: 'global' as const, from: '/g' },
    models: {
      claude: { value: 'haiku', source: 'local' as const, from: '/l' },
      codex: { value: 'gpt-5.5', source: 'global' as const, from: '/g' },
    },
  };
  test('--provider > settings provider; --model > [models].<provider> > provider default', () => {
    expect(resolveSpawnDefaults({ settings })).toEqual({ provider: 'claude', model: 'haiku' });
    expect(resolveSpawnDefaults({ provider: 'codex', settings })).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(resolveSpawnDefaults({ provider: 'pi', settings })).toEqual({ provider: 'pi' });
    expect(resolveSpawnDefaults({ model: 'opus', settings })).toEqual({ provider: 'claude', model: 'opus' });
    expect(resolveSpawnDefaults({ settings: { models: {} } })).toEqual({});
  });
  test('a named --agent owns its model: [models] does not apply', () => {
    expect(resolveSpawnDefaults({ provider: 'codex', agent: 'reviewer', settings })).toEqual({ provider: 'codex' });
    expect(resolveSpawnDefaults({ agent: 'x', model: 'm', settings })).toEqual({ provider: 'claude', model: 'm' });
  });
});

describe('orc settings view', () => {
  test('values with their source per key, files considered, warnings', () => {
    const { home, dir, env } = sandbox();
    const g = write(globalFile(home), 'provider = "codex"\nmystery = 1\n');
    const l = write(localFile(dir), 'host = "studio"\n[models]\nclaude = "haiku"\n');
    const s = loadSettings({ cwd: dir, env });
    const v = settingsView(s, { peers: [] });
    expect(v.host).toEqual({
      value: 'studio',
      source: 'local',
      from: l,
      note: 'refused: not a trusted peer (orc remote add studio, or --local/--host)',
    });
    expect(settingsView(s, { peers: [{ host: 'studio' }] }).host.note).toBeUndefined();
    expect(settingsView(s, { local: true }).host).toMatchObject({ value: null, source: 'flag', from: '--local' });
    expect(v.provider).toEqual({ value: 'codex', source: 'global', from: g });
    expect(v.models.claude).toEqual({ value: 'haiku', source: 'local', from: l });
    expect(v.models.pi).toMatchObject({ value: null, source: 'default' });
    expect(v.warnings).toEqual([`${g}: unknown setting(s) ignored: mystery`]);
    const text = renderSettingsView(v);
    expect(text).toContain(`(local: ${l})`);
    expect(text).toContain(`(global: ${g})`);
    expect(text).toContain('warnings:');
    expect(text).toContain(`only (not in a git repo)`);
  });
});
