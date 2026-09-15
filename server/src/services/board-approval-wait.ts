import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  approvals,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// DUR-3979 part 5: "waiting only on the operator's decision on an approval".
//
// NOR-1437 sat on one pending deploy approval for three days. Tech Boss posted
// 20 comments, 15 of them "still waiting for the board", each stating a made-up
// waiting time, and Paperclip's own recovery sweeps kept waking it (continuation
// wake-ups, "needs a disposition" notices, "escalating to a normal-sized run").
//
// This module is the ONE place that answers "is this issue waiting only on a
// board approval, with nothing else for its agent to do?". The stranded-issue
// sweep, the run-liveness continuation, cheap-run escalation and the timer idle
// gate all ask it before waking the agent, and the wake payload uses the same
// answer to show the approval's real age.
//
// An issue is waiting only on a board approval when ALL of these hold:
//   1. at least one approval linked to it (issue_approvals, same company) is
//      `pending`;
//   2. no linked approval is `revision_requested` -- the operator sent that one
//      back, so the agent has work to do (and nothing wakes it for that);
//   3. the issue exists, is not hidden, is open (todo / in_progress /
//      in_review / blocked) and is owned by an agent, not a person;
//   4. no execution-policy stage (review / approval by a participant) is pending;
//   5. no issue-thread interaction (question, confirmation, ...) is pending;
//   6. no issue blocks it that is still open;
//   7. it has no open child issue;
//   8. nobody else -- a person or another agent -- has commented since the
//      later of the newest pending approval and the assignee's own latest
//      comment. Paperclip's own system notices do not count.
// Anything else (and any doubt) means "not waiting only on an approval".
//
// FAIL-OPEN, deliberately: an error answers "not waiting", so every caller
// behaves exactly as it did before this module existed. A missed quiet period
// costs one extra run; a false "waiting" could leave real work asleep.
//
// Waking on the decision is untouched: approving or rejecting still wakes the
// requesting agent (routes/approvals.ts), and once the approval is no longer
// pending this answers "not waiting" again, so the sweeps resume on their next
// tick for any assignee the decision wake did not reach.

export const BOARD_APPROVAL_WAIT_OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

const LINKED_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const MAX_APPROVAL_TITLE_CHARS = 200;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const BOARD_APPROVAL_WAIT_NOT_WAITING_REASONS = [
  "no_pending_approval",
  "approval_sent_back",
  "issue_not_found",
  "issue_not_open",
  "not_agent_owned",
  "execution_stage_pending",
  "pending_interaction",
  "unresolved_blocker",
  "open_child_issue",
  "unanswered_comment",
  "check_failed",
] as const;
export type BoardApprovalWaitNotWaitingReason = (typeof BOARD_APPROVAL_WAIT_NOT_WAITING_REASONS)[number];

export interface PendingBoardApproval {
  id: string;
  type: string;
  title: string;
  createdAt: Date;
}

export type BoardApprovalWait =
  | { waiting: true; approvals: PendingBoardApproval[] }
  | { waiting: false; reason: BoardApprovalWaitNotWaitingReason; approvals: PendingBoardApproval[] };

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function approvalTitle(type: string, payload: unknown): string {
  const record = readRecord(payload);
  for (const key of ["title", "plainSummary", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const trimmed = value.trim().replace(/\s+/g, " ");
      return trimmed.length > MAX_APPROVAL_TITLE_CHARS ? `${trimmed.slice(0, MAX_APPROVAL_TITLE_CHARS - 3)}...` : trimmed;
    }
  }
  return type.replace(/_/g, " ");
}

/**
 * Decides whether an issue is waiting only on a pending board approval.
 * Never throws: an error returns { waiting: false, reason: "check_failed" }.
 */
