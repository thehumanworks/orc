import { describe, test, expect } from 'bun:test';
import {
  matchRoute,
  mapSpawnRequest,
  mapWaitRequest,
} from '../src/daemon/routes.ts';
import { extractHostFlag } from '../src/cli/index.ts';
import { parseHostArg } from '../src/daemon/client.ts';

describe('matchRoute — the route table', () => {
  test('static routes', () => {
    expect(matchRoute('GET', '/health')?.name).toBe('health');
    expect(matchRoute('GET', '/whoami')?.name).toBe('whoami');
    expect(matchRoute('GET', '/sessions')?.name).toBe('sessions.list');
    expect(matchRoute('POST', '/sessions')?.name).toBe('sessions.spawn');
    expect(matchRoute('GET', '/workflows/runs')?.name).toBe('workflows.runs.list');
    expect(matchRoute('POST', '/workflows/run')?.name).toBe('workflows.run');
  });

  test('param routes capture :id', () => {
    expect(matchRoute('GET', '/sessions/abc123')).toEqual({
      name: 'sessions.get',
      params: { id: 'abc123' },
    });
    expect(matchRoute('POST', '/sessions/abc123/send')).toEqual({
      name: 'sessions.send',
      params: { id: 'abc123' },
    });
    expect(matchRoute('POST', '/sessions/abc123/wait')?.name).toBe('sessions.wait');
    expect(matchRoute('GET', '/sessions/abc123/read')?.name).toBe('sessions.read');
    expect(matchRoute('POST', '/sessions/abc123/kill')?.name).toBe('sessions.kill');
    expect(matchRoute('GET', '/workflows/runs/deadbeef')).toEqual({
      name: 'workflows.runs.get',
      params: { id: 'deadbeef' },
    });
    expect(matchRoute('GET', '/workflows/runs/deadbeef/logs')).toEqual({
      name: 'workflows.runs.logs',
      params: { id: 'deadbeef' },
    });
  });

  test('ordering: literal /workflows/runs wins over /workflows/runs/:id, and :id/logs over :id', () => {
    // same-length disambiguation that depends on table order
    expect(matchRoute('GET', '/workflows/runs')?.name).toBe('workflows.runs.list');
    expect(matchRoute('GET', '/workflows/runs/x/logs')?.name).toBe('workflows.runs.logs');
    expect(matchRoute('GET', '/workflows/runs/x')?.name).toBe('workflows.runs.get');
  });

  test('method mismatch and unknown path → null (→ 404)', () => {
    expect(matchRoute('DELETE', '/sessions')).toBeNull();
    expect(matchRoute('GET', '/nope')).toBeNull();
    expect(matchRoute('POST', '/health')).toBeNull();
  });

  test('url-decodes a param', () => {
    expect(matchRoute('GET', '/sessions/a%20b')?.params.id).toBe('a b');
  });
});

describe('mapSpawnRequest — request → AgentOptions', () => {
  test('minimal: provider only', () => {
    expect(mapSpawnRequest({ provider: 'claude' })).toMatchObject({ provider: 'claude' });
  });
  test('missing provider throws', () => {
    expect(() => mapSpawnRequest({})).toThrow(/provider is required/);
  });
  test('maps agent→agentName and passes prompt/model/cwd/workspace', () => {
    const o = mapSpawnRequest({
      provider: 'codex',
      agent: 'reviewer',
      model: 'gpt-5.5',
      prompt: 'hi',
      cwd: '/tmp/x',
      workspace: 'ws',
    });
    expect(o.agentName).toBe('reviewer');
    expect(o.model).toBe('gpt-5.5');
    expect(o.prompt).toBe('hi');
    expect(o.cwd).toBe('/tmp/x');
    expect(o.workspace).toBe('ws');
  });
  test('worktree boolean + top-level branch → {branch}', () => {
    expect(mapSpawnRequest({ provider: 'claude', worktree: true, branch: 'feat' }).worktree).toEqual({
      branch: 'feat',
    });
    expect(mapSpawnRequest({ provider: 'claude', worktree: true }).worktree).toBe(true);
    expect(mapSpawnRequest({ provider: 'claude' }).worktree).toBeUndefined();
  });
  test('worktree object form', () => {
    expect(mapSpawnRequest({ provider: 'claude', worktree: { branch: 'b' } }).worktree).toEqual({
      branch: 'b',
    });
  });
  test('invalid systemPromptMode throws', () => {
    expect(() => mapSpawnRequest({ provider: 'claude', systemPromptMode: 'bogus' })).toThrow(
      /invalid systemPromptMode/,
    );
  });
  test('noWait → waitForReady:false', () => {
    expect(mapSpawnRequest({ provider: 'claude', noWait: true }).waitForReady).toBe(false);
    expect(mapSpawnRequest({ provider: 'claude' }).waitForReady).toBeUndefined();
  });
});

describe('mapWaitRequest — request → WaitForOptions', () => {
  test('default for=settled', () => {
    expect(mapWaitRequest({})).toEqual({ until: ['done', 'waiting', 'failed'] });
  });
  test('for=done', () => {
    expect(mapWaitRequest({ for: 'done' })).toEqual({ until: ['done'] });
  });
  test('timeoutMs passed through', () => {
    expect(mapWaitRequest({ for: 'done', timeoutMs: 5000 })).toEqual({
      until: ['done'],
      timeoutMs: 5000,
    });
  });
  test('invalid for throws', () => {
    expect(() => mapWaitRequest({ for: 'nonsense' })).toThrow(/invalid for/);
  });
  test('invalid timeoutMs throws', () => {
    expect(() => mapWaitRequest({ timeoutMs: -1 })).toThrow(/invalid timeoutMs/);
  });
});

describe('extractHostFlag — peeling the global --host', () => {
  test('--host before the subcommand', () => {
    expect(extractHostFlag(['--host', 'mini', 'list', '--json'])).toEqual({
      host: 'mini',
      rest: ['list', '--json'],
    });
  });
  test('--host=value form', () => {
    expect(extractHostFlag(['--host=mini:9000', 'spawn', '-p', 'claude'])).toEqual({
      host: 'mini:9000',
      rest: ['spawn', '-p', 'claude'],
    });
  });
  test('--host after the subcommand still peeled', () => {
    expect(extractHostFlag(['kill', 'abc', '--host', 'mini'])).toEqual({
      host: 'mini',
      rest: ['kill', 'abc'],
    });
  });
  test('no --host → host undefined, argv intact', () => {
    expect(extractHostFlag(['list', '--all'])).toEqual({ rest: ['list', '--all'] });
  });
});

describe('parseHostArg — host or host:port', () => {
  test('bare host → default port', () => {
    expect(parseHostArg('mini')).toEqual({ host: 'mini', port: 8787 });
  });
  test('host:port', () => {
    expect(parseHostArg('127.0.0.1:9001')).toEqual({ host: '127.0.0.1', port: 9001 });
  });
  test('fqdn:port', () => {
    expect(parseHostArg('mini.taila038d5.ts.net:8787')).toEqual({
      host: 'mini.taila038d5.ts.net',
      port: 8787,
    });
  });
});
