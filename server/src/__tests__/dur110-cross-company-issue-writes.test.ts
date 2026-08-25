import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId: randomUUID(),
    source: "agent_jwt",
  };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompany(db: Db, label: string) {
  return db
    .insert(companies)
    .values({
      name: `DUR-110 ${label}`,
      issuePrefix: `D110${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("DUR-110: cross-company issue-thread writes are refused and cannot be persisted", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur110-cross-company-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScenario(db: Db) {
    const ownerCompany = await seedCompany(db, "Owner");
    const intruderCompany = await seedCompany(db, "Intruder");
    const intruderAgent = await seedAgent(db, intruderCompany.id);
    const issue = await db
      .insert(issues)
      .values({
        companyId: ownerCompany.id,
        identifier: `${ownerCompany.issuePrefix}-1`,
        title: "Owner-company issue that an outside agent must never touch",
        status: "todo",
        priority: "medium",
      })
      .returning()
      .then((rows) => rows[0]!);
    return { ownerCompany, intruderCompany, intruderAgent, issue };
  }

  it("refuses POST /issues/:id/comments from an agent outside the issue's company, and persists nothing", { timeout: 20_000 }, async () => {
    const { ownerCompany, intruderCompany, intruderAgent, issue } = await seedScenario(db);
    const app = await createApp(db, agentActor(intruderCompany.id, intruderAgent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "I should not be able to write this." });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Agent key cannot access another company");

    const comments = await db.select().from(issueComments);
    expect(comments.filter((c) => c.issueId === issue.id)).toHaveLength(0);

    // The refusal must be loud: an activity_log alert lands on the ISSUE'S OWN
    // (owner) company, not silently dropped.
    const alerts = await db.select().from(activityLog);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyId: ownerCompany.id,
          action: "security.cross_company_write_blocked",
          entityId: issue.id,
        }),
      ]),
    );
  });

  it("refuses POST /issues/:id/interactions from an agent outside the issue's company, and persists nothing", { timeout: 20_000 }, async () => {
    const { ownerCompany, intruderCompany, intruderAgent, issue } = await seedScenario(db);
    const app = await createApp(db, agentActor(intruderCompany.id, intruderAgent.id));

    const res = await request(app)
      .post(`/api/issues/${issue.id}/interactions`)
      .send({
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: [{ id: "q1", prompt: "Should this have worked?", selectionMode: "single", options: [{ id: "no", label: "No" }] }],
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Agent key cannot access another company");

    const interactions = await db.select().from(issueThreadInteractions);
    expect(interactions.filter((i) => i.issueId === issue.id)).toHaveLength(0);

    const alerts = await db.select().from(activityLog);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyId: ownerCompany.id,
          action: "security.cross_company_write_blocked",
          entityId: issue.id,
        }),
      ]),
    );
  });

  it("cannot persist an issue_comments row whose company disagrees with its issue, even bypassing the route", async () => {
    const { intruderCompany, issue } = await seedScenario(db);

    const [inserted] = await db
      .insert(issueComments)
      .values({
        companyId: intruderCompany.id,
        issueId: issue.id,
        body: "Attempting to smuggle a foreign company_id in directly.",
      })
      .returning();

    expect(inserted!.companyId).toBe(issue.companyId);
    expect(inserted!.companyId).not.toBe(intruderCompany.id);
  });

  it("cannot persist an issue_thread_interactions row whose company disagrees with its issue, even bypassing the route", async () => {
    const { intruderCompany, issue } = await seedScenario(db);

    const [inserted] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: intruderCompany.id,
        issueId: issue.id,
        kind: "ask_user_questions",
        payload: { version: 1, questions: [] },
      })
      .returning();

    expect(inserted!.companyId).toBe(issue.companyId);
    expect(inserted!.companyId).not.toBe(intruderCompany.id);
  });
});
