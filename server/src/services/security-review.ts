/**
 * DUR-4566: the security-review state of a `kind: "merge_pr"` approval, and
 * the actions that move it along.
 *
 * Filip's trigger: a merge card reached him before Security Reviewer 2 had
 * ever actually started working on it -- SR2 was only @-mentioned in a
 * comment, which does nothing because a review agent only acts on tasks
 * assigned to it. This module makes "has a review actually started/finished,
 * for the code on this card right now" a real, computed fact instead of a
 * comment nobody is watching.
 *
 * State is always computed from `merge_security_reviews`, never cached on the
 * approval payload: the newest row for an approval is the current state, and
 * a `passed`/`failed` row whose `headCommit` no longer matches the approval's
 * current `payload.commit` reads as `out_of_date` -- a later push on the same
 * PR invalidates a prior pass without deleting the review history.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companySecurityReviewSettings,
  issues,
  mergeSecurityReviews,
} from "@paperclipai/db";
import type { SecurityReviewState } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";

export function isMergePrApprovalPayload(payload: unknown): payload is Record<string, unknown> {
  return Boolean(payload) && typeof payload === "object" && (payload as Record<string, unknown>).kind === "merge_pr";
}

/** The approval's own notion of "the PR's current head commit" -- see `stripUntrustedMergeCommitSha` in routes/approvals.ts for why this, and only this, field is trusted. */
export function mergePrHeadCommit(payload: Record<string, unknown>): string | null {
  const commit = typeof payload.commit === "string" ? payload.commit.trim() : "";
  return commit ? commit : null;
}

function mergePrLinkText(payload: Record<string, unknown>): string {
  const repo = typeof payload.repo === "string" ? payload.repo.trim() : "";
  const prNumber = payload.prNumber;
  if (repo && (typeof prNumber === "number" || typeof prNumber === "string")) {
    return `https://github.com/${repo}/pull/${prNumber}`;
  }
  const pr = typeof payload.pr === "string" ? payload.pr.trim() : "";
  return pr || "(no PR link on this card)";
}

