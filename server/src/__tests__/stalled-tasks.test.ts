import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { stalledTasksService } from "../services/stalled-tasks.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stalled-task tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describeEmbeddedPostgres("stalled tasks (work nobody is moving)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof stalledTasksService>;
  let settings!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stalled-tasks-");
    db = createDb(tempDb.connectionString);
    svc = stalledTasksService(db);
    settings = instanceSettingsService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix: string) {
    const companyId = randomUUID();
    const activeAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const budgetPausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: activeAgentId, companyId, name: `${prefix} Engineer`, role: "engineer", status: "idle" },
      { id: pausedAgentId, companyId, name: `${prefix} Paused`, role: "engineer", status: "paused" },
      {
        id: budgetPausedAgentId,
        companyId,
        name: `${prefix} Budgeted`,
        role: "engineer",
        status: "paused",
        pauseReason: "budget",
      },
    ]);
    return { companyId, activeAgentId, pausedAgentId, budgetPausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    updatedAt?: Date;
    executionRunId?: string | null;
  }) {
    const id = randomUUID();
    const updatedAt = input.updatedAt ?? hoursAgo(72);
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: "manual",
      originFingerprint: randomUUID(),
      executionRunId: input.executionRunId ?? null,
      createdAt: updatedAt,
      updatedAt,
    });
    return id;
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      contextSnapshot: { issueId: input.issueId },
    });
    return runId;
  }

  async function list(companyId: string) {
    return svc.listForCompany(companyId);
  }

  it("reports a task whose agent is paused, without waiting for the idle threshold", async () => {
    const { companyId, pausedAgentId } = await createCompany("SPA");
    await insertIssue({
      companyId,
      identifier: "SPA-1",
      title: "Paused owner",
      status: "in_progress",
      assigneeAgentId: pausedAgentId,
      // Moved a minute ago: only the agent being unable to run puts it here.
      updatedAt: new Date(Date.now() - 60_000),
    });

    const result = await list(companyId);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ identifier: "SPA-1", reason: "assignee_unavailable" });
    expect(result.tasks[0]?.reasonText).toContain("Nobody is working on this");
    expect(result.tasks[0]?.reasonText).toContain("is paused");
  });

  it("reports a task nothing has happened on for longer than the threshold", async () => {
    const { companyId, activeAgentId } = await createCompany("SID");
    await insertIssue({
      companyId,
      identifier: "SID-1",
      title: "Gone quiet",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(30),
    });

    const result = await list(companyId);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ identifier: "SID-1", reason: "idle" });
    expect(result.tasks[0]?.reasonText).toContain("Nothing has happened on this since");
  });

  it("stays quiet while a task is still moving", async () => {
    const { companyId, activeAgentId } = await createCompany("SMV");
    await insertIssue({
      companyId,
      identifier: "SMV-1",
      title: "Still moving",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(1),
    });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("reports an unassigned open task once it has also gone quiet", async () => {
    const { companyId } = await createCompany("SUN");
    await insertIssue({
      companyId,
      identifier: "SUN-1",
      title: "Nobody owns this",
      status: "todo",
      updatedAt: hoursAgo(30),
    });

    const result = await list(companyId);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ identifier: "SUN-1", reason: "unassigned" });
    expect(result.tasks[0]?.reasonText).toContain("Nobody is assigned to this");
  });

  // --- No double-reporting: each of these is already on the page some other way.

  it("does not report a task with a live run", async () => {
    const { companyId, activeAgentId } = await createCompany("SLR");
    const issueId = await insertIssue({
      companyId,
      identifier: "SLR-1",
      title: "Being worked on",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(30),
    });
    await insertRun({ companyId, agentId: activeAgentId, issueId, status: "running" });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("does not report a task with a queued run", async () => {
    const { companyId, activeAgentId } = await createCompany("SQR");
    const issueId = await insertIssue({
      companyId,
      identifier: "SQR-1",
      title: "Queued up",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(30),
    });
    await insertRun({ companyId, agentId: activeAgentId, issueId, status: "queued" });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("does not report a task with a pending question card", async () => {
    const { companyId, pausedAgentId } = await createCompany("SPC");
    const issueId = await insertIssue({
      companyId,
      identifier: "SPC-1",
      title: "Already asking you",
      status: "in_review",
      assigneeAgentId: pausedAgentId,
      updatedAt: hoursAgo(30),
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { prompt: "Does this look right?" },
    });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("does not report a task with a pending approval", async () => {
    const { companyId, pausedAgentId } = await createCompany("SPV");
    const issueId = await insertIssue({
      companyId,
      identifier: "SPV-1",
      title: "Waiting on an approval",
      status: "in_review",
      assigneeAgentId: pausedAgentId,
      updatedAt: hoursAgo(30),
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "ship it" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("never reports a done or cancelled task", async () => {
    const { companyId, pausedAgentId } = await createCompany("SDC");
    await insertIssue({
      companyId,
      identifier: "SDC-1",
      title: "Finished",
      status: "done",
      assigneeAgentId: pausedAgentId,
      updatedAt: hoursAgo(300),
    });
    await insertIssue({
      companyId,
      identifier: "SDC-2",
      title: "Dropped",
      status: "cancelled",
      assigneeAgentId: pausedAgentId,
      updatedAt: hoursAgo(300),
    });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  it("honours the instance threshold setting", async () => {
    const { companyId, activeAgentId } = await createCompany("STH");
    await insertIssue({
      companyId,
      identifier: "STH-1",
      title: "Quiet for 30 hours",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(30),
    });

    const atDefault = await list(companyId);
    expect(atDefault.stalledAfterHours).toBe(12);
    expect(atDefault.tasks).toHaveLength(1);

    await settings.updateGeneral({ needsYouStalledAfterHours: 48 });

    const raised = await list(companyId);
    expect(raised.stalledAfterHours).toBe(48);
    expect(raised.tasks).toHaveLength(0);
  });

  it("counts a fresh comment as the task still moving", async () => {
    const { companyId, activeAgentId } = await createCompany("SFC");
    const issueId = await insertIssue({
      companyId,
      identifier: "SFC-1",
      title: "Old row, new comment",
      status: "in_progress",
      assigneeAgentId: activeAgentId,
      updatedAt: hoursAgo(30),
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "still on it",
      authorAgentId: activeAgentId,
      authorType: "agent",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect((await list(companyId)).tasks).toHaveLength(0);
  });

  // --- The three tasks the operator actually named.

  it("reports the tasks the operator had to be told about by someone else", async () => {
    const { companyId, activeAgentId, budgetPausedAgentId } = await createCompany("NOR");

    // NOR-1410 / NOR-1420: in_review, assigned to an agent, whose last comment
    // asks the operator to verify. No card, no approval -- so before this
    // source existed, nothing on the page mentioned them.
    for (const [identifier, title] of [
      ["NOR-1410", "Check the new supplier import"],
      ["NOR-1420", "Verify the weekly report figures"],
    ] as const) {
      const issueId = await insertIssue({
        companyId,
        identifier,
        title,
        status: "in_review",
        assigneeAgentId: activeAgentId,
        updatedAt: hoursAgo(72),
      });
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId,
        issueId,
        body: "Done on my side — awaiting operator verification.",
        authorAgentId: activeAgentId,
        authorType: "agent",
        createdAt: hoursAgo(72),
        updatedAt: hoursAgo(72),
      });
    }

    // NOR-1412: in_progress, with an assignee paused by the budget stop.
    await insertIssue({
      companyId,
      identifier: "NOR-1412",
      title: "Reconcile the September ledger",
      status: "in_progress",
      assigneeAgentId: budgetPausedAgentId,
      updatedAt: hoursAgo(72),
    });

    const result = await list(companyId);
    const byIdentifier = new Map(result.tasks.map((task) => [task.identifier, task]));

    expect(result.totalCount).toBe(3);
    expect(byIdentifier.get("NOR-1410")?.reason).toBe("idle_in_review");
    expect(byIdentifier.get("NOR-1410")?.reasonText).toContain("Finished and waiting for you since");
    expect(byIdentifier.get("NOR-1420")?.reason).toBe("idle_in_review");
    expect(byIdentifier.get("NOR-1412")?.reason).toBe("assignee_unavailable");
    expect(byIdentifier.get("NOR-1412")?.reasonText).toContain("reached its budget limit");

    // Every row says why it is here and since when, in words, with no ids.
    for (const task of result.tasks) {
      expect(task.reasonText).toMatch(/since \d{1,2} \w+\./);
      expect(task.reasonText).not.toContain(task.issueId);
    }
  });
});
