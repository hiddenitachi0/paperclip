import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, budgetPolicies, companies, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import type { DashboardPulse } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { readDeployRunnerStatus, type DeployRunnerStatusEntry } from "./deploy-runner-status.js";
import { isCompletedDeployOutcome } from "./deploy-completion-gate.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const PULSE_LIST_LIMIT = 10;
const PULSE_DEPLOYS_LIMIT = 10;
const PULSE_RECENT_COMPLETION_WINDOW_HOURS = 12;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function getUtcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isSuccessfulDeployEntry(entry: DeployRunnerStatusEntry): boolean {
  return isCompletedDeployOutcome(entry);
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export type DashboardServiceDeps = {
  readDeployStatusLog?: (companyId: string) => DeployRunnerStatusEntry[];
};

export function dashboardService(db: Db, deps: DashboardServiceDeps = {}) {
  const budgets = budgetService(db);
  const readDeployStatusLog = deps.readDeployStatusLog ?? ((companyId: string) => readDeployRunnerStatus(companyId, 300));
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },

    // DUR-4199: one call for the pulse top-bar panel (parent DUR-4154) --
    // needs-you approvals by type, live executions, recent completions,
    // today's spend vs the company's daily budget policy (if one is
    // configured), and recent deploy approvals cross-referenced against the
    // deploy runner's own status log for real "is it actually live" state.
    pulse: async (companyId: string): Promise<DashboardPulse> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const now = new Date();
      const dayStart = getUtcDayStart(now);
      const recentCompletionSince = new Date(
        now.getTime() - PULSE_RECENT_COMPLETION_WINDOW_HOURS * 60 * 60 * 1000,
      );

      const approvalTypeCountRows = await db
        .select({
          type: approvals.type,
          kind: sql<string | null>`${approvals.payload} ->> 'kind'`,
          count: sql<number>`count(*)`,
        })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .groupBy(approvals.type, sql`${approvals.payload} ->> 'kind'`);

      const needsYouByType: Record<string, number> = {};
      let needsYouCount = 0;
      for (const row of approvalTypeCountRows) {
        const category = row.type === "request_board_approval" ? (row.kind ?? "general") : row.type;
        const count = Number(row.count);
        needsYouByType[category] = (needsYouByType[category] ?? 0) + count;
        needsYouCount += count;
      }

      const pendingApprovalRows = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          payload: approvals.payload,
          requestedByAgentId: approvals.requestedByAgentId,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt))
        .limit(PULSE_LIST_LIMIT);

      const activeExecutionRows = await db
        .select({
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          title: issues.title,
          agentId: issues.assigneeAgentId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNotNull(issues.executionRunId)))
        .orderBy(desc(issues.updatedAt))
        .limit(PULSE_LIST_LIMIT);

      const recentCompletionRows = await db
        .select({
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          title: issues.title,
          agentId: issues.assigneeAgentId,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            gte(issues.completedAt, recentCompletionSince),
          ),
        )
        .orderBy(desc(issues.completedAt))
        .limit(PULSE_LIST_LIMIT);

      const agentIds = new Set<string>();
      for (const row of pendingApprovalRows) if (row.requestedByAgentId) agentIds.add(row.requestedByAgentId);
      for (const row of activeExecutionRows) if (row.agentId) agentIds.add(row.agentId);
      for (const row of recentCompletionRows) if (row.agentId) agentIds.add(row.agentId);

      const agentNameById = agentIds.size
        ? new Map(
          await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, Array.from(agentIds)))
            .then((rows) => rows.map((row) => [row.id, row.name] as const)),
        )
        : new Map<string, string>();

      const runIds = activeExecutionRows
        .map((row) => row.executionRunId)
        .filter((id): id is string => Boolean(id));
      const runStartedAtById = runIds.length
        ? new Map(
          await db
            .select({ id: heartbeatRuns.id, startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, runIds))
            .then((rows) => rows.map((row) => [row.id, row.startedAt ?? row.createdAt] as const)),
        )
        : new Map<string, Date>();

      const needsYou = pendingApprovalRows.map((row) => {
        const kind = payloadString(row.payload, "kind");
        const category = row.type === "request_board_approval" ? (kind ?? "general") : row.type;
        return {
          approvalId: row.id,
          type: category,
          title: payloadString(row.payload, "title"),
          requestedByAgentName: row.requestedByAgentId
            ? (agentNameById.get(row.requestedByAgentId) ?? null)
            : null,
          createdAt: row.createdAt.toISOString(),
        };
      });

      const activeExecutions = activeExecutionRows.map((row) => ({
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        title: row.title,
        agentId: row.agentId,
        agentName: row.agentId ? (agentNameById.get(row.agentId) ?? null) : null,
        startedAt: row.executionRunId
          ? (runStartedAtById.get(row.executionRunId)?.toISOString() ?? null)
          : null,
      }));

      const recentCompletions = recentCompletionRows.map((row) => ({
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        title: row.title,
        agentId: row.agentId,
        agentName: row.agentId ? (agentNameById.get(row.agentId) ?? null) : null,
        completedAt: (row.completedAt ?? now).toISOString(),
      }));

      const [{ todaySpend }] = await db
        .select({
          todaySpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, dayStart)));

      const dailyBudgetPolicy = await db
        .select({ amount: budgetPolicies.amount, warnPercent: budgetPolicies.warnPercent })
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "company"),
            eq(budgetPolicies.scopeId, companyId),
            eq(budgetPolicies.windowKind, "calendar_day_utc"),
            eq(budgetPolicies.metric, "billed_cents"),
            eq(budgetPolicies.isActive, true),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const spentTodayCents = Number(todaySpend);
      const dailyLimitCents = dailyBudgetPolicy ? dailyBudgetPolicy.amount : null;
      const percentage =
        dailyLimitCents && dailyLimitCents > 0
          ? Number(((spentTodayCents / dailyLimitCents) * 100).toFixed(2))
          : null;
      const warnPercent = dailyBudgetPolicy?.warnPercent ?? 80;
      const budgetStatus: DashboardPulse["budget"]["status"] =
        percentage === null ? "ok" : percentage >= 100 ? "critical" : percentage >= warnPercent ? "warning" : "ok";

      const deployApprovalRows = await db
        .select({
          id: approvals.id,
          status: approvals.status,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "request_board_approval"),
            sql`${approvals.payload} ->> 'kind' = 'deploy'`,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(PULSE_DEPLOYS_LIMIT);

      const statusLog = readDeployStatusLog(companyId);
      const deployedAtByApprovalId = new Map<string, string>();
      for (const entry of statusLog) {
        if (!isSuccessfulDeployEntry(entry)) continue;
        deployedAtByApprovalId.set(entry.approvalId, entry.ts);
      }

      const deploys = deployApprovalRows.map((row) => ({
        approvalId: row.id,
        title: payloadString(row.payload, "title"),
        status: row.status,
        commit: payloadString(row.payload, "commit"),
        committedAt: row.createdAt.toISOString(),
        deployedAt: deployedAtByApprovalId.get(row.id) ?? null,
      }));

      return {
        companyId,
        needsYouCount,
        needsYouByType,
        needsYou,
        activeExecutions,
        recentCompletions,
        budget: {
          spentTodayCents,
          dailyLimitCents,
          percentage,
          status: budgetStatus,
        },
        deploys,
      };
    },
  };
}
