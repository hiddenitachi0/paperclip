import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockStorage = vi.hoisted(() => ({
  headObject: vi.fn(),
}));

// DUR-379: GET /invites/:token now runs through the company-scope
// middleware (scopeFromInviteToken), which reserves a real connection via
// runInCompanyScope -- this test's hand-rolled call-index db stub isn't a
// real Db, so it can't back that reservation. Bypass the reservation
// machinery in tests the same way the pre-migration `db.transaction()` /
// direct `db` calls worked: run the callback with the test's own db as the
// "scoped" db, no real connection involved. See helpers/fake-scoped-db.ts
// for the alternative (real reserve) approach used where routes go through
// mocked services instead of raw db calls.
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
    withCompanyScope: async (rawDb: any, _companyId: string, fn: (tx: unknown) => unknown) => rawDb.transaction(fn),
  };
});

function registerModuleMocks() {
  vi.doMock("../storage/index.js", () => ({
    getStorageService: () => mockStorage,
  }));
}

function createSelectChain(rows: unknown[]) {
  const query = {
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    leftJoin() {
      return query;
    },
    orderBy() {
      return query;
    },
    where() {
      return query;
    },
  };
  return {
    from() {
      return query;
    },
  };
}

function createDbStub(...selectResponses: unknown[][]) {
  let selectCall = 0;
  return {
    select() {
      const rows = selectResponses[selectCall] ?? [];
      selectCall += 1;
      return createSelectChain(rows);
    },
  };
}

async function createApp(
  db: Record<string, unknown>,
  actor: Record<string, unknown> = { type: "anon" },
) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/access.js")>("../routes/access.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("GET /invites/:token", () => {
  // DUR-379: vi.resetModules() in beforeEach forces every test to re-import
  // @paperclipai/db (see the vi.mock factory above) -- the first cold import
  // pays a real transform cost, same rationale as
  // deploy-completion-gate-routes.test.ts. Default 5s is too tight for that.
  vi.setConfig({ testTimeout: 30000 });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../storage/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    mockStorage.headObject.mockReset();
    mockStorage.headObject.mockResolvedValue({ exists: true, contentLength: 3, contentType: "image/png" });
  });

  it("returns company branding in the invite summary response", async () => {
    const invite = {
      id: "invite-1",
      companyId: COMPANY_ID,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [invite],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: COMPANY_ID,
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(COMPANY_ID);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.companyBrandColor).toBe("#114488");
    expect(res.body.companyLogoUrl).toBe("/api/invites/pcp_invite_test/logo");
    expect(res.body.inviteType).toBe("company_join");
  }, 30_000);

  it("omits companyLogoUrl when the stored logo object is missing", async () => {
    mockStorage.headObject.mockResolvedValue({ exists: false });

    const invite = {
      id: "invite-1",
      companyId: COMPANY_ID,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [invite],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: COMPANY_ID,
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.companyLogoUrl).toBeNull();
  }, 30_000);

  it("returns pending join-request status for an already-accepted invite", async () => {
    const invite = {
      id: "invite-1",
      companyId: COMPANY_ID,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [invite],
        [{ requestType: "human", status: "pending_approval" }],
        [
          {
            name: "Acme Robotics",
            brandColor: "#114488",
            logoAssetId: "logo-1",
          },
        ],
        [
          {
            companyId: COMPANY_ID,
            objectKey: "company-1/assets/companies/logo-1",
            contentType: "image/png",
            byteSize: 3,
            originalFilename: "logo.png",
          },
        ],
      ),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
    expect(res.body.companyName).toBe("Acme Robotics");
  }, 30_000);

  it("falls back to a reusable human join request when the accepted invite reused an existing queue entry", async () => {
    const invite = {
      id: "invite-2",
      companyId: COMPANY_ID,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-07T00:10:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:05:00.000Z"),
    };
    const reusableJoinRequest = {
      id: "join-1",
      requestType: "human",
      status: "pending_approval",
      requestingUserId: "user-1",
      requestEmailSnapshot: "jane@example.com",
    };
    const companyBranding = {
      name: "Acme Robotics",
      brandColor: "#114488",
      logoAssetId: "logo-1",
    };
    const logoAsset = {
      companyId: COMPANY_ID,
      objectKey: "company-1/assets/companies/logo-1",
      contentType: "image/png",
      byteSize: 3,
      originalFilename: "logo.png",
    };
    const app = await createApp(
      createDbStub(
        [invite],
        [invite],
        [],
        [{ email: "jane@example.com" }],
        [reusableJoinRequest],
        [reusableJoinRequest],
        [companyBranding],
        [companyBranding],
        [logoAsset],
        [logoAsset],
      ),
      { type: "board", userId: "user-1", source: "session" },
    );

    const res = await request(app).get("/api/invites/pcp_invite_test");

    expect(res.status).toBe(200);
    expect(res.body.joinRequestStatus).toBe("pending_approval");
    expect(res.body.joinRequestType).toBe("human");
  }, 30_000);
});
