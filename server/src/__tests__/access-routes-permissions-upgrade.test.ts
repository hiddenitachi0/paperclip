import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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

async function createApp(
  db: Db,
  companyId: string,
  userId: string,
  actorOverrides: Partial<Express.Request["actor"]> = {},
) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  // Every real owner-creation path (board-claim.ts's instance claim flow,
  // middleware/auth.ts's cloud_tenant provisioning) seeds the role's default
  // grants via ensureHumanRoleDefaultGrants immediately after inserting the
  // membership row -- permission decisions are made against materialized
  // principalPermissionGrants rows, never derived from membershipRole at
  // decide-time. Mirror that here so this fixture reflects a real Owner.
  await ensureHumanRoleDefaultGrants(db, {
    companyId: company.id,
    principalId: owner.principalId,
    membershipRole: "owner",
    grantedByUserId: null,
  });
  return { company, owner };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("DUR-4076: lets an Admin (users:invite but no users:manage_permissions) GET the member list", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const admin = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    // Admin role grants users:invite but not users:manage_permissions -- see
    // grantsForHumanRole in company-member-roles.ts. Grants are materialized
    // DB rows (not derived from membershipRole at decide-time), so seed the
    // row an invite-accept flow would have created.
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: admin.principalId,
      permissionKey: "users:invite",
      scope: null,
      grantedByUserId: owner.principalId,
    });

    const res = await request(
      await createApp(db, company.id, admin.principalId, { source: "session", isInstanceAdmin: false }),
    ).get(`/api/companies/${company.id}/members`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const memberIds = res.body.members.map((m: { id: string }) => m.id).sort();
    expect(memberIds).toEqual([admin.id, owner.id].sort());
    // Admins should not see raw permission grants (privacy protection)
    for (const member of res.body.members) {
      expect(member).not.toHaveProperty("grants");
    }
  }, 30_000);

  it("DUR-4117: lets a real production-style Owner (default role grants, non-local-implicit session) GET the member list", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    // Force a real permission-grant decision instead of the local_implicit
    // board bypass, the same as a signed-in Owner hitting this route over a
    // normal session -- proves the Owner's default grants (materialized by
    // createCompanyWithOwner via ensureHumanRoleDefaultGrants, matching
    // board-claim.ts and middleware/auth.ts's cloud_tenant provisioning)
    // are sufficient on their own, with no bypass involved.
    const res = await request(
      await createApp(db, company.id, owner.principalId, { source: "session", isInstanceAdmin: false }),
    ).get(`/api/companies/${company.id}/members`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const memberIds = res.body.members.map((m: { id: string }) => m.id);
    expect(memberIds).toEqual([owner.id]);
  }, 30_000);

  it("DUR-4076: rejects a member without users:invite (viewer) from GET-ing the member list", async () => {
    const { company } = await createCompanyWithOwner(db);
    const viewer = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `viewer-${randomUUID()}`,
        status: "active",
        membershipRole: "viewer",
      })
      .returning()
      .then((rows) => rows[0]!);

    const res = await request(
      await createApp(db, company.id, viewer.principalId, { source: "session", isInstanceAdmin: false }),
    ).get(`/api/companies/${company.id}/members`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  }, 30_000);

  it("DUR-4117: rejects a member without users:invite (operator) from GET-ing the member list", async () => {
    const { company } = await createCompanyWithOwner(db);
    const operator = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `operator-${randomUUID()}`,
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    // grantsForHumanRole("operator") is only tasks:assign -- no users:invite.

    const res = await request(
      await createApp(db, company.id, operator.principalId, { source: "session", isInstanceAdmin: false }),
    ).get(`/api/companies/${company.id}/members`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  }, 30_000);

  it("DUR-4076: Owners still see raw permission grants in member list", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `member-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "users:invite",
      scope: null,
      grantedByUserId: owner.principalId,
    });

    const res = await request(
      await createApp(db, company.id, owner.principalId, { source: "session", isInstanceAdmin: false }),
    ).get(`/api/companies/${company.id}/members`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const memberData = res.body.members.find((m: { id: string }) => m.id === member.id);
    expect(memberData).toBeDefined();
    expect(memberData).toHaveProperty("grants");
    expect(memberData.grants).toHaveLength(1);
    expect(memberData.grants[0]).toMatchObject({
      permissionKey: "users:invite",
      principalId: member.principalId,
    });
  }, 30_000);

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 30_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });
});
