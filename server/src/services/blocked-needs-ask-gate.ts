import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  approvals,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * DUR-3993: an agent may not park a task as `blocked` on the operator without
 * giving the operator a way to answer.
 *
 * What happened: a task needed six answers from the operator. The agent wrote
 * the six questions into an ordinary comment and set the task to `blocked`.
 * The Now page's "Needs you" lane then showed the task as "Nobody is assigned
 * to this" with no answer box, because nothing structured said who had to do
 * what. A question card (issue-thread interaction `ask_user_questions` /
 * `request_confirmation`) already renders with an answer box and takes the
 * task out of the stalled lane; the agent just never filed one.
 *
 * So an AGENT moving an issue INTO `blocked` is refused unless at least one of
 * these structured "way forward" signals exists:
 *   1. an unresolved blocking issue (an existing `blocks` relation whose
 *      blocker is not done, or a not-done issue named in `blockedByIssueIds`
 *      in this same update) -- "waiting for another task" stays allowed;
 *   2. a pending issue-thread interaction (question card) on the issue;
 *   3. a pending / revision-requested approval linked to the issue (via
 *      issue_approvals, or naming it as payload.issueId);
 *   4. the documented "External owner:" + "External action:" description
 *      markers (skills/paperclip/SKILL.md) -- a party outside the company
 *      cannot answer a question card, and the operator cannot answer for them.
 *
 * The route additionally lets through a cheap run whose DUR-45 escalation cap
 * is used up (that path already told the operator the issue needs them) and a
 * low-trust review agent (denied every surface this gate would point it to).
 *
 * Never gates a board user, a delegate or any non-agent actor, never gates an
 * issue that is already `blocked`, and FAILS OPEN: any unexpected error is
 * logged and the transition goes through, exactly as before this gate existed.
 */

const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

export interface BlockedNeedsAskGateInput {
  db: Db;
  issue: { id: string; identifier: string | null; companyId: string; description: string | null };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  /** `blockedByIssueIds` from the same request, when present (replaces the stored blockers). */
  requestedBlockedByIssueIds: unknown;
  /** `description` from the same request, when present. */
  requestedDescription: unknown;
}

function hasExternalOwnerMarkers(description: string | null): boolean {
  if (!description) return false;
  return /^\s*external owner\s*:\s*\S/im.test(description) && /^\s*external action\s*:\s*\S/im.test(description);
}

export function blockedNeedsAskMessage(identifier: string | null): string {
  const label = identifier ?? "This task";
  return (
    `${label} can't be set to blocked yet, because nothing on it tells the operator what you need from them: ` +
    "it would sit in their Needs-you list as \"nobody is assigned\" with no way to answer. " +
    "If you need the operator to answer or decide something, file a question card on this task first " +
    "(POST /api/issues/{issueId}/interactions with kind \"ask_user_questions\" for questions, or " +
    "\"request_confirmation\" for a yes/no decision), then set the status again. Questions written only in a " +
    "comment do not count. If this task is waiting for another task to finish, link that task as the blocker " +
    "in the same update (\"blockedByIssueIds\"). If it waits on an approval, link the approval to this task " +
    "(\"issueIds\" when filing it). If it waits on someone outside the company, put \"External owner:\" and " +
    "\"External action:\" lines at the top of the description."
  );
}

export async function evaluateBlockedNeedsAskGate(
  input: BlockedNeedsAskGateInput,
): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "blocked") return null;
  if (input.currentStatus === "blocked") return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  try {
    if (await hasWayForward(input)) return null;
    return { message: blockedNeedsAskMessage(input.issue.identifier) };
  } catch (error) {
    logger.warn(
      { err: error, issueId: input.issue.id, companyId: input.issue.companyId, agentId: input.actor.agentId },
      "blocked-needs-ask gate: check failed, letting the blocked transition through",
    );
    return null;
  }
}

async function hasWayForward(input: BlockedNeedsAskGateInput): Promise<boolean> {
  const { db } = input;
  const { id: issueId, companyId } = input.issue;

  const description =
    typeof input.requestedDescription === "string" || input.requestedDescription === null
      ? (input.requestedDescription as string | null)
      : input.issue.description;
  if (hasExternalOwnerMarkers(description)) return true;

  // 1. Unresolved blocking issue. A blockedByIssueIds array in this same
  //    request replaces the stored blockers, so it is the one that counts.
  if (Array.isArray(input.requestedBlockedByIssueIds)) {
    const requestedIds = input.requestedBlockedByIssueIds.filter(
      (value): value is string => typeof value === "string" && value.length > 0 && value !== issueId,
    );
    if (requestedIds.length > 0) {
      const openBlockers = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, requestedIds), ne(issues.status, "done")))
        .limit(1);
      if (openBlockers.length > 0) return true;
    }
  } else {
    const openBlockers = await db
      .select({ id: issues.id })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          ne(issues.status, "done"),
        ),
      )
      .limit(1);
    if (openBlockers.length > 0) return true;
  }

  // 2. Pending question card (any pending issue-thread interaction; every kind
  //    is answered by the operator in the issue thread).
  const pendingInteractions = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingInteractions.length > 0) return true;

  // 3. Open approval linked to the issue, either through issue_approvals or by
  //    naming it in its payload (the same two links the Now page reads).
  const linkedApprovals = await db
    .select({ id: approvals.id })
    .from(approvals)
    .leftJoin(
      issueApprovals,
      and(eq(issueApprovals.approvalId, approvals.id), eq(issueApprovals.issueId, issueId)),
    )
    .where(
      and(
        eq(approvals.companyId, companyId),
        inArray(approvals.status, [...OPEN_APPROVAL_STATUSES]),
        or(
          eq(issueApprovals.issueId, issueId),
          sql`${approvals.payload} ->> 'issueId' = ${issueId}`,
        ),
      ),
    )
    .limit(1);
  return linkedApprovals.length > 0;
}
