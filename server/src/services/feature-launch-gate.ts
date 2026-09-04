import type { Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { approvalPayloadKind } from "./deploy-completion-gate.js";

/**
 * DUR-313 (DUR-299 point 2): "when a feature is finished, file ONE issue, in plain
 * language, saying what's new, where to find it, what to test, and what happens if
 * it fails — that's the issue the operator approves, not the merges that preceded
 * it." This gate is what makes that mandatory rather than a convention: an issue
 * explicitly marked `featureLaunch` (see assertFeatureLaunchFieldAllowed in
 * server/src/routes/issues.ts for who may set/clear that flag) cannot move to
 * `done` without an approved `feature_launch` approval linked to it.
 *
 * Deliberately narrow, mirroring evaluateDeployCompletionDoneGate:
 * - Only fires for an AGENT-authored transition into `done` — a board/human actor
 *   can always override, same self-certification-vs-operator-authority split every
 *   other done-gate in this file draws.
 * - Only fires when the issue is actually marked `featureLaunch` (or being marked
 *   `featureLaunch: true` in this same request). Bugfixes and internal cleanup
 *   (DUR-299 points 7-8) are never tagged this way, so they never touch this gate —
 *   the scope-vs-flaskehals tradeoff the operator explicitly called out.
 * - Fails closed: no linked approved `feature_launch` approval means no `done`,
 *   full stop. There is no ancestry/best-effort fallback like the deploy gate's
 *   DUR-237 widening — a launch card is either filed and approved, or it isn't.
 */
export interface FeatureLaunchGateInput {
  db: Db;
  issue: { id: string; identifier: string | null; featureLaunch: boolean };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  requestedFeatureLaunch: boolean | undefined;
}

export async function evaluateFeatureLaunchDoneGate(
  input: FeatureLaunchGateInput,
): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "done") return null;
  if (input.currentStatus === "done") return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  const isFeatureLaunch = input.requestedFeatureLaunch ?? input.issue.featureLaunch;
  if (!isFeatureLaunch) return null;

  const linked = await issueApprovalService(input.db).listApprovalsForIssue(input.issue.id);
  const hasApprovedLaunchCard = linked.some(
    (approval) =>
      approval.type === "request_board_approval" &&
      approval.status === "approved" &&
      approvalPayloadKind(approval.payload) === "feature_launch",
  );
  if (hasApprovedLaunchCard) return null;

  const issueLabel = input.issue.identifier ?? "This issue";
  return {
    message:
      `${issueLabel} is marked as a user-facing feature launch (DUR-299 point 2) and cannot move to ` +
      "done without an approved feature_launch approval telling the operator what's new, where to find " +
      "it, what to test, and what to do if it fails. File that approval (request_board_approval, " +
      "payload.kind: \"feature_launch\", linked to this issue) and leave this in in_review until the " +
      "operator approves it — the preceding merges are not the decision the operator makes here.",
  };
}
