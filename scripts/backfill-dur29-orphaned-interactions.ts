// DUR-29: agents were filing a request_board_approval AND a request_confirmation for the same
// merge/deploy decision. The operator answers the approval, the work ships, and the interaction
// is left pending forever — a ghost in the "needs you" list. Going forward, closing an issue
// auto-resolves any interaction still pending on it (see issueService(db).update()), but that
// hook only fires on future transitions. This script sweeps every company for issues that are
// already done/cancelled and still carry pending interactions, and resolves them the same way.
//
// Run with: tsx scripts/backfill-dur29-orphaned-interactions.ts [--company <companyId>] [--apply]
// Without --apply, it only reports what it would resolve.
import { and, eq, inArray } from "drizzle-orm";
import { companies, createDb, issueThreadInteractions, issues } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueThreadInteractionService } from "../server/src/services/issue-thread-interactions.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl, "paperclip-script-backfill-dur29-orphaned-interactions");
  const interactionsSvc = issueThreadInteractionService(db);
  const companyId = parseFlag("--company");
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to backfill.");
    return;
  }

  console.log(
    `Scanning ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"} for done/cancelled `
      + `issues with pending interactions (${apply ? "APPLY" : "dry run"})...`,
  );

  let totalResolved = 0;
  for (const company of companyRows) {
    const closedIssuesWithPending = await db
      .selectDistinct({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
      })
      .from(issues)
      .innerJoin(issueThreadInteractions, eq(issueThreadInteractions.issueId, issues.id))
      .where(and(
        eq(issues.companyId, company.id),
        inArray(issues.status, ["done", "cancelled"]),
        eq(issueThreadInteractions.status, "pending"),
      ));

    if (closedIssuesWithPending.length === 0) continue;

    console.log(`- company ${company.id}: ${closedIssuesWithPending.length} closed issue(s) with pending interactions`);
    for (const issue of closedIssuesWithPending) {
      if (!apply) {
        console.log(`    [dry-run] would resolve pending interactions on ${issue.identifier ?? issue.id} (${issue.status})`);
        continue;
      }
      const resolved = await interactionsSvc.resolveAllPendingForIssueClosed(
        { id: issue.id, companyId: company.id, status: issue.status },
        { agentId: null, userId: null },
      );
      totalResolved += resolved.length;
      console.log(`    resolved ${resolved.length} interaction(s) on ${issue.identifier ?? issue.id} (${issue.status})`);
    }
  }

  console.log(apply ? `Done. Resolved ${totalResolved} orphaned interaction(s).` : "Dry run complete. Re-run with --apply to resolve.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DUR-29 orphaned interaction backfill failed: ${message}`);
  process.exitCode = 1;
});
