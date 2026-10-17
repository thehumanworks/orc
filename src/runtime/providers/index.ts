/**
 * Provider runtime registry. Explicit switch with static imports (works inside a
 * compiled binary).
 */
import type { ProviderRuntimeFactory, RuntimeProvider } from '../types.ts';
import { fakeRuntimeFactory } from './fake.ts';
import { claudeRuntime } from './claude.ts';
import { codexRuntime } from './codex.ts';
import { piRuntime } from './pi.ts';

export async function getRuntimeFactory(provider: RuntimeProvider): Promise<ProviderRuntimeFactory> {
  switch (provider) {
    case 'fake':
      return fakeRuntimeFactory;
    case 'claude':
      return claudeRuntime;
    case 'codex':
      return codexRuntime;
    case 'pi':
      return piRuntime;
    default:
      throw new Error(`unknown runtime provider '${String(provider)}'`);
  }
}
