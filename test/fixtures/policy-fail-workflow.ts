/**
 * A workflow that runs end-to-end through the real CLI WITHOUT launching an agent: the
 * policy allows zero sessions, so the step fails at the pre-spawn policy check and the
 * run finalizes as `failed`. Used by the detached-runner CLI integration tests.
 */
export default {
  name: 'policy-fail',
  policy: { maxSessions: 0 },
  steps: [{ id: 'a', provider: 'claude', prompt: 'never sent' }],
};
