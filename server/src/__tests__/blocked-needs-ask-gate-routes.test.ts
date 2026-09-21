import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  CHEAP_RUN_ESCALATION_REASON,
  DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE,
} from "../services/recovery/cheap-run-escalation.js";
import { withRecoveryModelProfileHint } from "../services/recovery/model-profile-hint.js";

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
    // A status change fans out fire-and-forget work after the response is
    // sent (dependent wake-ups, the task watchdog -- see
    // helpers/late-write-teardown.ts). Nothing in this file awaits it, so
    // stopping Postgres straight away kills those queries mid-flight and
    // vitest reports the ECONNRESET as an unhandled rejection. Wait until the
    // database has been quiet for a sustained stretch -- one idle reading is
    // not enough, because background work can sit between two queries at the
    // moment we look -- bounded so a stuck query cannot hang the suite.
    if (db) {
      let quietReadings = 0;
      for (let attempt = 0; attempt < 80 && quietReadings < 6; attempt += 1) {
        const rows = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and pid <> pg_backend_pid() and state = 'active'`,
        );
        const active = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
        quietReadings = active === 0 ? quietReadings + 1 : 0;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
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

  it("lets a cheap status-only run whose escalation cap is used up land in blocked (DUR-45 capped exit)", async () => {
    const { companyId, agentId, runId, issueId, agentActor } = await seed();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: withRecoveryModelProfileHint({ issueId }, "status_only") })
      .where(eq(heartbeatRuns.id, runId));
    for (let i = 0; i < DEFAULT_MAX_CHEAP_RUN_ESCALATIONS_PER_ISSUE; i += 1) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        reason: CHEAP_RUN_ESCALATION_REASON,
        status: "completed",
        payload: { issueId, sourceRunId: randomUUID() },
      });
    }

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
    const systemComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(systemComments.length).toBe(1);
  });

  it("does not gate a low-trust review agent, which is denied every path the gate would name", async () => {
    const { companyId, agentId, runId, issueId, agentActor } = await seed();
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: "Review scope", status: "in_progress" })
      .returning();
    const trustBoundary = {
      mode: LOW_TRUST_REVIEW_PRESET,
      companyId,
      projectIds: [project!.id],
      rootIssueId: issueId,
      issueIds: [issueId],
      allowedAgentIds: [],
    };
    const executionPolicy = { authorizationPolicy: { trustBoundary } };
    await db
      .update(agents)
      .set({ permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy: { trustBoundary } } })
      .where(eq(agents.id, agentId));
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId, executionPolicy } })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ projectId: project!.id, executionPolicy }).where(eq(issues.id, issueId));

    // Sanity: this actor really is denied the question-card route the gate names.
    const cardRes = await request(createApp(agentActor))
      .post(`/api/issues/${issueId}/interactions`)
      .send({
        kind: "request_confirmation",
        payload: { version: 1, prompt: "Go ahead?" },
      });
    expect(cardRes.status, JSON.stringify(cardRes.body)).toBe(403);

    const res = await request(createApp(agentActor)).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(issueId)).toBe("blocked");
  });
});
