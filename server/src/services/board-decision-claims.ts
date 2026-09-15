import type { Db } from "@paperclipai/db";
import { AGENT_BOARD_DECISION_CLAIM_ACTION, detectBoardDecisionClaim } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity as defaultLogActivity } from "./activity-log.js";

export interface AgentCommentForBoardDecisionCheck {
  companyId: string;
  issueId: string;
  issueIdentifier?: string | null;
  commentId: string;
  body: string;
  actorType: string;
  agentId?: string | null;
  runId?: string | null;
}

/**
 * Agents cannot decide approvals. When an agent-authored comment reads like a
 * board decision ("## Board Decision: APPROVED", "Styrevedtak: godkjent"),
 * record ONE activity row so it is visible and searchable. The comment itself
 * is never blocked or changed: this is fail-open on purpose — a missed flag is
 * a gap, a blocked legitimate status update would wedge the agent (rule 5).
 * Returns whether a row was recorded.
 */
export async function flagAgentBoardDecisionClaim(
  db: Db,
  input: AgentCommentForBoardDecisionCheck,
  deps: { logActivity?: typeof defaultLogActivity } = {},
): Promise<boolean> {
  if (input.actorType !== "agent" || !input.agentId) return false;
  const claim = detectBoardDecisionClaim(input.body);
  if (!claim) return false;
  try {
    await (deps.logActivity ?? defaultLogActivity)(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "board-decision-claims",
      agentId: input.agentId,
      runId: input.runId ?? null,
      action: AGENT_BOARD_DECISION_CLAIM_ACTION,
      entityType: "issue",
      entityId: input.issueId,
      details: {
        commentId: input.commentId,
        identifier: input.issueIdentifier ?? null,
        claimedOutcome: claim.outcome,
        claimLine: claim.line,
      },
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, commentId: input.commentId },
      "failed to record an agent comment that claims a board decision",
    );
    return false;
  }
}
