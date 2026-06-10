import { describe, test, expect } from 'bun:test';
import { readSelectionFromFlags, resolveCommand } from '../src/cli/index.ts';

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

describe('readSelectionFromFlags', () => {
  test('defaults to latest and accepts explicit modes', () => {
    expect(readSelectionFromFlags({})).toEqual({ mode: 'latest' });
    expect(readSelectionFromFlags({ last: true })).toEqual({ mode: 'latest' });
    expect(readSelectionFromFlags({ full: true })).toEqual({ mode: 'full' });
    expect(readSelectionFromFlags({ index: '2' })).toEqual({ mode: 'index', index: 2 });
  });

  test('rejects invalid and conflicting selections', () => {
    expect(() => readSelectionFromFlags({ index: '-1' })).toThrow(/invalid --index/);
    expect(() => readSelectionFromFlags({ index: '1.2' })).toThrow(/invalid --index/);
    expect(() => readSelectionFromFlags({ full: true, index: '0' })).toThrow(/mutually exclusive/);
    expect(() => readSelectionFromFlags({ raw: true, full: true })).toThrow(/--raw cannot/);
  });
});
