import { and, eq, sql } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { DEPLOY_SUCCESS_MARKER, extractDeployedCommit } from "./deploy-completion-gate.js";

/**
 * DUR-3952 follow-up (operator rollback button): which versions of a project
 * have actually been live, read straight from scripts/deploy-runner.sh's
 * status log rather than from what was approved. Only a runner line that
 * reports a real, health-checked deploy counts ("... is live and healthy",
 * the same sentence deploy-completion-gate.ts trusts); "carried" outcomes
 * are skipped because the commit they name shipped under a *different*
 * approval, whose own success line is the one that shows up here.
 *
 * The status log has no projectId on its lines -- it only knows approval ids
 * -- so the caller maps this company's approved deploy approvals for the
 * project first (`listProjectDeployApprovalIds`) and hands the id set in.
 */
export type ProjectDeployHistoryEntry = {
  /** Short (12-char) or full sha, exactly as the runner logged it. */
  commit: string;
  approvalId: string;
  deployedAt: string;
};

export type ProjectDeployHistory = {
  /** The version live right now, per the runner's most recent successful deploy. */
  current: ProjectDeployHistoryEntry | null;
  /** The version that was live before `current` -- the rollback target. */
  previous: ProjectDeployHistoryEntry | null;
};

function isSuccessfulDeploy(entry: DeployRunnerStatusEntry): boolean {
  return entry.outcome !== "carried" && entry.outcome !== "started" && entry.body.includes(DEPLOY_SUCCESS_MARKER);
}

/**
 * Pure selection: walks the runner log oldest -> newest, keeps only this
 * project's successful deploys, and returns the most recent distinct
 * versions newest-first. Re-deploying the same commit twice in a row does
 * not create a "previous version" of itself, so a rollback never targets
 * what is already live.
 */
export function selectProjectDeployHistory(
  entries: DeployRunnerStatusEntry[],
  projectApprovalIds: ReadonlySet<string>,
  limit = 2,
): ProjectDeployHistoryEntry[] {
  const newestFirst: ProjectDeployHistoryEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && newestFirst.length < limit; i -= 1) {
    const entry = entries[i]!;
    if (!projectApprovalIds.has(entry.approvalId)) continue;
    if (!isSuccessfulDeploy(entry)) continue;
    const commit = extractDeployedCommit(entry);
    if (!commit) continue;
    const last = newestFirst[newestFirst.length - 1];
    if (last && commitsRefer(last.commit, commit)) continue;
    newestFirst.push({ commit, approvalId: entry.approvalId, deployedAt: entry.ts });
  }
  return newestFirst;
}

// Same-commit test for consecutive log lines: one may be a prefix of the other
// (the runner has logged both 7- and 12-char short shas over time).
function commitsRefer(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 7 && longer.toLowerCase().startsWith(shorter.toLowerCase());
}

export async function listProjectDeployApprovalIds(db: Db, companyId: string, projectId: string): Promise<Set<string>> {
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
  return new Set(rows.map((row) => row.id));
}

export async function readProjectDeployHistory(
  db: Db,
  companyId: string,
  projectId: string,
  deps: { readStatusLog?: (companyId: string) => DeployRunnerStatusEntry[] } = {},
): Promise<ProjectDeployHistory> {
  const readStatusLog = deps.readStatusLog ?? ((cid: string) => readDeployRunnerStatus(cid, 500));
  const approvalIds = await listProjectDeployApprovalIds(db, companyId, projectId);
  const [current = null, previous = null] = selectProjectDeployHistory(readStatusLog(companyId), approvalIds, 2);
  return { current, previous };
}
