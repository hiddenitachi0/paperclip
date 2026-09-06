import type { Company } from "@paperclipai/shared";

// Bare board URLs (no `:companyPrefix` in the path, e.g. a bookmarked
// `/skills`) must resolve to the company board the operator is actually on,
// not whichever company happens to be the manually-selected global
// preference (which can go stale — see shouldSyncCompanySelectionFromRoute
// in lib/company-selection.ts). Prefer the last board actually visited, and
// only fall back to the global selection (then the first company) when
// there is genuinely no board history to go on (DUR-3933).
export function resolveBareUrlTargetCompany(
  companies: Company[],
  selectedCompany: Company | null,
  lastBoardPrefix: string | null,
): Company | null {
  const lastBoardCompany = lastBoardPrefix
    ? (companies.find((company) => company.issuePrefix.toUpperCase() === lastBoardPrefix.toUpperCase()) ?? null)
    : null;

  return lastBoardCompany ?? selectedCompany ?? companies[0] ?? null;
}
