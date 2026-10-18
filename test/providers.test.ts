import { describe, expect, test } from 'bun:test';
import { PROVIDERS, assertProvider, isProvider, parsePiModel, validateModel } from '../src/providers.ts';
import { getRuntimeFactory } from '../src/runtime/providers/index.ts';
import type { RuntimeProvider } from '../src/runtime/types.ts';

describe('production integrations', () => {
  test('Pi and Claude are the complete public set; Codex has no runtime', async () => {
    expect(PROVIDERS).toEqual(['claude', 'pi']);
    for (const provider of PROVIDERS) {
      expect(isProvider(provider)).toBe(true);
      expect(() => assertProvider(provider)).not.toThrow();
      expect((await getRuntimeFactory(provider)).provider).toBe(provider);
    }
    expect(isProvider('codex')).toBe(false);
    expect(() => assertProvider('codex')).toThrow("provider 'pi'");
    expect(() => assertProvider('codex')).toThrow('openai/<model-id>');
    await expect(getRuntimeFactory('codex' as RuntimeProvider)).rejects.toThrow('unknown runtime provider');
    for (const provider of [undefined, null, '', 0, {}, 'openai', 'fake', 'Pi']) {
      expect(isProvider(provider)).toBe(false);
      expect(() => assertProvider(provider)).toThrow();
    }
  });
});

describe('model selection is delegated to Pi', () => {
  test('splits only the model provider qualifier, preserving nested ids and thinking suffixes', () => {
    expect(parsePiModel('openai/gpt-5.5')).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(parsePiModel('openai-codex/gpt-6.1-sol:high')).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol:high' });
    expect(parsePiModel('openrouter/openai/gpt-5:exacto')).toEqual({ provider: 'openrouter', model: 'openai/gpt-5:exacto' });
    expect(parsePiModel('haiku')).toEqual({ model: 'haiku' });
  });

  test('accepts custom Pi providers and existing bare selectors without copying a catalog', () => {
    for (const model of [undefined, 'haiku', 'gpt-5.5', 'custom-provider/model-v1', 'openai/gpt-5.5:high', 'openrouter/vendor/model:exacto']) {
      expect(() => validateModel('pi', model)).not.toThrow();
    }
    for (const model of [undefined, 'haiku', 'opus[1m]', 'claude-sonnet-4-5']) {
      expect(() => validateModel('claude', model)).not.toThrow();
    }
  });

  test('rejects malformed models and qualifiers before a provider starts', () => {
    for (const provider of PROVIDERS) {
      for (const model of ['', null, 42, {}, ' model', 'model ', 'model\n', 'mo\u0000del', 'mo\u007fdel']) {
        expect(() => validateModel(provider, model)).toThrow('model must be');
      }
    }
    for (const model of ['/gpt-5.5', 'openai/', 'openai//gpt-5.5', 'openai/ gpt-5.5', 'open ai/gpt-5.5']) {
      expect(() => validateModel('pi', model)).toThrow('invalid Pi model');
    }
  });
});
