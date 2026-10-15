/**
 * Environment hygiene for actors and providers.
 *
 * Whoever wakes a session (often an agent of ANOTHER workflow step) spawns the actor with
 * its own environment. Lineage and policy variables (ORC_RUN_ID, ORC_RESULT_PATH,
 * ORC_ATTEMPT_ID, ORC_DEPTH, ORC_POLICY_*, …) describe the WAKER, not the session: the
 * session's own lineage is `spec.env`, written at spawn. Inherited lineage keys are
 * therefore dropped before `spec.env` is applied. Everything else (ORC_HOME, PATH, auth,
 * provider binaries…) is kept.
 */
import { ORC_ENV } from '../types.ts';

const LINEAGE_KEYS: ReadonlySet<string> = new Set(Object.values(ORC_ENV));

/** An ORC_* lineage/policy key that must never be inherited from a waker. */
export function isLineageEnvKey(key: string): boolean {
  return LINEAGE_KEYS.has(key) || key.startsWith('ORC_POLICY_');
}

/** `base` (string values only) without lineage/policy keys. */
export function withoutInheritedLineage(base: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && !isLineageEnvKey(k)) out[k] = v;
  }
  return out;
}

/** Provider env: the actor's env minus inherited lineage, then the session's own `spec.env`. */
export function providerEnv(base: NodeJS.ProcessEnv, specEnv: Record<string, string>): Record<string, string> {
  return Object.assign(withoutInheritedLineage(base), specEnv);
}
