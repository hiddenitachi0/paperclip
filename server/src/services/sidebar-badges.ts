import { and, desc, eq, inArray, isNull, not, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];
// DUR-62: the weekly check-up report. Kept as a literal so this small service
// does not pull the check-up service into its import graph.
const ORGANIZATION_CHECKUP_ORIGIN_KIND = "organization_checkup";
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: {
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) =>
          rows.filter((row) => !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)).length
        );

      const latestRunByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          id: heartbeatRuns.id,
          runStatus: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(agents.companyId, companyId),
            not(eq(agents.status, "terminated")),
          ),
        )
        .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus)
        && !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      ).length;

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;

      // DUR-62: one badge for "the weekly check-up has suggestions you have
      // not decided on yet". An open report whose accept card is still
      // pending counts as 1; a report without a card (nothing found), or one
      // the board already accepted or rejected, counts as 0.
      const checkups = await db
        .select({ id: issues.id })
        .from(issues)
        .innerJoin(
          issueThreadInteractions,
          and(
            eq(issueThreadInteractions.issueId, issues.id),
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.kind, "suggest_tasks"),
            eq(issueThreadInteractions.status, "pending"),
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, ORGANIZATION_CHECKUP_ORIGIN_KIND),
            isNull(issues.hiddenAt),
            notInArray(issues.status, CLOSED_ISSUE_STATUSES),
          ),
        )
        .limit(1)
        .then((rows) => (rows.length > 0 ? 1 : 0));

      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues + checkups,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
        checkups,
      };
    },
  };
}
