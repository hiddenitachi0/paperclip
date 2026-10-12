import type { OverlapSummary } from "../api/overlaps";

/** What the two tasks clash on, in one plain sentence. */
export function overlapWhat(o: Pick<OverlapSummary, "kind" | "detail">): string {
  const file = typeof o.detail.file === "string" ? o.detail.file : null;
  const number = typeof o.detail.migrationNumber === "string" ? o.detail.migrationNumber : null;
  switch (o.kind) {
    case "migration_number":
      return `Both want database change number ${number ?? "(unknown)"}`;
    case "journal_json":
      return "Both change the list of database changes";
    case "stale_behind":
      return `${file ?? "A file"} was already changed by finished work since this task started`;
    default:
      return `Both change the file ${file ?? "(unknown)"}`;
  }
}

/** What to do about it. Advice only; nothing is blocked. */
export function overlapAdvice(o: Pick<OverlapSummary, "kind">): string {
  switch (o.kind) {
    case "migration_number":
      return "Let one task finish first. The other should then pick the next free number.";
    case "stale_behind":
      return "Bring this task up to date with the latest work before going on.";
    default:
      return "Let one task finish first. The other should then update its work and carry on.";
  }
}

export function openOverlapsForIssue(overlaps: OverlapSummary[], issueId: string): OverlapSummary[] {
  return overlaps.filter((o) => o.issueA.id === issueId || o.issueB.id === issueId);
}
