import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  laneAConversations,
  laneAMessages,
  privateAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.setConfig({ testTimeout: 15_000 });

// DUR-4094: Filip's emergency-access ("break-glass") rule -- an owner/admin
// reading an Employee (light)'s PA conversation must log a written reason
// first, an operator/viewer/employee must never reach the route at all, and
// the subject's own "who read my private stuff" read must only ever show
// what the rule promised to tell her about (notify:false rows stay hidden
// from her, visible to owners regardless).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres private-access tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type MembershipRole = "owner" | "admin" | "operator" | "viewer" | "employee";

describeEmbeddedPostgres("private-access routes (DUR-4094)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let conversationId!: string;
  const employeeUserId = `user-employee-${randomUUID()}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-private-access-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(privateAccessEvents);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  async function seed(actorRole: MembershipRole) {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Acme ${randomUUID()}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Personal Assistant",
      role: "general",
      status: "idle",
      laneAEnabled: true,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: employeeUserId,
      status: "active",
      membershipRole: "employee",
    });
    const actorUserId = `user-${actorRole}-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: actorUserId,
      status: "active",
      membershipRole: actorRole,
    });
    conversationId = randomUUID();
    await db.insert(laneAConversations).values({
      id: conversationId,
      companyId,
      agentId,
      requestedByUserId: employeeUserId,
      turnCount: 1,
    });
    await db.insert(laneAMessages).values({
      id: randomUUID(),
      companyId,
      conversationId,
      agentId,
      role: "user",
      content: "This is private.",
    });
    return actorUserId;
  }

  async function createApp(actorUserId: string, membershipRole: MembershipRole) {
    const { privateAccessRoutes } = await import("../routes/private-access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId: actorUserId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
      };
      next();
    });
    app.use("/api", privateAccessRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("an owner can break glass with a reason, and the read is logged", async () => {
    const ownerUserId = await seed("owner");
    const app = await createApp(ownerUserId, "owner");

    const res = await request(app)
      .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
      .send({ companyId, reason: "Suspected policy violation, checking flagged keywords." });

    expect(res.status).toBe(201);
    expect(res.body.conversation.messages).toHaveLength(1);
    expect(res.body.event.targetUserId).toBe(employeeUserId);
    expect(res.body.event.accessedByUserId).toBe(ownerUserId);
    expect(res.body.event.notify).toBe(true);

    const rows = await db.select().from(privateAccessEvents);
    expect(rows).toHaveLength(1);
  });

  it("an admin can break glass with notify turned off, and the reason is still stored", async () => {
    const adminUserId = await seed("admin");
    const app = await createApp(adminUserId, "admin");

    const res = await request(app)
      .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
      .send({ companyId, reason: "Internal investigation, do not tip off the subject yet.", notify: false });

    expect(res.status).toBe(201);
    expect(res.body.event.notify).toBe(false);
    expect(res.body.event.reason).toBe("Internal investigation, do not tip off the subject yet.");
  });

  it("rejects a reason that is too short", async () => {
    const ownerUserId = await seed("owner");
    const app = await createApp(ownerUserId, "owner");

    const res = await request(app)
      .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
      .send({ companyId, reason: "short" });

    expect(res.status).toBe(400);
  });

  for (const role of ["operator", "viewer", "employee"] as const) {
    it(`refuses a ${role} from breaking glass at all`, async () => {
      const actorUserId = await seed(role);
      const app = await createApp(actorUserId, role);

      const res = await request(app)
        .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
        .send({ companyId, reason: "Trying to read someone else's chat." });

      expect(res.status).toBe(403);
    });
  }

  it("the subject's own access log only shows notified rows, never a silent one", async () => {
    const ownerUserId = await seed("owner");
    const ownerApp = await createApp(ownerUserId, "owner");

    await request(ownerApp)
      .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
      .send({ companyId, reason: "Routine spot check, notify her as usual." });
    await request(ownerApp)
      .post(`/api/private-access/lane-a/${agentId}/conversations/${conversationId}`)
      .send({ companyId, reason: "Misuse investigation, keep this one quiet for now.", notify: false });

    const ownerAudit = await request(ownerApp).get(`/api/private-access-events?companyId=${companyId}`);
    expect(ownerAudit.status).toBe(200);
    expect(ownerAudit.body.events).toHaveLength(2);

    const employeeApp = await createApp(employeeUserId, "employee");
    const mine = await request(employeeApp).get(`/api/private-access-events/mine?companyId=${companyId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.events).toHaveLength(1);
    expect(mine.body.events[0].notify).toBe(true);
  });
});
