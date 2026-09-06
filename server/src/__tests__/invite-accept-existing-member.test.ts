import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { authUsers, companies, createDb, invites, joinRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// DUR-381: every request now does a real reserve/set-claim/release round
// trip through embedded Postgres -- real latency the default 5s test
// timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));
const logActivityMock = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: logActivityMock,
  notifyHireApproved: vi.fn(),
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// DUR-381: POST /invites/:token/accept now runs under scopeFromInviteToken()
// -- a real reserved Postgres connection scoped to the invite's own
// companyId (a UUID-format check that rejects the old mock's "company-1"
// literal before the route handler is ever reached) -- and the handler's
// own queries additionally run part of their work inside a nested
// withCompanyScope(rawDb, companyId, ...) transaction. A hand-rolled
// call-count-sequenced db stub (the file's original approach) can't stand
// in for either of those, so this needs an actual embedded Postgres
// database end to end. accessService (ensureMembership/setPrincipalGrants/
// etc.) stays mocked -- it's a legitimate service-level unit-test boundary
// one layer above the DB.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite-accept-existing-member tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /invites/:token/accept", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-accept-existing-member-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await realDb.delete(joinRequests);
    await realDb.delete(invites);
    await realDb.delete(authUsers);
    await realDb.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createAppWithActor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use(
      "/api",
      accessRoutes(realDb, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await realDb.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  it("does not consume a human invite when the signed-in user is already a company member", async () => {
    const companyId = await seedCompany();
    const token = "pcp_invite_test";
    await realDb.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: hashToken(token),
      defaultsPayload: { human: { role: "viewer" } },
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: "user-1",
    });
    const app = createAppWithActor({
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: [companyId],
      memberships: [
        {
          companyId,
          membershipRole: "owner",
          status: "active",
        },
      ],
    });

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You already belong to this company");

    const [invite] = await realDb.select().from(invites);
    expect(invite?.acceptedAt).toBeNull();
    const joinRequestRows = await realDb.select().from(joinRequests);
    expect(joinRequestRows).toHaveLength(0);
  });

  it("grants company access immediately for a human invite", async () => {
    const companyId = await seedCompany();
    const token = "pcp_invite_test";
    await realDb.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: hashToken(token),
      defaultsPayload: { human: { role: "owner" } },
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: "inviter-user",
    });
    const now = new Date();
    await realDb.insert(authUsers).values({
      id: "invitee-user",
      name: "Invitee",
      email: "invitee@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const app = createAppWithActor({
      type: "board",
      source: "session",
      userId: "invitee-user",
      companyIds: [],
      memberships: [],
    });

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");

    const [joinRequestRow] = await realDb.select().from(joinRequests);
    expect(joinRequestRow).toEqual(
      expect.objectContaining({
        companyId,
        requestType: "human",
        status: "approved",
        requestingUserId: "invitee-user",
        requestEmailSnapshot: "invitee@example.com",
        approvedByUserId: "inviter-user",
      }),
    );
    expect(joinRequestRow?.approvedAt).toBeInstanceOf(Date);

    const [invite] = await realDb.select().from(invites);
    expect(invite?.acceptedAt).toBeInstanceOf(Date);

    expect(accessServiceMock.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "user",
      "invitee-user",
      "owner",
      "active",
    );
    expect(accessServiceMock.setPrincipalGrants).toHaveBeenCalledWith(
      companyId,
      "user",
      "invitee-user",
      expect.arrayContaining([
        expect.objectContaining({ permissionKey: "users:invite" }),
        expect.objectContaining({ permissionKey: "users:manage_permissions" }),
      ]),
      "inviter-user",
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.approved",
        entityId: joinRequestRow!.id,
        details: expect.objectContaining({ source: "human_invite_accept" }),
      }),
    );
  });

  it("replays a consumed human invite for the same user and repairs company access", async () => {
    const companyId = await seedCompany();
    const token = "pcp_invite_test";
    const [invite] = await realDb
      .insert(invites)
      .values({
        companyId,
        inviteType: "company_join",
        allowedJoinTypes: "human",
        tokenHash: hashToken(token),
        defaultsPayload: { human: { role: "operator" } },
        expiresAt: new Date("2027-03-10T00:00:00.000Z"),
        invitedByUserId: "inviter-user",
        acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      })
      .returning();
    const now = new Date();
    await realDb.insert(authUsers).values({
      id: "invitee-user",
      name: "Invitee",
      email: "invitee@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const [pendingJoinRequest] = await realDb
      .insert(joinRequests)
      .values({
        inviteId: invite!.id,
        companyId,
        requestType: "human",
        status: "pending_approval",
        requestIp: "::ffff:127.0.0.1",
        requestingUserId: "invitee-user",
        requestEmailSnapshot: "invitee@example.com",
      })
      .returning();
    const app = createAppWithActor({
      type: "board",
      source: "session",
      userId: "invitee-user",
      companyIds: [],
      memberships: [],
    });

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");

    const [joinRequestRow] = await realDb.select().from(joinRequests);
    expect(joinRequestRow?.id).toBe(pendingJoinRequest!.id);
    expect(joinRequestRow?.status).toBe("approved");
    expect(joinRequestRow?.approvedByUserId).toBe("inviter-user");
    expect(joinRequestRow?.approvedAt).toBeInstanceOf(Date);
    // Replaying an already-accepted invite must not re-stamp acceptedAt.
    expect(joinRequestRow?.updatedAt.getTime()).toBeGreaterThan(pendingJoinRequest!.updatedAt.getTime());

    expect(accessServiceMock.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "user",
      "invitee-user",
      "operator",
      "active",
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.request_replayed",
        entityId: joinRequestRow!.id,
        details: expect.objectContaining({ inviteReplay: true }),
      }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.approved",
        entityId: joinRequestRow!.id,
        details: expect.objectContaining({ source: "human_invite_accept" }),
      }),
    );
  });
});
