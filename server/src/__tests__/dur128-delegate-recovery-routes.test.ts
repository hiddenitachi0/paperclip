import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function delegateActor(input: {
  userId: string;
  companyId: string;
  membershipRole?: string;
  scopes: string[];
}): Express.Request["actor"] {
  return {
    type: "board_delegate",
    userId: input.userId,
    companyIds: [input.companyId],
    memberships: [{ companyId: input.companyId, membershipRole: input.membershipRole ?? "owner", status: "active" }],
    isInstanceAdmin: false,
    delegateTokenId: "test-delegate-token",
    delegateName: "Telegram recovery bot",
    delegateScopes: input.scopes as any,
    source: "board_delegate_key",
  };
}

async function createAppWithActor(
  db: Db,
  actor: Express.Request["actor"],
  mount: (db: Db) => Promise<express.Router>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", await mount(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompanyWithOperator(db: Db) {
  const companyId = randomUUID();
  const userId = `user-${randomUUID()}`;
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(authUsers).values({
    id: userId,
    name: "Operator",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
  });

  // Real board sessions for this user get these grants the moment they join
  // a company; the delegate-permission check in getAccessibleAgent evaluates
  // the operator's own grants, so the test operator needs them too.
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: "owner",
    grantedByUserId: null,
  });

  return { companyId, userId };
}

async function seedAgentInStatus(db: Db, companyId: string, status: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await db.insert(agents).values({
    id,
    companyId,
    name: `Agent ${id.slice(0, 8)}`,
    role: "engineer",
    status,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    ...extra,
  });
  return id;
}

describeEmbeddedPostgres("DUR-128: delegated operator credential on recovery routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur128-delegate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears an error and resumes an agent via a scoped delegate token, naming the delegate and the operator authority in the activity log", { timeout: 20_000 }, async () => {
    const { companyId, userId } = await seedCompanyWithOperator(db);
    const erroredAgentId = await seedAgentInStatus(db, companyId, "error", {
      errorReason: "Adapter crashed",
      errorAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const pausedAgentId = await seedAgentInStatus(db, companyId, "paused", {
      pauseReason: "manual",
      pausedAt: new Date(),
    });

    const { agentRoutes } = await import("../routes/agents.js");
    const actor = delegateActor({
      userId,
      companyId,
      scopes: ["agent.clear_error", "agent.resume"],
    });
    const app = await createAppWithActor(db, actor, async (d) => agentRoutes(d, {}));

    const clearRes = await request(app).post(`/api/agents/${erroredAgentId}/clear-error`).send({});
    expect(clearRes.status).toBe(200);
    expect(clearRes.body).toMatchObject({ id: erroredAgentId, status: "idle" });

    const resumeRes = await request(app).post(`/api/agents/${pausedAgentId}/resume`).send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body).toMatchObject({ id: pausedAgentId, status: "idle" });

    const clearErrorActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, erroredAgentId));
    expect(clearErrorActivity).toHaveLength(1);
    expect(clearErrorActivity[0]).toMatchObject({
      action: "agent.error_cleared",
      actorType: "user",
      actorId: userId,
    });
    expect(clearErrorActivity[0].details).toMatchObject({
      performedBy: "delegate",
      delegateId: "test-delegate-token",
      delegateName: "Telegram recovery bot",
      actingUnderUserId: userId,
    });

    const resumeActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, pausedAgentId));
    expect(resumeActivity).toHaveLength(1);
    expect(resumeActivity[0]).toMatchObject({
      action: "agent.resumed",
      actorType: "user",
      actorId: userId,
    });
    expect(resumeActivity[0].details).toMatchObject({
      performedBy: "delegate",
      delegateId: "test-delegate-token",
    });
  });

  it("refuses a recovery action the delegate token was not scoped for", { timeout: 20_000 }, async () => {
    const { companyId, userId } = await seedCompanyWithOperator(db);
    const erroredAgentId = await seedAgentInStatus(db, companyId, "error", {
      errorReason: "Adapter crashed",
      errorAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const { agentRoutes } = await import("../routes/agents.js");
    // Scoped for resume only -- must not be able to clear an error.
    const actor = delegateActor({ userId, companyId, scopes: ["agent.resume"] });
    const app = await createAppWithActor(db, actor, async (d) => agentRoutes(d, {}));

    const res = await request(app).post(`/api/agents/${erroredAgentId}/clear-error`).send({});
    expect(res.status).toBe(403);

    const [agent] = await db.select().from(agents).where(eq(agents.id, erroredAgentId));
    expect(agent.status).toBe("error");
  });

  it("never lets a delegate token approve a merge or a deploy, no matter what scopes it holds", { timeout: 20_000 }, async () => {
    const { companyId, userId } = await seedCompanyWithOperator(db);
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByUserId: null,
      requestedByAgentId: null,
      status: "pending",
      payload: { kind: "merge_pr", repo: "acme/widgets", prNumber: 42, base: "main" },
    });

    const { approvalRoutes } = await import("../routes/approvals.js");
    // Every scope that exists -- still must not reach approval.
    const actor = delegateActor({
      userId,
      companyId,
      scopes: ["agent.clear_error", "agent.resume", "issue.scheduled_retry_retry_now"],
    });
    const app = await createAppWithActor(db, actor, async (d) => approvalRoutes(d, {}));

    const res = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(res.status).toBe(403);

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval.status).toBe("pending");
  });
});
