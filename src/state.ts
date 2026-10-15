/**
 * Small pure helpers over AgentState shared by the CLI, the daemon and the SDK.
 * (State itself is derived from the session journal: src/runtime/derive.ts.)
 */
import type { AgentState } from './types.ts';

/** A non-progressing state: one `waitFor` can settle on (vs `running`/`starting`). */
export function isSettled(s: AgentState): boolean {
  return s === 'done' || s === 'waiting' || s === 'failed';
}

/**
 * Map a `--for` value (CLI) / `for` field (daemon `POST .../wait`) to the set of states
 * `waitFor` should settle on. `settled` (default) = any non-progressing state. Returns
 * null for an invalid value.
 */
export function resolveUntil(forArg: string): AgentState[] | null {
  switch (forArg) {
    case 'settled':
      return ['done', 'waiting', 'failed'];
    case 'done':
      return ['done'];
    case 'waiting':
      return ['waiting'];
    case 'failed':
      return ['failed'];
    default:
      return null;
  }
}