export async function evaluateBoardApprovalWait(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<BoardApprovalWait> {
  try {
    return await evaluate(db, input);
  } catch (error) {
    logger.warn(
      { err: error, companyId: input.companyId, issueId: input.issueId },
      "board approval wait: check failed, treating the issue as not waiting",
    );
    return { waiting: false, reason: "check_failed", approvals: [] };
  }
}

export async function isIssueWaitingOnlyOnBoardApproval(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<boolean> {
  return (await evaluateBoardApprovalWait(db, input)).waiting;
}

async function evaluate(db: Db, input: { companyId: string; issueId: string }): Promise<BoardApprovalWait> {
  const { companyId, issueId } = input;
  const notWaiting = (reason: BoardApprovalWaitNotWaitingReason, pending: PendingBoardApproval[]): BoardApprovalWait => ({
    waiting: false,
    reason,
    approvals: pending,
  });

  // Cheapest check first: almost every issue has no open linked approval.
  const linked = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      status: approvals.status,
      payload: approvals.payload,
      createdAt: approvals.createdAt,
    })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(issueApprovals.companyId, companyId),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.companyId, companyId),
        inArray(approvals.status, [...LINKED_APPROVAL_STATUSES]),
      ),
    )
    .orderBy(asc(approvals.createdAt));

  const pending: PendingBoardApproval[] = linked
    .filter((row) => row.status === "pending")
    .map((row) => ({
      id: row.id,
      type: row.type,
      title: approvalTitle(row.type, row.payload),
      createdAt: new Date(row.createdAt),
    }));
  if (pending.length === 0) return notWaiting("no_pending_approval", []);
  if (linked.some((row) => row.status === "revision_requested")) return notWaiting("approval_sent_back", pending);

  const issue = await db
    .select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
      hiddenAt: issues.hiddenAt,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.hiddenAt) return notWaiting("issue_not_found", pending);
  if (!(BOARD_APPROVAL_WAIT_OPEN_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
    return notWaiting("issue_not_open", pending);
  }
  const assigneeAgentId = issue.assigneeAgentId;
  if (!assigneeAgentId || issue.assigneeUserId) return notWaiting("not_agent_owned", pending);
  if (readRecord(issue.executionState).status === "pending") return notWaiting("execution_stage_pending", pending);

  const [interaction, blocker, child, ownLatestComment] = await Promise.all([
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.parentId, issueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, assigneeAgentId),
          isNull(issueComments.deletedAt),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (interaction) return notWaiting("pending_interaction", pending);
  if (blocker) return notWaiting("unresolved_blocker", pending);
  if (child) return notWaiting("open_child_issue", pending);

  const newestApprovalMs = Math.max(...pending.map((approval) => approval.createdAt.getTime()));
  const ownLatestMs = ownLatestComment ? new Date(ownLatestComment.createdAt).getTime() : Number.NEGATIVE_INFINITY;
  const answeredUpTo = new Date(Math.max(newestApprovalMs, ownLatestMs));
  const unanswered = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        gt(issueComments.createdAt, answeredUpTo),
        or(
          sql`${issueComments.authorUserId} is not null`,
          sql`(${issueComments.authorAgentId} is not null and ${issueComments.authorAgentId} <> ${assigneeAgentId}::uuid)`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (unanswered) return notWaiting("unanswered_comment", pending);

  return { waiting: true, approvals: pending };
}

/** "15 Sep 16:40 UTC" (the year is added when it is not the current one). */
export function formatBoardApprovalWaitingSince(createdAt: Date, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = createdAt.getUTCFullYear() !== now.getUTCFullYear() ? ` ${createdAt.getUTCFullYear()}` : "";
  return `${createdAt.getUTCDate()} ${MONTHS[createdAt.getUTCMonth()]}${year} ${pad(createdAt.getUTCHours())}:${pad(createdAt.getUTCMinutes())} UTC`;
}

/** "5 h 32 min", "45 min", "2 d 3 h", "less than 1 min". */
export function formatBoardApprovalAge(ageMs: number): string {
  const totalMinutes = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60_000)) : 0;
  if (totalMinutes < 1) return "less than 1 min";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

export interface BoardApprovalWaitContextApproval {
  id: string;
  type: string;
  title: string;
  createdAt: string;
  waitingSince: string;
  age: string;
  ageMinutes: number;
}

/**
 * The wake-payload form (paperclipWake.boardApprovalWait): every pending
 * approval linked to the issue with its real age, computed from
 * approvals.created_at at the moment the run starts. Rendered for the agent
 * by renderPaperclipBoardApprovalWaitLines in adapter-utils.
 */
export interface BoardApprovalWaitContext {
  waitingOnlyOnBoardApproval: boolean;
  approvals: BoardApprovalWaitContextApproval[];
}

export function buildBoardApprovalWaitContext(
  wait: BoardApprovalWait,
  now: Date = new Date(),
): BoardApprovalWaitContext | null {
  if (wait.approvals.length === 0) return null;
  return {
    waitingOnlyOnBoardApproval: wait.waiting,
    approvals: wait.approvals.map((approval) => {
      const ageMs = now.getTime() - approval.createdAt.getTime();
      return {
        id: approval.id,
        type: approval.type,
        title: approval.title,
        createdAt: approval.createdAt.toISOString(),
        waitingSince: formatBoardApprovalWaitingSince(approval.createdAt, now),
        age: formatBoardApprovalAge(ageMs),
        ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
      };
    }),
  };
}
