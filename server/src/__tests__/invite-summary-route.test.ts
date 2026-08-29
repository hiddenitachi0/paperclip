import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assets, authUsers, companies, companyLogos, createDb, invites, joinRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// DUR-381: GET /invites/:token now runs under scopeFromInviteToken() (a
// real reserved Postgres connection scoped to the invite's companyId), and
// its handler re-queries invites/join_requests/companies/company_logos/
// assets through the *scoped* db proxy (resolveAcceptedInviteJoinRequest +
// getInviteCompanyBranding + getInviteLogoAsset). Several differently-
// shaped real queries in sequence means a hand-rolled selectCall-counter
// mock can't stand in for all of them -- this needs an actual embedded
// Postgres database end to end.
//
// Reserve/claim/release round trips through embedded Postgres add real
// latency the default 5s test timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 25_000 });

const mockStorage = vi.hoisted(() => ({
  headObject: vi.fn(),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => mockStorage,
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite-summary-route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /invites/:token", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-summary-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    mockStorage.headObject.mockReset();
    mockStorage.headObject.mockResolvedValue({ exists: true, contentLength: 3, contentType: "image/png" });
  });

  afterEach(async () => {
    await realDb.delete(joinRequests);
    await realDb.delete(companyLogos);
    await realDb.delete(assets);
    await realDb.delete(invites);
    await realDb.delete(authUsers);
    await realDb.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actor: Record<string, unknown> = { type: "anon" }) {
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use(
      "/api",
      accessRoutes(realDb, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithLogo(companyId: string) {
    const now = new Date();
    await realDb.insert(companies).values({
      id: companyId,
      name: "Acme Robotics",
      brandColor: "#114488",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const [asset] = await realDb
      .insert(assets)
      .values({
        companyId,
        provider: "local",
        objectKey: "assets/companies/logo-1",
        contentType: "image/png",
        byteSize: 3,
        sha256: "deadbeef",
        originalFilename: "logo.png",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await realDb.insert(companyLogos).values({
      companyId,
      assetId: asset.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function seedInvite(companyId: string, overrides: Partial<typeof invites.$inferInsert> = {}) {
    const [invite] = await realDb
      .insert(invites)
      .values({
        companyId,
        inviteType: "company_join",
        allowedJoinTypes: "human",
        tokenHash: hashToken("pcp_invite_test"),
        expiresAt: new Date("2027-03-07T00:10:00.000Z"),
        createdAt: new Date("2026-03-07T00:00:00.000Z"),
        updatedAt: new Date("2026-03-07T00:00:00.000Z"),
        ...overrides,
      })
      .returning();
    return invite;
  }

  it("returns company branding in the invite summary response", async () => {
    const companyId = randomUUID();
    await seedCompanyWithLogo(companyId);
    await seedInvite(companyId);
    const app = await createApp();

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.companyBrandColor).toBe("#114488");
    expect(res.body.companyLogoUrl).toBe("/api/invites/pcp_invite_test/logo");
    expect(res.body.inviteType).toBe("company_join");
  });

  it("omits companyLogoUrl when the stored logo object is missing", async () => {
    mockStorage.headObject.mockResolvedValue({ exists: false });
    const companyId = randomUUID();
    await seedCompanyWithLogo(companyId);
    await seedInvite(companyId);
    const app = await createApp();

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyLogoUrl).toBeNull();
  });

  it("returns pending join-request status for an already-accepted invite", async () => {
    const companyId = randomUUID();
    await seedCompanyWithLogo(companyId);
    const invite = await seedInvite(companyId, {
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    });
    await realDb.insert(joinRequests).values({
      inviteId: invite.id,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestingUserId: "user-1",
      requestEmailSnapshot: "jane@example.com",
      createdAt: new Date("2026-03-07T00:05:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    });
    const app = await createApp();

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
    expect(res.body.companyName).toBe("Acme Robotics");
  });

  it("falls back to a reusable human join request when the accepted invite reused an existing queue entry", async () => {
    const companyId = randomUUID();
    await seedCompanyWithLogo(companyId);
    // The original invite whose acceptance actually created the queue entry.
    const firstInvite = await seedInvite(companyId, {
      tokenHash: hashToken("pcp_invite_original"),
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    });
    await realDb.insert(joinRequests).values({
      inviteId: firstInvite.id,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestingUserId: "user-1",
      requestEmailSnapshot: "jane@example.com",
      createdAt: new Date("2026-03-07T00:05:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    });
    await realDb.insert(authUsers).values({
      id: "user-1",
      name: "Jane",
      email: "jane@example.com",
      image: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    });
    // A second invite that was accepted by the same user/company but never
    // got its own direct join_requests row -- it should reuse the queue
    // entry created via the first invite.
    await seedInvite(companyId, {
      tokenHash: hashToken("pcp_invite_test"),
      acceptedAt: new Date("2026-03-07T00:06:00.000Z"),
      updatedAt: new Date("2026-03-07T00:06:00.000Z"),
    });
    const app = await createApp({ type: "board", userId: "user-1", source: "session" });

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
  });
});
