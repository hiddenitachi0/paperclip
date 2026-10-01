import { and, eq, sql } from "drizzle-orm";
import { approvals, projects, type Db } from "@paperclipai/db";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { extractDeployedCommit, resolveDeployedStatus, type DeployOutcomeStatus } from "./deploy-completion-gate.js";

// DUR-4162: how many past releases readProjectDeployHistory returns when a
// project's deploy_policy.releaseRetentionCount is unset. Mirrors the bound
// enforced by releaseRetentionCount's own validator (packages/shared).
export const DEFAULT_RELEASE_RETENTION_COUNT = 10;
const MAX_RELEASE_RETENTION_COUNT = 50;
// Each retained release can take several status-log lines ("started", one or
// more health-probe retries, the terminal outcome), so the status log read
// must cover comfortably more lines than the release count it is meant to
// resolve.
const STATUS_LOG_LINES_PER_RELEASE = 40;

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
  /**
   * DUR-4233: "ok" for a clean deploy, "needs_attention" when the app itself checked out fine
   * but the runner's TLS/domain check flagged something a rollback would not fix. Never
   * "failed" here -- a failed attempt never reaches `selectProjectDeployHistory` at all (see
   * `resolveDeployedStatus`), so this list only ever holds versions that were genuinely live.
   */
  status: Exclude<DeployOutcomeStatus, "failed">;
};

export type ProjectDeployHistory = {
  /** The version live right now, per the runner's most recent successful deploy. */
  current: ProjectDeployHistoryEntry | null;
  /** The version that was live before `current` -- the rollback target. */
  previous: ProjectDeployHistoryEntry | null;
  /**
   * DUR-4162: up to the project's configured release-retention count
   * (default DEFAULT_RELEASE_RETENTION_COUNT), newest first. `releases[0]`
   * and `releases[1]` are always the same entries as `current`/`previous` --
   * the two older fields are kept so existing callers (the one-step-back
   * rollback button) don't need to change.
   */
  releases: ProjectDeployHistoryEntry[];
};

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
    const status = resolveDeployedStatus(entry);
    if (!status) continue;
    const commit = extractDeployedCommit(entry);
    if (!commit) continue;
    const last = newestFirst[newestFirst.length - 1];
    if (last && commitsRefer(last.commit, commit)) continue;
    newestFirst.push({ commit, approvalId: entry.approvalId, deployedAt: entry.ts, status });
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

/**
 * DUR-4162: clamps a project's deploy_policy.releaseRetentionCount to the
 * same [1, 50] bound its validator enforces (packages/shared), and falls
 * back to DEFAULT_RELEASE_RETENTION_COUNT when unset or invalid -- a
 * malformed value already stored in a policy JSON blob must not crash a
 * history read.
 */
export function resolveReleaseRetentionCount(deployPolicy: Record<string, unknown> | null | undefined): number {
  const raw = deployPolicy?.releaseRetentionCount;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_RELEASE_RETENTION_COUNT;
  return Math.min(MAX_RELEASE_RETENTION_COUNT, Math.max(1, Math.floor(raw)));
}

export async function readProjectDeployHistory(
  db: Db,
  companyId: string,
  projectId: string,
  deps: { readStatusLog?: (companyId: string, limit: number) => DeployRunnerStatusEntry[] } = {},
): Promise<ProjectDeployHistory> {
  const readStatusLog = deps.readStatusLog ?? ((cid: string, limit: number) => readDeployRunnerStatus(cid, limit));

  const [approvalIds, projectRow] = await Promise.all([
    listProjectDeployApprovalIds(db, companyId, projectId),
    db
      .select({ deployPolicy: projects.deployPolicy })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0]),
  ]);

  const retention = resolveReleaseRetentionCount(projectRow?.deployPolicy);
  const statusLogLimit = Math.min(5000, retention * STATUS_LOG_LINES_PER_RELEASE);
  const releases = selectProjectDeployHistory(readStatusLog(companyId, statusLogLimit), approvalIds, retention);

  return { current: releases[0] ?? null, previous: releases[1] ?? null, releases };
}
