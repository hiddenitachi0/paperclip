import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockStorage = vi.hoisted(() => ({
  getObject: vi.fn(),
  headObject: vi.fn(),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => mockStorage,
}));

// DUR-379: GET /invites/:token/logo now runs through the company-scope
// middleware (scopeFromInviteToken), which reserves a real connection via
// runInCompanyScope -- this test's hand-rolled call-index db stub isn't a
// real Db, so it can't back that reservation. Bypass the reservation
// machinery in tests, running the callback with the test's own db as the
// "scoped" db directly, no real connection involved.
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
    withCompanyScope: async (rawDb: any, _companyId: string, fn: (tx: unknown) => unknown) => rawDb.transaction(fn),
  };
});

import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

function createSelectChain(rows: unknown[]) {
  const query = {
    leftJoin() {
      return query;
    },
    where() {
      return Promise.resolve(rows);
    },
  };
  return {
    from() {
      return query;
    },
  };
}

function createDbStub(inviteRows: unknown[], companyRows: unknown[]) {
  let selectCall = 0;
  return {
    select() {
      selectCall += 1;
      // DUR-379: calls 1 and 2 are both the invite lookup now -- the
      // company-scope resolver's own pre-scope lookup, then the route
      // handler's post-scope re-fetch (see scopeFromInviteToken).
      return selectCall === 1 || selectCall === 2
        ? createSelectChain(inviteRows)
        : createSelectChain(companyRows);
    },
  };
}

function createApp(db: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "anon" };
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

describe("GET /invites/:token/logo", () => {
  beforeEach(() => {
    mockStorage.getObject.mockReset();
    mockStorage.headObject.mockReset();
  });

  it("serves the company logo for an active invite without company auth", async () => {
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
    const app = createApp(
      createDbStub([invite], [{
        companyId: COMPANY_ID,
        objectKey: "assets/companies/logo-1",
        contentType: "image/png",
        byteSize: 3,
        originalFilename: "logo.png",
      }]),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(mockStorage.headObject).toHaveBeenCalledWith(COMPANY_ID, "assets/companies/logo-1");
    expect(mockStorage.getObject).toHaveBeenCalledWith(COMPANY_ID, "assets/companies/logo-1");
  });

  it("returns 404 when the logo asset record exists but storage does not", async () => {
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
    mockStorage.headObject.mockResolvedValue({ exists: false });
    const app = createApp(
      createDbStub([invite], [{
        companyId: COMPANY_ID,
        objectKey: "assets/companies/logo-1",
        contentType: "image/png",
        byteSize: 3,
        originalFilename: "logo.png",
      }]),
    );

    const res = await request(app).get("/api/invites/pcp_invite_test/logo");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Invite logo not found");
    expect(mockStorage.getObject).not.toHaveBeenCalled();
  });
});
