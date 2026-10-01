import { and, eq, sql } from "drizzle-orm";
import { approvals, projects, type Db } from "@paperclipai/db";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { DEPLOY_SUCCESS_MARKER, extractDeployedCommit } from "./deploy-completion-gate.js";

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

function isSuccessfulDeploy(entry: DeployRunnerStatusEntry): boolean {
  return entry.outcome !== "carried" && entry.outcome !== "started" && entry.body.includes(DEPLOY_SUCCESS_MARKER);
}

// DUR-4271: "fail" counterpart to isSuccessfulDeploy. "started" and
// "waiting_for_checks" are interim log lines written while a deploy is still
// in flight -- the approval's own terminal line (success or failure) follows
// later, so neither counts as a failure on its own. "carried" means the
// approval's target commit already shipped under a *different* approval; it
// is a no-op, not a failed attempt. Everything else that isn't a recorded
// success is a terminal failure: a rejected approval, a CI timeout, a failed
// build/health-check, or any other "Deploy failed/stopped/not started" line.
function isFailedDeploy(entry: DeployRunnerStatusEntry): boolean {
  if (entry.outcome === "started" || entry.outcome === "waiting_for_checks" || entry.outcome === "carried") return false;
  return !isSuccessfulDeploy(entry);
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

export type ProjectDeployHistoryStatus = "pass" | "fail";

export type ProjectDeployHistoryListEntry = {
  commit: string | null;
  approvalId: string;
  deployedAt: string;
  status: ProjectDeployHistoryStatus;
};

export type ProjectDeployHistoryListFilters = {
  status?: ProjectDeployHistoryStatus;
  /** Inclusive lower bound on deployedAt, epoch milliseconds. */
  fromMs?: number;
  /** Inclusive upper bound on deployedAt, epoch milliseconds. */
  toMs?: number;
};

// DUR-4271: parses a `from`/`to` query param (a bare date like "2026-09-01"
// or a full ISO timestamp) into epoch milliseconds for comparison against a
// status-log line's `ts`. A bare date is anchored to UTC midnight for `from`
// and the last instant of that day for `to`, so "to=2026-09-01" includes
// everything that happened on that day rather than excluding it outright.
// Returns null for unparseable input so the route can 400 instead of
// silently ignoring a typo'd filter.
export function parseDateBoundary(raw: string, endOfDay: boolean): number | null {
  const hasTime = /t/i.test(raw);
  const iso = hasTime ? raw : `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * DUR-4271: the same project-scoped window as selectProjectDeployHistory,
 * but keeps every terminal attempt -- pass AND fail -- instead of only the
 * ones that ended up live, and applies the optional status/date filters.
 * `cap` is a hard ceiling on how many *matching* entries this ever
 * collects, independent of whatever paging the caller applies on top: a
 * filter or a deep page must never read further back into the log than the
 * project's own release-retention window allows.
 */
export function selectProjectDeployHistoryEntries(
  entries: DeployRunnerStatusEntry[],
  projectApprovalIds: ReadonlySet<string>,
  filters: ProjectDeployHistoryListFilters,
  cap: number,
): ProjectDeployHistoryListEntry[] {
  const newestFirst: ProjectDeployHistoryListEntry[] = [];
  for (let i = entries.length - 1; i >= 0 && newestFirst.length < cap; i -= 1) {
    const entry = entries[i]!;
    if (!projectApprovalIds.has(entry.approvalId)) continue;
    const status: ProjectDeployHistoryStatus | null = isSuccessfulDeploy(entry) ? "pass" : isFailedDeploy(entry) ? "fail" : null;
    if (!status) continue;
    if (filters.status && status !== filters.status) continue;
    if (filters.fromMs !== undefined || filters.toMs !== undefined) {
      const ms = Date.parse(entry.ts);
      if (filters.fromMs !== undefined && ms < filters.fromMs) continue;
      if (filters.toMs !== undefined && ms > filters.toMs) continue;
    }
    newestFirst.push({ commit: extractDeployedCommit(entry), approvalId: entry.approvalId, deployedAt: entry.ts, status });
  }
  return newestFirst;
}

export type ProjectDeployHistoryListResult = {
  items: ProjectDeployHistoryListEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

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

async function resolveProjectDeployContext(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ approvalIds: Set<string>; retention: number }> {
  const [approvalIds, projectRow] = await Promise.all([
    listProjectDeployApprovalIds(db, companyId, projectId),
    db
      .select({ deployPolicy: projects.deployPolicy })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0]),
  ]);
  return { approvalIds, retention: resolveReleaseRetentionCount(projectRow?.deployPolicy) };
}

type ReadStatusLog = (companyId: string, limit: number) => DeployRunnerStatusEntry[];

export async function readProjectDeployHistory(
  db: Db,
  companyId: string,
  projectId: string,
  deps: { readStatusLog?: ReadStatusLog } = {},
): Promise<ProjectDeployHistory> {
  const readStatusLog = deps.readStatusLog ?? ((cid: string, limit: number) => readDeployRunnerStatus(cid, limit));

  const { approvalIds, retention } = await resolveProjectDeployContext(db, companyId, projectId);
  const statusLogLimit = Math.min(5000, retention * STATUS_LOG_LINES_PER_RELEASE);
  const releases = selectProjectDeployHistory(readStatusLog(companyId, statusLogLimit), approvalIds, retention);

  return { current: releases[0] ?? null, previous: releases[1] ?? null, releases };
}

/**
 * DUR-4271: the paged, filterable sibling of readProjectDeployHistory. Reuses
 * the same approval-id/retention resolution and status-log window, but
 * returns every terminal attempt (pass and fail) and applies the caller's
 * filters/paging on top -- `cap` (the project's release-retention count) is
 * still the hard ceiling on how many matching entries exist to page through.
 */
export async function readProjectDeployHistoryList(
  db: Db,
  companyId: string,
  projectId: string,
  filters: ProjectDeployHistoryListFilters,
  paging: { limit: number; offset: number },
  deps: { readStatusLog?: ReadStatusLog } = {},
): Promise<ProjectDeployHistoryListResult> {
  const readStatusLog = deps.readStatusLog ?? ((cid: string, limit: number) => readDeployRunnerStatus(cid, limit));

  const { approvalIds, retention } = await resolveProjectDeployContext(db, companyId, projectId);
  const statusLogLimit = Math.min(5000, retention * STATUS_LOG_LINES_PER_RELEASE);
  const matched = selectProjectDeployHistoryEntries(readStatusLog(companyId, statusLogLimit), approvalIds, filters, retention);

  const limit = Math.max(1, Math.min(paging.limit, retention));
  const offset = Math.max(0, Math.min(paging.offset, matched.length));
  const items = matched.slice(offset, offset + limit);

  return { items, total: matched.length, limit, offset, hasMore: offset + items.length < matched.length };
}
