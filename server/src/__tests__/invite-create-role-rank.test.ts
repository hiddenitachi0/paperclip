import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb, invites, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";

vi.setConfig({ testTimeout: 15_000 });

// DUR-4100: invite creation only checked the `users:invite` permission (which
// both Owner and Admin hold by default), with no check on the *level* being
// granted. That let an Admin mint a humanRole:"owner" invite and
// self-escalate whoever accepted it above the inviter. This suite proves the
// server-side rank ceiling for every human company role: Owner may invite any
// role, Admin may invite at or below Admin (never Owner), and Operator/Viewer
// hold no invite permission at all. Runs against a real embedded Postgres
// because the rank check reads the actor's live company membership row.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite role-rank tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type HumanRole = "owner" | "admin" | "operator" | "viewer";

describeEmbeddedPostgres("POST /companies/:companyId/invites — role-rank ceiling (DUR-4100)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-role-rank-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(invites);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithMember(role: HumanRole) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Role Rank ${randomUUID()}`,
      issuePrefix: `RR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    const grants = grantsForHumanRole(role);
    if (grants.length > 0) {
      await db.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType: "user" as const,
          principalId: userId,
          permissionKey: grant.permissionKey,
          scope: grant.scope,
          grantedByUserId: userId,
        })),
      );
    }
    return { companyId, userId };
  }

  async function createApp(companyId: string, userId: string, membershipRole: HumanRole) {
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  it("owner can create an owner-level invite", async () => {
    const { companyId, userId } = await seedCompanyWithMember("owner");
    const app = await createApp(companyId, userId, "owner");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(201);
  });

  it("admin is blocked from creating an owner-level invite", async () => {
    const { companyId, userId } = await seedCompanyWithMember("admin");
    const app = await createApp(companyId, userId, "admin");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(403);
  });

  it("admin can create an admin-level invite (own level)", async () => {
    const { companyId, userId } = await seedCompanyWithMember("admin");
    const app = await createApp(companyId, userId, "admin");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "admin" });

    expect(res.status).toBe(201);
  });

  it("admin can create an operator-level invite (below own level)", async () => {
    const { companyId, userId } = await seedCompanyWithMember("admin");
    const app = await createApp(companyId, userId, "admin");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "operator" });

    expect(res.status).toBe(201);
  });

  it("operator holds no invite permission at all", async () => {
    const { companyId, userId } = await seedCompanyWithMember("operator");
    const app = await createApp(companyId, userId, "operator");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(403);
  });

  it("viewer holds no invite permission at all", async () => {
    const { companyId, userId } = await seedCompanyWithMember("viewer");
    const app = await createApp(companyId, userId, "viewer");

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .send({ allowedJoinTypes: "human", humanRole: "viewer" });

    expect(res.status).toBe(403);
  });
});
