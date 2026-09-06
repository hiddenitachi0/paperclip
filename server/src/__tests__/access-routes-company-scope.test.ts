import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb, invites } from "@paperclipai/db";
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

let accessRoutes: typeof import("../routes/access.js").accessRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres access-routes company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// DUR-381 (DUR-277 Wave 5b): proves accessRoutes' per-route-group scope
// split is genuinely wired end-to-end over a real HTTP request -- a real
// reserved Postgres connection, a real `app.current_company_id` session
// claim -- for all three categories mixed into this one route file:
// (a) direct `companies/:companyId/*` routes, (b) lookup-then-scope invite
// routes (token resolved to a company before the scope is entered), and
// (c) genuinely instance-wide routes that must run under bypass. See
// secrets-routes-company-scope.test.ts / dashboard-routes-company-scope.test.ts
// for the original of this pattern (DUR-277).
describeEmbeddedPostgres("accessRoutes company-scope wiring (DUR-381)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    accessRoutes = routes.accessRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(invites);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!accessRoutes || !errorHandler) {
      throw new Error("access route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: randomUUID(),
        companyIds,
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

  async function seedCompanyWithInvites(inviteCount: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (let i = 0; i < inviteCount; i++) {
      await db.insert(invites).values({
        companyId,
        inviteType: "company_join",
        tokenHash: hashToken(`${companyId}-token-${i}`),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }
    return companyId;
  }

  it("category (a): scopes companies/:companyId/invites to the requesting company, never bleeding another's across pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithInvites(1);
    const companyB = await seedCompanyWithInvites(2);
    const app = createApp([companyA, companyB]);

    // Sequential so the released connection from each request is the one
    // most likely to be reused by the next -- the claim-bleed shape the
    // scope proxy exists to prevent.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/invites`);
      expect(resA.status).toBe(200);
      expect(resA.body.invites).toHaveLength(1);
      expect(resA.body.invites.every((invite: { companyId: string }) => invite.companyId === companyA)).toBe(true);

      const resB = await request(app).get(`/api/companies/${companyB}/invites`);
      expect(resB.status).toBe(200);
      expect(resB.body.invites).toHaveLength(2);
      expect(resB.body.invites.every((invite: { companyId: string }) => invite.companyId === companyB)).toBe(true);
    }
  });

  it("category (a): rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/invites");

    expect(res.status).toBe(400);
  });

  it("category (b): resolves the invite's own company scope from the token lookup, not the caller's companyIds", async () => {
    const companyId = await seedCompanyWithInvites(0);
    const token = `${companyId}-lookup-token`;
    await db.insert(invites).values({
      companyId,
      inviteType: "company_join",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    // Actor has no membership in `companyId` at all -- the invite-token
    // lookup resolves the scope itself, independent of the caller's own
    // companyIds, per the "lookup entity, then scope" pattern.
    const app = createApp([]);

    const res = await request(app).get(`/api/invites/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
  });

  it("category (b): a companyless bootstrap invite resolves via bypass scope instead of throwing on a missing company", async () => {
    const token = "bootstrap-ceo-token";
    await db.insert(invites).values({
      companyId: null,
      inviteType: "bootstrap_ceo",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const app = createApp([]);

    const res = await request(app).get(`/api/invites/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBeNull();
  });

  it("category (b): an unknown invite token 404s instead of leaking a scope error", async () => {
    const app = createApp([]);

    const res = await request(app).get("/api/invites/does-not-exist");

    expect(res.status).toBe(404);
  });

  it("category (c): an instance-wide route (CLI device-auth challenge creation) runs under bypass scope with no company in play", async () => {
    const app = createApp([]);

    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({ command: "paperclip login", requestedAccess: "board" });

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
  });

  // DUR-381 regression: accessService(db) is called with the request-scoped
  // proxy in accessRoutes, but several of its functions (archiveMember,
  // setMemberPermissions, setUserCompanyAccess) internally used
  // db.transaction() -- unsupported through that proxy (throws by design,
  // see packages/db/src/company-scope.ts) regardless of whether route-level
  // scope middleware was wired. These routes had no scope middleware AND no
  // rawDb plumbed into accessService, so they 500'd outright before the fix.
  it("category (a): archives a company member via accessService's internal transaction under the route's company scope", async () => {
    const companyId = await seedCompanyWithInvites(0);
    const memberUserId = randomUUID();
    const [member] = await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: memberUserId,
        status: "active",
        membershipRole: "operator",
      })
      .returning();
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/members/${member!.id}/archive`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.member.status).toBe("archived");
  });

  it("category (a): updates a company member's permissions via accessService's internal transaction under the route's company scope", async () => {
    const companyId = await seedCompanyWithInvites(0);
    const memberUserId = randomUUID();
    const [member] = await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: memberUserId,
        status: "active",
        membershipRole: "operator",
      })
      .returning();
    const app = createApp([companyId]);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${member!.id}/permissions`)
      .send({ grants: [] });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(member!.id);
  });

  it("category (c): updates a user's cross-company access via accessService's internal transaction under bypass scope", async () => {
    const companyA = await seedCompanyWithInvites(0);
    const companyB = await seedCompanyWithInvites(0);
    const targetUserId = randomUUID();
    const app = createApp([]);

    const res = await request(app)
      .put(`/api/admin/users/${targetUserId}/company-access`)
      .send({ companyIds: [companyA, companyB] });

    expect(res.status).toBe(200);
    const grantedCompanyIds = res.body.companyAccess
      .map((row: { companyId: string }) => row.companyId)
      .sort();
    expect(grantedCompanyIds).toEqual([companyA, companyB].sort());
  });
});
