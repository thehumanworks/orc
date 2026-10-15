/**
 * Provider runtime registry. Explicit switch with static imports (works inside a
 * compiled binary). Real providers are registered as their slices land.
 */
import type { ProviderRuntimeFactory, RuntimeProvider } from '../types.ts';
import { fakeRuntimeFactory } from './fake.ts';

export async function getRuntimeFactory(provider: RuntimeProvider): Promise<ProviderRuntimeFactory> {
  switch (provider) {
    case 'fake':
      return fakeRuntimeFactory;
    case 'claude':
    case 'codex':
    case 'pi':
      throw new Error(`runtime for ${provider} not available yet`);
    default:
      throw new Error(`unknown runtime provider '${String(provider)}'`);
  }
}
