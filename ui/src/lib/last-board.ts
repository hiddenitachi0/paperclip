// Tracks the company prefix of the board the operator was last actually
// looking at, independent of `selectedCompany` (which is a manually-chosen
// preference that Layout deliberately stops syncing from the route after a
// manual switch — see shouldSyncCompanySelectionFromRoute). Bare board URLs
// (e.g. a bookmarked `/skills`) need the former, not the latter, or they can
// silently redirect into a different company than the one the URL was
// actually opened from (DUR-3933).
const STORAGE_KEY = "paperclip.lastBoardPrefix";

export function getLastBoardPrefix(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLastBoardPrefix(prefix: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, prefix.toUpperCase());
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc.)
  }
}
