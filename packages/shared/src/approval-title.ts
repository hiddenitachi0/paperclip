/**
 * Canonical operator-facing approval title format: "<Project name> — <what this does>".
 * The operator runs many companies/projects from one approvals list, so a title
 * must never lead with a PR number, branch name, commit hash, or other internal
 * field — those look identical across unrelated repos and mean nothing to a
 * human skimming the list. Technical references belong in a separate secondary
 * line (see `formatApprovalTechnicalReference`), not the headline.
 */

// Strips legacy/agent-authored prefixes like "Merge PR #4 — ", "PR #12: ", "#7 - "
// so callers can pass through old-style strings without doubling up on the
// project label this module prepends.
const LEGACY_PR_PREFIX_RE = /^(?:merge\s+)?(?:pull request|pr)\s*#?\d+\s*[-–—:]\s*/i;
const LEADING_HASH_NUMBER_RE = /^#\d+\s*[-–—:]\s*/;

export function stripLegacyTitlePrefix(raw: string): string {
  return raw.trim().replace(LEGACY_PR_PREFIX_RE, "").replace(LEADING_HASH_NUMBER_RE, "").trim();
}

/**
 * Compose the operator-facing approval title. `whatThisDoes` should be a
 * plain-language description of the change's effect, not PR/git mechanics —
 * any legacy PR-number prefix on it is stripped so it can't double up with
 * the project label.
 */
export function formatApprovalTitle(projectLabel: string, whatThisDoes: string): string {
  const label = projectLabel.trim() || "Paperclip";
  const body = stripLegacyTitlePrefix(whatThisDoes ?? "");
  return body ? `${label} — ${body}` : label;
}

export interface ApprovalTechnicalReference {
  repo?: string | null;
  prNumber?: number | string | null;
  branch?: string | null;
  base?: string | null;
  commit?: string | null;
}

/**
 * Build the small secondary "Technical reference" line for the approval detail
 * view — PR number, repo, branch, commit stay here, never in the title.
 * Returns null when no technical fields are present.
 */
export function formatApprovalTechnicalReference(ref: ApprovalTechnicalReference): string | null {
  const parts: string[] = [];
  if (ref.repo) parts.push(`${ref.repo} repo`);
  if (ref.prNumber !== undefined && ref.prNumber !== null && ref.prNumber !== "") {
    parts.push(`pull request #${ref.prNumber}`);
  }
  if (ref.branch) parts.push(`branch ${ref.branch}`);
  if (ref.base) parts.push(`into ${ref.base}`);
  if (ref.commit) parts.push(`commit ${String(ref.commit).slice(0, 12)}`);
  if (parts.length === 0) return null;
  return `Technical reference: ${parts.join(", ")}`;
}