export function securityReviewService(db: Db) {
  async function getApproval(approvalId: string) {
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    return row ?? null;
  }

  async function getReviewerAgentId(companyId: string): Promise<string | null> {
    const [row] = await db
      .select({ securityReviewerAgentId: companySecurityReviewSettings.securityReviewerAgentId })
      .from(companySecurityReviewSettings)
      .where(eq(companySecurityReviewSettings.companyId, companyId));
    return row?.securityReviewerAgentId ?? null;
  }

  async function latestReviewRow(approvalId: string) {
    const [row] = await db
      .select()
      .from(mergeSecurityReviews)
      .where(eq(mergeSecurityReviews.approvalId, approvalId))
      .orderBy(desc(mergeSecurityReviews.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The plain-words state this card currently shows. Not restricted to merge_pr cards, but every other kind always reads as `not_requested` with no head commit. */
  async function computeState(approval: { id: string; companyId: string; payload: unknown }): Promise<SecurityReviewState> {
    const empty: SecurityReviewState = {
      state: "not_requested",
      headCommit: null,
      reviewIssueId: null,
      reviewIssueIdentifier: null,
      verdictNote: null,
      verdictCommentUrl: null,
      decidedAt: null,
      priorState: null,
    };
    if (!isMergePrApprovalPayload(approval.payload)) return empty;
    const currentHead = mergePrHeadCommit(approval.payload);
    const row = await latestReviewRow(approval.id);
    if (!row) {
      const reviewerAgentId = await getReviewerAgentId(approval.companyId);
      return reviewerAgentId
        ? { ...empty, headCommit: currentHead }
        : { ...empty, state: "no_reviewer_configured", headCommit: currentHead };
    }

    let reviewIssueIdentifier: string | null = null;
    if (row.reviewIssueId) {
      const [issueRow] = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(eq(issues.id, row.reviewIssueId));
      reviewIssueIdentifier = issueRow?.identifier ?? null;
    }

    const stale = currentHead !== null && row.headCommit !== currentHead;
    if (row.status === "requested") {
      // An in-progress review targeting a now-stale head is still "in
      // progress" from the operator's point of view (nothing has reached a
      // verdict yet); it is not "out of date" until it actually resolves.
      return {
        state: "in_progress",
        headCommit: row.headCommit,
        reviewIssueId: row.reviewIssueId,
        reviewIssueIdentifier,
        verdictNote: null,
        verdictCommentUrl: null,
        decidedAt: null,
        priorState: null,
      };
    }

    const decided = row.status === "passed" || row.status === "failed" ? row.status : null;
    if (stale && decided) {
      return {
        state: "out_of_date",
        headCommit: row.headCommit,
        reviewIssueId: row.reviewIssueId,
        reviewIssueIdentifier,
        verdictNote: row.verdictNote,
        verdictCommentUrl: row.verdictCommentUrl,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        priorState: decided,
      };
    }

    return {
      state: decided ?? "not_requested",
      headCommit: row.headCommit,
      reviewIssueId: row.reviewIssueId,
      reviewIssueIdentifier,
      verdictNote: row.verdictNote,
      verdictCommentUrl: row.verdictCommentUrl,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      priorState: null,
    };
  }

  /**
   * DUR-4566 item 2: the "Request security review" button. Single-flight via
   * `merge_security_reviews_open_request_uq` -- a second call for the same
   * approval at the same head commit while one is already `requested` hits
   * that unique index and is treated as "already open", not a new task.
   */
  async function requestReview(
    approvalId: string,
    actor: { agentId: string | null; userId: string | null },
  ): Promise<SecurityReviewState> {
    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");
    if (!isMergePrApprovalPayload(approval.payload)) {
      throw unprocessable("Only a merge card can have a security review requested.");
    }
    const payload = approval.payload as Record<string, unknown>;
    const headCommit = mergePrHeadCommit(payload);
    if (!headCommit) {
      throw unprocessable("This card has no commit yet, so a review cannot be requested.");
    }
    const reviewerAgentId = await getReviewerAgentId(approval.companyId);
    if (!reviewerAgentId) {
      throw unprocessable(
        "No security reviewer agent is set for this company yet -- choose one in company settings first.",
      );
    }

    const existing = await latestReviewRow(approvalId);
    if (existing && existing.status === "requested" && existing.headCommit === headCommit) {
      return computeState(approval);
    }

    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "this merge";
    const reviewIssue = await issueService(db).create(approval.companyId, {
      title: `Security review: ${title}`,
      description:
        `Please review the code for this merge card before it is approved.\n\n` +
        `What it's for: ${title}\n` +
        `Pull request: ${mergePrLinkText(payload)}\n` +
        `Head commit: ${headCommit}\n\n` +
        `Open the pull request on GitHub to see the full list of changed files. ` +
        `Record your verdict (passed / needs changes) against this exact commit -- ` +
        `a later push on the same PR makes any earlier verdict out of date.`,
      status: "todo",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      originFingerprint: `security-review:${approvalId}:${headCommit}`,
      createdByAgentId: actor.agentId ?? undefined,
      createdByUserId: actor.userId ?? undefined,
    } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
    if (!reviewIssue) throw unprocessable("Could not create the security review task");

    try {
      await db.insert(mergeSecurityReviews).values({
        companyId: approval.companyId,
        approvalId,
        reviewIssueId: reviewIssue.id,
        headCommit,
        status: "requested",
        requestedByAgentId: actor.agentId,
        requestedByUserId: actor.userId,
      });
    } catch (err) {
      // Single-flight race: someone else's request landed first for this
      // exact (approval, head commit) pair between our read and our write.
      // The review issue above was already created before we lost the race
      // -- cancel it so the reviewer isn't left with a duplicate task for
      // the same (approval, head commit) pair (DUR-4568 finding #4).
      if (isUniqueViolation(err)) {
        await issueService(db).update(reviewIssue.id, { status: "cancelled" });
        return computeState(approval);
      }
      throw err;
    }

    await issueApprovalService(db).linkManyForApproval(approvalId, [reviewIssue.id], actor);

    return computeState(approval);
  }

  /**
   * DUR-4566 item 3: only the company's designated security reviewer agent,
   * or a board user, may record a verdict -- and never the approval's own
   * requester (an agent cannot review its own PR).
   */
  async function recordVerdict(
    approvalId: string,
    actor: { agentId: string | null; userId: string | null },
    input: { verdict: "passed" | "failed"; note: string; commentUrl?: string },
  ): Promise<SecurityReviewState> {
    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");
    if (!isMergePrApprovalPayload(approval.payload)) {
      throw unprocessable("Only a merge card can have a security review verdict.");
    }
    const payload = approval.payload as Record<string, unknown>;
    const headCommit = mergePrHeadCommit(payload);
    if (!headCommit) {
      throw unprocessable("This card has no commit yet, so a verdict cannot be recorded against it.");
    }

    if (actor.agentId) {
      const reviewerAgentId = await getReviewerAgentId(approval.companyId);
      if (!reviewerAgentId || reviewerAgentId !== actor.agentId) {
        throw forbidden("Only this company's designated security reviewer agent may record a verdict.");
      }
      if (approval.requestedByAgentId && approval.requestedByAgentId === actor.agentId) {
        throw forbidden("An agent cannot record a security review verdict on its own merge card.");
      }
    } else if (!actor.userId) {
      throw forbidden("Only the security reviewer agent or a board user may record a verdict.");
    } else if (approval.requestedByUserId && approval.requestedByUserId === actor.userId) {
      // DUR-4568 finding #3: the self-review block above only covered the
      // agent path. A board user who filed this exact merge card must not
      // be able to record "passed" on it either.
      throw forbidden("A user cannot record a security review verdict on their own merge card.");
    }

    const [agentRow] = actor.agentId
      ? await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, actor.agentId))
      : [null];
    if (actor.agentId && agentRow?.companyId !== approval.companyId) {
      throw forbidden("A security reviewer may only record verdicts for its own company.");
    }

    const existing = await latestReviewRow(approvalId);
    const now = new Date();
    if (existing && existing.status === "requested" && existing.headCommit === headCommit) {
      await db
        .update(mergeSecurityReviews)
        .set({
          status: input.verdict,
          reviewerAgentId: actor.agentId,
          reviewerUserId: actor.userId,
          verdictNote: input.note,
          verdictCommentUrl: input.commentUrl ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(mergeSecurityReviews.id, existing.id));
    } else {
      await db.insert(mergeSecurityReviews).values({
        companyId: approval.companyId,
        approvalId,
        headCommit,
        status: input.verdict,
        reviewerAgentId: actor.agentId,
        reviewerUserId: actor.userId,
        verdictNote: input.note,
        verdictCommentUrl: input.commentUrl ?? null,
        decidedAt: now,
      });
    }

    return computeState(approval);
  }

  return { computeState, requestReview, recordVerdict, getReviewerAgentId };
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

export type SecurityReviewService = ReturnType<typeof securityReviewService>;
