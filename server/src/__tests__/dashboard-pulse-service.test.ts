import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  budgetPolicies,
  companies,
  costEvents,
  heartbeatRuns,
  issues,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService } from "../services/dashboard.ts";
import type { DeployRunnerStatusEntry } from "../services/deploy-runner-status.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard pulse service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-4199: the pulse endpoint behind the always-visible status panel
// (parent DUR-4154) -- needs-you approvals by type, live executions, recent
// completions, today's spend vs the daily budget policy, and recent deploy
// approvals cross-referenced against the deploy-runner status log.
describeEmbeddedPostgres("dashboardService.pulse", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-pulse-service-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(budgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("groups pending approvals by payload.kind for request_board_approval, and by type otherwise, across companies", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Backend Engineer");

    await db.insert(approvals).values([
      {
        id: randomUUID(),
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "pending",
        payload: { kind: "deploy", title: "ship the pulse endpoint" },
      },
      {
        id: randomUUID(),
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "pending",
        payload: { kind: "deploy", title: "ship another change" },
      },
      {
        id: randomUUID(),
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "pending",
        payload: { kind: "merge_pr", title: "merge the backend PR" },
      },
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: { title: "hire a QA" },
      },
      // decided -- must not count
      {
        id: randomUUID(),
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "approved",
        decidedAt: new Date(),
        payload: { kind: "deploy", title: "already decided" },
      },
      // different company -- must not leak in
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        type: "request_board_approval",
        status: "pending",
        payload: { kind: "deploy", title: "someone else's deploy" },
      },
    ]);

    const pulse = await dashboardService(db).pulse(companyId);

    expect(pulse.needsYouCount).toBe(4);
    expect(pulse.needsYouByType).toEqual({ deploy: 2, merge_pr: 1, hire_agent: 1 });
    expect(pulse.needsYou).toHaveLength(4);
    const deployItem = pulse.needsYou.find((item) => item.title === "ship the pulse endpoint");
    expect(deployItem).toMatchObject({ type: "deploy", requestedByAgentName: "Backend Engineer" });
  });

  it("reports active executions from issues with a live executionRunId, and recent completions within the 12h window", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Running Agent");

    const runId = randomUUID();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt,
    });

    const activeIssueId = randomUUID();
    await db.insert(issues).values({
      id: activeIssueId,
      companyId,
      title: "Working on the pulse endpoint",
      status: "in_progress",
      priority: "high",
      identifier: "T-1",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });

    const recentDoneId = randomUUID();
    const staleDoneId = randomUUID();
    await db.insert(issues).values([
      {
        id: recentDoneId,
        companyId,
        title: "Finished 1h ago",
        status: "done",
        priority: "medium",
        identifier: "T-2",
        assigneeAgentId: agentId,
        completedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
      {
        id: staleDoneId,
        companyId,
        title: "Finished 2 days ago",
        status: "done",
        priority: "medium",
        identifier: "T-3",
        assigneeAgentId: agentId,
        completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    ]);

    const pulse = await dashboardService(db).pulse(companyId);

    expect(pulse.activeExecutions).toHaveLength(1);
    expect(pulse.activeExecutions[0]).toMatchObject({
      issueId: activeIssueId,
      agentName: "Running Agent",
      startedAt: startedAt.toISOString(),
    });

    expect(pulse.recentCompletions.map((row) => row.issueId)).toEqual([recentDoneId]);
  });

  it("computes today's spend against a calendar_day_utc company budget policy", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Spender");

    await db.insert(budgetPolicies).values({
      id: randomUUID(),
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "calendar_day_utc",
      amount: 1000,
      warnPercent: 50,
      isActive: true,
    });

    await db.insert(costEvents).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        provider: "anthropic",
        model: "claude",
        costCents: 600,
        occurredAt: new Date(),
      },
      // Yesterday -- must not count toward today's spend.
      {
        id: randomUUID(),
        companyId,
        agentId,
        provider: "anthropic",
        model: "claude",
        costCents: 5000,
        occurredAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      },
    ]);

    const pulse = await dashboardService(db).pulse(companyId);

    expect(pulse.budget).toMatchObject({
      spentTodayCents: 600,
      dailyLimitCents: 1000,
      percentage: 60,
      status: "warning",
    });
  });

  it("reports budget status ok with a null percentage when no daily policy is configured", async () => {
    const companyId = await seedCompany();

    const pulse = await dashboardService(db).pulse(companyId);

    expect(pulse.budget).toEqual({
      spentTodayCents: 0,
      dailyLimitCents: null,
      percentage: null,
      status: "ok",
    });
  });

  it("cross-references recent deploy approvals against the deploy runner status log for deployedAt", async () => {
    const companyId = await seedCompany();
    const deployedApprovalId = randomUUID();
    const pendingApprovalId = randomUUID();

    await db.insert(approvals).values([
      {
        id: deployedApprovalId,
        companyId,
        type: "request_board_approval",
        status: "approved",
        decidedAt: new Date(),
        payload: { kind: "deploy", title: "ship it", commit: "a".repeat(40) },
      },
      {
        id: pendingApprovalId,
        companyId,
        type: "request_board_approval",
        status: "pending",
        payload: { kind: "deploy", title: "not yet decided" },
      },
    ]);

    const statusLogEntry: DeployRunnerStatusEntry = {
      ts: "2026-09-30T12:00:00.000Z",
      approvalId: deployedApprovalId,
      companyId,
      commentDelivered: true,
      body: "a".repeat(12) + " is live and healthy",
    };

    const pulse = await dashboardService(db, {
      readDeployStatusLog: () => [statusLogEntry],
    }).pulse(companyId);

    expect(pulse.deploys).toHaveLength(2);
    const deployed = pulse.deploys.find((row) => row.approvalId === deployedApprovalId);
    const pending = pulse.deploys.find((row) => row.approvalId === pendingApprovalId);
    expect(deployed).toMatchObject({ status: "approved", deployedAt: statusLogEntry.ts });
    expect(pending).toMatchObject({ status: "pending", deployedAt: null });
  });
});
