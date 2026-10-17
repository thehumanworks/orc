/**
 * Label sanitising shared by worktree/branch naming. Behaviour is frozen: worktree branch
 * names (`orc/<label>-<shortId>`) and paths are derived from it, so changing it would
 * rename the branches of existing sessions.
 */

/**
 * Collapse every run of characters outside `[A-Za-z0-9_-]` to a single `-` and trim
 * leading/trailing dashes. An empty result becomes `agent`.
 */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'agent';
}
