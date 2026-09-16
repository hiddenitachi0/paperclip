import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_NEEDS_YOU_STALLED_AFTER_HOURS,
  type AssigneeUnavailableReason,
  type IssueStatus,
  type StalledTask,
  type StalledTaskReason,
  type StalledTasksResult,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { classifyAssigneePickup } from "./assignee-pickup.js";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { instanceSettingsService } from "./instance-settings.js";
import { describeAssigneeUnavailableState } from "./operator-notices.js";

// The Now page's fifth "Needs you" source: open work nobody is moving.
//
// The other four sources all mean "something is actively asking you": a live
// run flagged for follow-up, an actionable approval, a blocked task Paperclip
// attributes to you, a pending question card. An agent that ends its run and
// writes "awaiting operator verification" as an ordinary comment matches none
// of them, so the task simply stops -- on production, eight open tasks sat
// like that, the oldest since 9 September, with nothing on screen saying so.
//
// This deliberately stays a *determinable* source, not the loose "parked
// task" heuristic ui/src/lib/task-waiting.ts warns against. Every row here is
// either a task whose assignee provably cannot run, or a task where nothing
// at all has happened for longer than the operator's own threshold.

/**
 * Statuses considered. `backlog` is left out on purpose -- an unstarted idea
 * list is not work that stopped -- and so is `blocked`, which the page
 * already shows through its blocked-task source and its Parked panel. Keeping
 * `blocked` out is also what guarantees this source can never double-report a
 * task that is already visible there.
 */
const CANDIDATE_STATUSES = ["todo", "in_progress", "in_review"] as const;

/** A run in any of these means somebody IS moving the task right now. */
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/** Approval states the Now page already renders as an actionable row. */
const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

/** A queued wake-up is work about to start, even with no run row yet. */
const PENDING_WAKEUP_STATUSES = ["queued", "deferred_issue_execution"] as const;

/**
 * Reading or filing a task in your own inbox is not progress on it, so these
 * must not reset the clock. Mirrors ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS in
 * services/issues.ts, which computes the same "last activity" for the board.
 */
const LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

/** Bounded: the page polls every 5s, so this query must stay cheap. */
export const STALLED_TASK_CANDIDATE_LIMIT = 300;
export const STALLED_TASK_RESPONSE_LIMIT = 50;

