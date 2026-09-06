import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assets, companies, companyLogos, createDb, invites } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// DUR-381: GET /invites/:token/logo now runs under scopeFromInviteToken()
// (a real reserved Postgres connection scoped to the invite's companyId),
// and its handler re-queries invites (via scopeFromInviteToken's own raw
// lookup) plus a companies/company_logos/assets join through the *scoped*
// db proxy inside getInviteLogoAsset(). Two differently-shaped real
// queries after scope is established means a single hand-rolled
// selectCall-counter mock can't stand in for both -- this needs an actual
// embedded Postgres database end to end.
//
// Reserve/claim/release round trips through embedded Postgres add real
// latency the default 5s test timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

const mockStorage = vi.hoisted(() => ({
  getObject: vi.fn(),
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
    `Skipping embedded Postgres invite-logo-route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /invites/:token/logo", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-logo-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    mockStorage.getObject.mockReset();
    mockStorage.headObject.mockReset();
  });

  afterEach(async () => {
    await realDb.delete(companyLogos);
    await realDb.delete(assets);
    await realDb.delete(invites);
    await realDb.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "anon" };
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

  async function seedInviteWithLogo(companyId: string) {
    const now = new Date();
    await realDb.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await realDb.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: hashToken("pcp_invite_test"),
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
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

  it("serves the company logo for an active invite without company auth", async () => {
    const companyId = randomUUID();
    await seedInviteWithLogo(companyId);
    mockStorage.headObject.mockResolvedValue({
      exists: true,
      contentType: "image/png",
      contentLength: 3,
    });
    mockStorage.getObject.mockResolvedValue({
      contentType: "image/png",
      contentLength: 3,
      stream: Readable.from([Buffer.from("png")]),
    });
    const app = createApp();

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(mockStorage.headObject).toHaveBeenCalledWith(companyId, "assets/companies/logo-1");
    expect(mockStorage.getObject).toHaveBeenCalledWith(companyId, "assets/companies/logo-1");
  });

  it("returns 404 when the logo asset record exists but storage does not", async () => {
    const companyId = randomUUID();
    await seedInviteWithLogo(companyId);
    mockStorage.headObject.mockResolvedValue({ exists: false });
    const app = createApp();

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Invite logo not found");
    expect(mockStorage.getObject).not.toHaveBeenCalled();
  });
});
