import { and, eq, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
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

export function approvalPayloadKind(payload: unknown): string | null {
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

// DUR-237: the merge_pr approval's own merge commit sha, backfilled asynchronously onto
// `payload.mergeCommitSha` by merge-deploy-visibility.ts once it confirms via GitHub that the PR
// actually merged. Undefined until that check has run (or if it never resolved to a merge).
function approvalPayloadMergeCommitSha(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const sha = (payload as Record<string, unknown>).mergeCommitSha;
  return typeof sha === "string" && sha.length >= 7 ? sha : null;
}

const COMMIT_IN_BODY = /\bcommit ([0-9a-f]{7,40})\b/i;

// A runner-log entry's own `commit` structured field is only reliably populated for a "carried"
// outcome (DUR-152) or, after DUR-237's deploy-runner.sh change, a fresh success. Older success
// entries only ever wrote the commit into the free-text body ("... commit abc1234 is live and
// healthy ...") -- fall back to parsing that so this doesn't only work going forward.
function extractDeployedCommit(entry: DeployRunnerStatusEntry): string | null {
  if (entry.commit) return entry.commit;
  const match = entry.body.match(COMMIT_IN_BODY);
  return match ? match[1] : null;
}

// Both sides may be a short or full sha (deploy-runner.sh logs `git rev-parse --short HEAD`;
// GitHub's API returns the full 40-char sha) -- treat them as the same commit when one is a
// prefix of the other, requiring at least 7 hex chars so this can't degrade into a near-empty-
// string match.
function commitsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length < 7 || b.length < 7) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

/**
 * DUR-237: every OTHER approved `deploy` approval filed for this same project, regardless of
 * which issue (if any) it happens to be linked to. The narrow per-issue check above only ever
 * sees approvals linked to THIS issue -- but the same commit routinely ships as a side effect of
 * a sibling issue's deploy (or a deploy filed with no issue link at all), and this issue's own
 * merge is then left waiting on a deploy approval that will never come because the code is
 * already live. Widening the search to "approved for this project" (not "linked to this issue")
 * is what lets the gate recognize that.
 */
async function listApprovedProjectDeployApprovalIds(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "request_board_approval"),
        eq(approvals.status, "approved"),
        sql`${approvals.payload} ->> 'kind' = 'deploy'`,
        sql`${approvals.payload} ->> 'projectId' = ${projectId}`,
      ),
    );
  return rows.map((row) => row.id);
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
  let statusEntries: DeployRunnerStatusEntry[] | null = null;
  const getStatusEntries = () => {
    if (statusEntries === null) statusEntries = readStatusLog(input.issue.companyId);
    return statusEntries;
  };

  const completed =
    deployApprovals.length > 0 &&
    deployApprovalCompletedInStatusLog(
      deployApprovals.map((approval) => approval.id),
      getStatusEntries(),
    );
  if (completed) return null;

  // DUR-237: this issue has no completed deploy approval OF ITS OWN, but its merge commit may
  // already be live because it shipped as part of a DIFFERENT issue's deploy (or a deploy filed
  // with no issue link at all) -- the actual NOR-217 failure mode. Only reachable once
  // merge-deploy-visibility.ts has backfilled the merge commit sha; until then this is a no-op
  // and the existing narrow behavior above is unchanged.
  const mergeCommitSha = mergeApprovals
    .map((approval) => approvalPayloadMergeCommitSha(approval.payload))
    .find((sha): sha is string => sha !== null);
  if (mergeCommitSha) {
    const projectDeployApprovalIds = await listApprovedProjectDeployApprovalIds(
      input.db,
      input.issue.companyId,
      branches.projectId,
    );
    const shippedUnderAnotherApproval = projectDeployApprovalIds.some((approvalId) => {
      const entry = getStatusEntries().find(
        (candidate) =>
          candidate.approvalId === approvalId &&
          (candidate.body.includes(DEPLOY_SUCCESS_MARKER) || candidate.outcome === "carried"),
      );
      return entry ? commitsMatch(mergeCommitSha, extractDeployedCommit(entry)) : false;
    });
    if (shippedUnderAnotherApproval) return null;
  }

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
