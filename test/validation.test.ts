import { describe, test, expect } from 'bun:test';
import { validateOptions } from '../src/agent.ts';

describe('validateOptions', () => {
  test('requires provider', () => {
    // @ts-expect-error intentionally missing provider
    expect(() => validateOptions({})).toThrow(/provider is required/);
  });
  test('rejects invalid provider', () => {
    // @ts-expect-error bad provider
    expect(() => validateOptions({ provider: 'gpt' })).toThrow(/invalid provider/);
  });
  test('agentName + systemPrompt mutually exclusive', () => {
    expect(() =>
      validateOptions({ provider: 'claude', agentName: 'x', systemPrompt: 'y' }),
    ).toThrow(/mutually exclusive/);
  });
  test('agentName alone is valid', () => {
    expect(() => validateOptions({ provider: 'claude', agentName: 'x' })).not.toThrow();
  });
  test('systemPrompt alone is valid', () => {
    expect(() => validateOptions({ provider: 'pi', systemPrompt: 'y' })).not.toThrow();
  });
  test('plain provider is valid', () => {
    expect(() => validateOptions({ provider: 'pi' })).not.toThrow();
  });
});
