import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// DUR-3993: an agent may not set a task to "blocked" on the operator unless the
// operator has a way to answer (a pending question card or linked approval), or
// the task is linked to the unfinished task it waits on. Real database, real
// PATCH /issues/:id route.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-needs-ask gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("DUR-3993 blocked needs an operator ask (PATCH /issues/:id)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-needs-ask-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs six answers from the operator",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
    const boardActor: Express.Request["actor"] = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
    return { companyId, agentId, runId, issueId, agentActor, boardActor };
  }

  async function statusOf(issueId: string) {
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row[0]?.status;
  }

  it("refuses an agent setting blocked with only prose questions, and says to file a question card", async () => {
    const { issueId, agentActor } = await seed();

    const res = await request(createApp(agentActor))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", comment: "I need six answers from you: 1) ... 2) ..." });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe("blocked_needs_operator_ask");
    expect(res.body.error).toContain("ask_user_questions");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.error).toContain("blockedByIssueIds");
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it("allows an agent setting blocked when a question card is pending", async () => {
    const { companyId, agentId, issueId, agentActor } = await seed();
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      createdByAgentId: agentId,
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            prompt: "Which vendor should we use?",
            selectionMode: "single",
            options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          },
        ],
      } as any,
    });

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("does not count an answered question card as a pending ask", async () => {
    const { companyId, agentId, issueId, agentActor } = await seed();
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Go ahead?" } as any,
      resolvedAt: new Date(),
    });

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await statusOf(issueId)).toBe("in_progress");
  });

  it("allows an agent setting blocked when an unfinished blocking task is already linked", async () => {
    const { companyId, issueId, agentActor } = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Prerequisite",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("allows an agent setting blocked when it links the unfinished blocking task in the same update", async () => {
    const { companyId, issueId, agentActor } = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Prerequisite",
      status: "in_progress",
      priority: "medium",
    });

    const res = await request(createApp(agentActor))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [blockerId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("refuses when the only linked blocking task is already done", async () => {
    const { companyId, issueId, agentActor } = await seed();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Finished prerequisite",
      status: "done",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it("allows an agent setting blocked when a pending approval is linked to the task", async () => {
    const { companyId, agentId, issueId, agentActor } = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status: "pending",
      payload: { title: "Approve the vendor contract" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId, linkedByAgentId: agentId });

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("never gates a board user", async () => {
    const { issueId, boardActor } = await seed();

    const res = await request(createApp(boardActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("fails open: lets the agent through when the check itself errors", async () => {
    const { issueId, agentActor } = await seed();
    // Make the question-card lookup fail for real: the table disappears for the
    // duration of this request.
    await db.execute(sql`ALTER TABLE issue_thread_interactions RENAME TO issue_thread_interactions_gone`);
    let res: request.Response;
    try {
      res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });
    } finally {
      await db.execute(sql`ALTER TABLE issue_thread_interactions_gone RENAME TO issue_thread_interactions`);
    }

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });
});