/** "13 September" -- the operator reads a date, not a timestamp. */
function formatSince(at: Date): string {
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

function agentLabel(name: string | null): string {
  return name?.trim() ? name.trim() : "the assigned agent";
}

/**
 * The whole operator-facing sentence. Reuses the reviewed wording in
 * operator-notices.ts for the "agent cannot run" half so the Now page and the
 * Activity feed can never describe the same situation differently.
 */
export function buildStalledReasonText(input: {
  reason: StalledTaskReason;
  agentName: string | null;
  unavailableReason: AssigneeUnavailableReason | null;
  sinceAt: Date;
}): string {
  const since = formatSince(input.sinceAt);
  switch (input.reason) {
    case "assignee_unavailable":
      return (
        `Nobody is working on this — `
        + `${describeAssigneeUnavailableState(input.agentName, input.unavailableReason ?? "unknown_status")}. `
        + `Waiting since ${since}.`
      );
    case "assignee_error":
      return `Nobody is working on this — ${agentLabel(input.agentName)} has hit an error and needs a look. Waiting since ${since}.`;
    case "unassigned":
      return `Nobody is assigned to this. Waiting since ${since}.`;
    case "idle_in_review":
      return `Finished and waiting for you since ${since}.`;
    case "idle":
    default:
      return `Nothing has happened on this since ${since}.`;
  }
}

export function stalledTasksService(db: Db) {
  const settings = instanceSettingsService(db);

  return {
    listForCompany: async (companyId: string): Promise<StalledTasksResult> => {
      const general = await settings.getGeneral();
      const stalledAfterHours =
        general.needsYouStalledAfterHours ?? DEFAULT_NEEDS_YOU_STALLED_AFTER_HOURS;
      const empty: StalledTasksResult = { tasks: [], totalCount: 0, stalledAfterHours };

      const company = await db
        .select({ status: companies.status })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      // A paused or archived company is a decision the operator already made.
      // Its tasks are meant to be standing still; saying so would be noise.
      if (company.status !== "active") return empty;

      const candidates = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          executionRunId: issues.executionRunId,
          checkoutRunId: issues.checkoutRunId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, [...CANDIDATE_STATUSES]),
            isNull(issues.hiddenAt),
          ),
        )
        .limit(STALLED_TASK_CANDIDATE_LIMIT);

      if (candidates.length === 0) return empty;
      const issueIds = candidates.map((row) => row.id);

      const [
        activeRuns,
        wakeups,
        pendingInteractions,
        linkedApprovals,
        payloadApprovals,
        commentRows,
        activityRows,
        agentRows,
      ] = await Promise.all([
        db
          .select({
            id: heartbeatRuns.id,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            ),
          ),
        db
          .select({ issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'` })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              inArray(agentWakeupRequests.status, [...PENDING_WAKEUP_STATUSES]),
            ),
          ),
        db
          .select({ issueId: issueThreadInteractions.issueId })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.companyId, companyId),
              eq(issueThreadInteractions.status, "pending"),
              inArray(issueThreadInteractions.issueId, issueIds),
            ),
          ),
        db
          .select({ issueId: issueApprovals.issueId })
          .from(issueApprovals)
          .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
          .where(
            and(
              eq(issueApprovals.companyId, companyId),
              inArray(issueApprovals.issueId, issueIds),
              inArray(approvals.status, [...ACTIONABLE_APPROVAL_STATUSES]),
            ),
          ),
        db
          .select({ issueId: sql<string | null>`${approvals.payload} ->> 'issueId'` })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, companyId),
              inArray(approvals.status, [...ACTIONABLE_APPROVAL_STATUSES]),
            ),
          ),
        db
          .select({
            issueId: issueComments.issueId,
            latest: sql<Date | null>`MAX(${issueComments.createdAt})`,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, companyId),
              inArray(issueComments.issueId, issueIds),
              isNull(issueComments.deletedAt),
            ),
          )
          .groupBy(issueComments.issueId),
        db
          .select({
            issueId: activityLog.entityId,
            latest: sql<Date | null>`MAX(${activityLog.createdAt})`,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, issueIds),
              sql`${activityLog.action} NOT IN (${sql.join(
                LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
                sql`, `,
              )})`,
            ),
          )
          .groupBy(activityLog.entityId),
        db
          .select({
            id: agents.id,
            companyId: agents.companyId,
            name: agents.name,
            reportsTo: agents.reportsTo,
            status: agents.status,
            pauseReason: agents.pauseReason,
            runtimeConfig: agents.runtimeConfig,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
      ]);

      // --- Anything already visible through another source drops out here. ---
      const activeRunIds = new Set<string>();
      const busyIssueIds = new Set<string>();
      for (const run of activeRuns) {
        activeRunIds.add(run.id);
        if (run.issueId) busyIssueIds.add(run.issueId);
      }
      for (const wakeup of wakeups) {
        if (wakeup.issueId) busyIssueIds.add(wakeup.issueId);
      }

      const pendingAskIssueIds = new Set<string>();
      for (const row of pendingInteractions) pendingAskIssueIds.add(row.issueId);
      for (const row of linkedApprovals) pendingAskIssueIds.add(row.issueId);
      for (const row of payloadApprovals) {
        if (row.issueId) pendingAskIssueIds.add(row.issueId);
      }

      // --- When did each task last actually move? ---
      const lastActivity = new Map<string, Date>();
      const bump = (issueId: string, at: Date | string | null | undefined) => {
        if (!at) return;
        const value = at instanceof Date ? at : new Date(at);
        if (Number.isNaN(value.getTime())) return;
        const current = lastActivity.get(issueId);
        if (!current || value.getTime() > current.getTime()) lastActivity.set(issueId, value);
      };
      for (const row of candidates) bump(row.id, row.updatedAt);
      for (const row of commentRows) bump(row.issueId, row.latest);
      for (const row of activityRows) bump(row.issueId, row.latest);

      const agentById = new Map(agentRows.map((row) => [row.id, row]));
      const quietMode = general.quietMode;
      const thresholdMs = stalledAfterHours * 60 * 60 * 1000;
      const now = Date.now();

      const rows: StalledTask[] = [];
      for (const candidate of candidates) {
        if (busyIssueIds.has(candidate.id)) continue;
        if (candidate.executionRunId && activeRunIds.has(candidate.executionRunId)) continue;
        if (candidate.checkoutRunId && activeRunIds.has(candidate.checkoutRunId)) continue;
        if (pendingAskIssueIds.has(candidate.id)) continue;

        const sinceAt = lastActivity.get(candidate.id) ?? candidate.updatedAt;
        const agent = candidate.assigneeAgentId
          ? agentById.get(candidate.assigneeAgentId) ?? null
          : null;

        let reason: StalledTaskReason | null = null;
        let unavailableReason: AssigneeUnavailableReason | null = null;
        // An unassigned task still has to go quiet before it counts: a task
        // created and assigned a minute later must never flash up here.
        let requiresIdle = false;

        if (agent) {
          if (agent.status === "error") {
            reason = "assignee_error";
          } else {
            const pickup = classifyAssigneePickup({
              agent,
              invokability: evaluateAgentInvokability(agent, agentRows),
              companyActive: true,
              quietMode: { active: quietMode.active, snapshot: quietMode.snapshot ?? null },
            });
            // Only a genuine "a person must do something" blocks pickup here.
            // held_by_quiet_mode / company_inactive / cannot_wake_unconfirmed
            // are deliberately NOT reported: quiet mode is on most nights, and
            // reporting it would put the whole board in this lane every night.
            if (pickup.kind === "unavailable") {
              reason = "assignee_unavailable";
              unavailableReason = pickup.reason;
            }
          }
        } else if (!candidate.assigneeUserId) {
          reason = "unassigned";
          requiresIdle = true;
        }

        const isIdle = now - sinceAt.getTime() >= thresholdMs;
        if (!reason) {
          if (!isIdle) continue;
          reason = candidate.status === "in_review" ? "idle_in_review" : "idle";
        } else if (requiresIdle && !isIdle) {
          continue;
        }

        rows.push({
          issueId: candidate.id,
          identifier: candidate.identifier,
          title: candidate.title,
          status: candidate.status as IssueStatus,
          reason,
          reasonText: buildStalledReasonText({
            reason,
            agentName: agent?.name ?? null,
            unavailableReason,
            sinceAt,
          }),
          sinceAt: sinceAt.toISOString(),
          agentName: agent?.name ?? null,
        });
      }

      // Longest-waiting first: the one that has been ignored since 9 September
      // is the one the operator most needs to see.
      rows.sort((left, right) => left.sinceAt.localeCompare(right.sinceAt));

      return {
        tasks: rows.slice(0, STALLED_TASK_RESPONSE_LIMIT),
        totalCount: rows.length,
        stalledAfterHours,
      };
    },
  };
}
