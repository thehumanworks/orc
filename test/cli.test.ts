import { describe, test, expect } from 'bun:test';
import { resolveCommand } from '../src/cli/index.ts';

describe('resolveCommand routing', () => {
  test('spawn aliases', () => {
    expect(resolveCommand('spawn')).toBe('spawn');
    expect(resolveCommand('agent')).toBe('spawn');
    expect(resolveCommand('new')).toBe('spawn');
  });
  test('list alias ps', () => {
    expect(resolveCommand('list')).toBe('list');
    expect(resolveCommand('ps')).toBe('list');
  });
  test('direct commands', () => {
    expect(resolveCommand('send')).toBe('send');
    expect(resolveCommand('read')).toBe('read');
    expect(resolveCommand('attach')).toBe('attach');
    expect(resolveCommand('kill')).toBe('kill');
  });
  test('help fallbacks', () => {
    expect(resolveCommand(undefined)).toBe('help');
    expect(resolveCommand('help')).toBe('help');
    expect(resolveCommand('--help')).toBe('help');
    expect(resolveCommand('-h')).toBe('help');
  });
  test('unknown command', () => {
    expect(resolveCommand('frobnicate')).toBe('unknown');
  });
});
