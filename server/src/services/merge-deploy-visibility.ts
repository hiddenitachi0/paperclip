import { and, eq, lte, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { resolveProjectDeployBranches } from "./deploy-branches.js";

/**
 * How long to wait after a merge_pr approval into a project's declared deploy
 * branch before flagging a missing deploy approval. Gives the filing agent's
 * run a reasonable window to file the deploy approval itself (per the DUR-40
 * standing delivery rule: "after any merge into the deploy branch, either
 * file the deploy approval in the same run or record on the issue why you
 * are deliberately deferring") before the system assumes it was forgotten.
 */
export const MERGE_DEPLOY_VISIBILITY_DELAY_MS = 30 * 60 * 1000;

/**
 * DUR-40 item 4: DUR-38 was marked `done` after its merge_pr approval landed
 * on the deploy branch, but no deploy approval was ever filed, so the
 * feature never went live — and nothing on the issue said so. This service
 * closes that gap with a scheduled check (the same shape as the issue
 * monitor / scheduled-retry mechanisms elsewhere in this codebase, but
 * intentionally NOT wired into `tickDueIssueMonitors` / `IssueExecutionMonitorPolicy`:
 * that machinery exists to wake an assigned agent to go investigate
 * something external, and requires a strict `kind` ("external_service" |
 * "goal_condition") plus an in-progress/in-review agent-assigned issue. A
 * passive "did a deploy approval follow this merge" check has none of those
 * preconditions, so it gets its own tiny periodic tick — the same pattern
 * `routines.tickScheduledTriggers` already uses alongside `heartbeat.tickTimers`
 * in server/src/index.ts, rather than forcing a second, incompatible concern
 * into the issue-monitor union).
 *
 * Scheduling state lives entirely on the approval row itself
 * (`payload.deployVisibilityNoted`), so no new columns/migrations are needed.
 */
export function mergeDeployVisibilityService(db: Db, options: { delayMs?: number } = {}) {
  const delayMs = options.delayMs ?? MERGE_DEPLOY_VISIBILITY_DELAY_MS;
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);

  async function markNoted(approvalId: string, payload: Record<string, unknown>) {
    await db
      .update(approvals)
      .set({ payload: { ...payload, deployVisibilityNoted: true }, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
  }

  async function hasFollowingDeployApproval(issueIds: string[]): Promise<boolean> {
    for (const issueId of issueIds) {
      const linked = await issueApprovalsSvc.listApprovalsForIssue(issueId);
      const hasDeployApproval = linked.some(
        (approval) =>
          approval.type === "request_board_approval" &&
          (approval.payload as Record<string, unknown> | null)?.kind === "deploy" &&
          approval.status !== "rejected",
      );
      if (hasDeployApproval) return true;
    }
    return false;
  }

  async function tick(now = new Date()) {
    const cutoff = new Date(now.getTime() - delayMs);
    const dueApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
          sql`${approvals.payload} ->> 'kind' = 'merge_pr'`,
          sql`(${approvals.payload} ->> 'deployVisibilityNoted') is distinct from 'true'`,
          sql`${approvals.decidedAt} is not null`,
          lte(approvals.decidedAt, cutoff),
        ),
      )
      .limit(50);

    let checked = 0;
    let flagged = 0;

    for (const approval of dueApprovals) {
      checked += 1;
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      const base = typeof payload.base === "string" ? payload.base.trim() : "";

      const linkedIssues = base
        ? await issueApprovalsSvc.listIssuesForApproval(approval.id)
        : [];
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);

      if (base && linkedIssueIds.length > 0) {
        const branches = await resolveProjectDeployBranches(db, linkedIssueIds);
        if (branches?.deployBranch && base === branches.deployBranch) {
          const alreadyDeployed = await hasFollowingDeployApproval(linkedIssueIds);
          if (!alreadyDeployed) {
            flagged += 1;
            for (const issueId of linkedIssueIds) {
              await issuesSvc.addComment(
                issueId,
                `This merged into "${branches.deployBranch}", the branch we deploy from, over ` +
                  `${Math.round(delayMs / 60000)} minutes ago. No deploy approval has been filed for ` +
                  "it yet, so it has not gone live.",
                {},
                { authorType: "system" },
              );
            }
          }
        }
      }

      await markNoted(approval.id, payload);
    }

    return { checked, flagged };
  }

  return { tick };
}
