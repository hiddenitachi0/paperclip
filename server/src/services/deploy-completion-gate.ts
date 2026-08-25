import type { Db } from "@paperclipai/db";
import { resolveProjectDeployBranches } from "./deploy-branches.js";
import { issueApprovalService } from "./issue-approvals.js";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";

/**
 * DUR-99: "done" must mean running, not merely merged. DUR-98's Class C evidence was four
 * incidents in one morning where an issue whose only completing action was a merge into the
 * deploy branch was marked `done` with no deploy ever following — once a 35-commit gap
 * including two security fixes. DUR-40/DUR-46 shipped after-the-fact visibility (a comment
 * noting the gap) but never stopped the transition itself. This is the synchronous gate that
 * does.
 *
 * Scope, deliberately narrow (mirrors the "don't block issues that never touch a deploy
 * branch" acceptance criterion):
 * - Only fires for an AGENT-authored transition into `done` (a board/human actor can always
 *   override — this guards agent self-certification, not operator authority, the same split
 *   self-review-gate.ts and goal-condition-judge.ts already draw).
 * - Only fires when the issue has an approved `merge_pr` approval linked to it whose
 *   `payload.base` matches the project's declared `deployPolicy.deployBranch` (DUR-40). An
 *   issue with no such approval never touches this gate at all.
 * - "Completed" is read from the deploy-runner's own status log (`deploy-runner-status.ts`,
 *   DUR-44/109's own manual-verification workaround made durable) rather than an approval's
 *   `status`, because `approved` only means the operator authorized a deploy — DUR-46 already
 *   established elsewhere in this codebase that authorization is not proof of execution. A
 *   linked `deploy` approval whose id appears in the runner's log with its success sentence is
 *   the strongest same-request signal available without an extra DB column; see the file's
 *   docblock for the known coupling this creates.
 * - A candidate `deploy` approval must also carry `payload.projectId` matching the issue's own
 *   project (DUR-116 adversarial review finding #2): `assertCanManageIssueApprovalLinks` lets an
 *   agent link any same-company approved deploy approval to any issue, so without this check a
 *   completed deploy for project A could be borrowed to clear the gate on an unrelated merge in
 *   project B.
 *
 * Explicitly NOT attempted here: verifying the merge_pr's PR actually merged via GitHub (that
 * network round trip belongs in a scheduled tick, not a synchronous PATCH — see
 * merge-deploy-visibility.ts's own docblock for why), and inventing a new `issues.status`
 * literal for "merged, awaiting deploy" (blast radius: the closed ISSUE_STATUSES enum backs
 * partial unique indexes and UI status columns). The escape hatch this gate leaves open is the
 * one already in wide use across this board: leave the issue in `in_review` (optionally with
 * an `external_service` monitor watching deploy-runner) until a deploy completes.
 */

const DEPLOY_SUCCESS_MARKER = "is live and healthy";

function approvalPayloadKind(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const kind = (payload as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function approvalPayloadBase(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const base = (payload as Record<string, unknown>).base;
  return typeof base === "string" ? base : null;
}

function approvalPayloadProjectId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const projectId = (payload as Record<string, unknown>).projectId;
  return typeof projectId === "string" ? projectId : null;
}

/**
 * True when at least one of the given deploy-approval ids has a runner-log entry recording
 * either (a) a successful deploy of that exact approval — matched on `scripts/deploy-runner.sh`'s
 * success sentence ("... is live and healthy ...", DUR-44), not a structured status field, because
 * none existed on the approval row for this case (see this file's top docblock) — or (b)
 * `outcome: "carried"` (DUR-152): the approval was superseded by (or lost the backward-deploy
 * guard race to) a *different* approval, but deploy-runner independently confirmed via
 * `git merge-base --is-ancestor` that this approval's own target commit already shipped as part
 * of that other deploy. Without (b), a superseded approval's comment can never contain the
 * literal success sentence (see the deploy-runner.sh test asserting exactly that — a skipped
 * deploy must never read like a successful one) and so could never satisfy this gate, leaving
 * whoever is waiting on it stuck forever even though its change is genuinely live.
 */
function deployApprovalCompletedInStatusLog(
  deployApprovalIds: string[],
  statusEntries: DeployRunnerStatusEntry[],
): boolean {
  if (deployApprovalIds.length === 0) return false;
  const idSet = new Set(deployApprovalIds);
  return statusEntries.some(
    (entry) =>
      idSet.has(entry.approvalId) &&
      (entry.body.includes(DEPLOY_SUCCESS_MARKER) || entry.outcome === "carried"),
  );
}

export interface DeployCompletionGateInput {
  db: Db;
  issue: { id: string; identifier: string | null; companyId: string };
  actor: { actorType: string; agentId: string | null; runId: string | null };
  requestedStatus: string | undefined;
  currentStatus: string;
  readStatusLog?: (companyId: string) => DeployRunnerStatusEntry[];
}

export async function evaluateDeployCompletionDoneGate(
  input: DeployCompletionGateInput,
): Promise<{ message: string } | null> {
  if (input.requestedStatus !== "done") return null;
  if (input.currentStatus === "done") return null;
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  const branches = await resolveProjectDeployBranches(input.db, [input.issue.id]);
  if (!branches?.deployBranch) return null;

  const linked = await issueApprovalService(input.db).listApprovalsForIssue(input.issue.id);

  const mergeApprovals = linked.filter(
    (approval) =>
      approval.type === "request_board_approval" &&
      approval.status === "approved" &&
      approvalPayloadKind(approval.payload) === "merge_pr" &&
      approvalPayloadBase(approval.payload) === branches.deployBranch,
  );
  // This issue's completing action was never a merge into the declared deploy branch — the
  // acceptance criterion "do not block issues that never touch a deploy branch" applies.
  if (mergeApprovals.length === 0) return null;

  const deployApprovals = linked.filter(
    (approval) =>
      approval.type === "request_board_approval" &&
      approval.status === "approved" &&
      approvalPayloadKind(approval.payload) === "deploy" &&
      // DUR-116: an agent with approval-link authority can link ANY same-company approved
      // deploy approval to this issue, including one filed for a different project. Without
      // this check a completed deploy for project A would clear the gate for an unrelated
      // merge in project B.
      approvalPayloadProjectId(approval.payload) === branches.projectId,
  );

  const readStatusLog = input.readStatusLog ?? ((companyId: string) => readDeployRunnerStatus(companyId));
  const statusEntries = deployApprovals.length > 0 ? readStatusLog(input.issue.companyId) : [];
  const completed = deployApprovalCompletedInStatusLog(
    deployApprovals.map((approval) => approval.id),
    statusEntries,
  );
  if (completed) return null;

  const issueLabel = input.issue.identifier ?? "This issue";
  const message =
    deployApprovals.length === 0
      ? `${issueLabel}'s completing action was a merge into "${branches.deployBranch}", the branch this ` +
        "project deploys from, but no deploy approval has been filed for it yet. File the deploy approval " +
        "and leave this in in_review until it completes -- a merge alone does not mean the change is live."
      : `${issueLabel}'s completing action was a merge into "${branches.deployBranch}", the branch this ` +
        "project deploys from, and a deploy approval has been filed, but deploy-runner has not yet recorded " +
        "it completing. Leave this in in_review until deploy-runner confirms it's live -- an approved deploy " +
        "approval is not proof the change actually deployed.";

  return { message };
}
