/**
 * ORC integrations and structural model validation. Pi owns model catalogs, discovery,
 * authentication and execution; an OpenAI model provider is not an ORC integration.
 */
import type { Provider, ReasoningEffort } from './types.ts';
export type { ReasoningEffort } from './types.ts';

export const PROVIDERS = ['claude', 'pi'] as const;

// Verified against Claude Code 2.1.302 --help and Pi 1.3.0 --help.
const REASONING_EFFORTS: Record<Provider, readonly ReasoningEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** Validate explicit effort without choosing a default or silently translating levels. */
export function validateReasoningEffort(
  provider: Provider,
  value: unknown,
): asserts value is ReasoningEffort | undefined {
  if (value === undefined) return;
  const supported = REASONING_EFFORTS[provider];
  if (typeof value !== 'string' || !supported.includes(value as ReasoningEffort)) {
    throw new Error(`invalid reasoningEffort '${String(value)}' for ${provider} (expected ${supported.join('|')})`);
  }
}

export function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'pi';
}

export function assertProvider(value: unknown): asserts value is Provider {
  if (isProvider(value)) return;
  if (value === 'codex') {
    throw new Error(
      "the dedicated codex provider was removed; use provider 'pi' with model 'openai/<model-id>' " +
        '(for example openai/gpt-5.5). Sign in with ChatGPT using /login openai in Pi, or set OPENAI_API_KEY. ' +
        'See docs/MIGRATION-pi.md for settings and existing sessions',
    );
  }
  if (value === undefined || value === null || value === '') {
    throw new Error('provider is required (claude|pi)');
  }
  throw new Error(`invalid provider '${String(value)}' (expected claude|pi)`);
}

/**
 * The first slash explicitly names a Pi model provider. Subsequent slashes are part of
 * the model id (for example openrouter/openai/gpt-5). Bare Pi patterns remain supported.
 * No provider catalog is copied here: custom providers are configured in Pi.
 */
export function parsePiModel(model: string): { provider?: string; model: string } {
  const slash = model.indexOf('/');
  return slash < 0 ? { model } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

export function validateModel(provider: Provider, model: unknown): asserts model is string | undefined {
  if (model === undefined) return;
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error('model must be a non-empty string without surrounding whitespace or control characters');
  }
  if (provider !== 'pi') return;
  const parsed = parsePiModel(model);
  if (parsed.provider !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.provider) ||
       !parsed.model || parsed.model.trim() !== parsed.model || /^\//.test(parsed.model))) {
    throw new Error(
      `invalid Pi model '${model}': use provider/model-id (for example openai/gpt-5.5); ` +
        'list available models with pi --list-models',
    );
  }
}
