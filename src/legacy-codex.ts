/** Read-only compatibility facts for the removed Codex harness. No execution or auth. */
export const LEGACY_CODEX_SESSION_FILE = 'codex-session.jsonl';

export function legacyCodexSessionError(sessionId: string): Error & { code: string } {
  return Object.assign(new Error(
    `session ${sessionId} uses the removed Codex integration and cannot receive messages or resume in ORC. ` +
    `History is preserved: use \`orc read ${sessionId} --full\` or \`orc read ${sessionId} --raw\`. ` +
    `For a harness transcript, run \`orc takeover ${sessionId}\` to stop its old actor and print a Pi continuation command. ` +
    `For a new ORC session use \`orc spawn --provider pi --model openai/<model-id>\`. ` +
    `See docs/MIGRATION-pi.md.`,
  ), { code: 'ORC_SESSION_LEGACY' });
}
