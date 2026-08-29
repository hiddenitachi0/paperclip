import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// DUR-381: every request now does a real reserve/set-claim/release round
// trip through embedded Postgres -- real latency the default 5s test
// timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

// DUR-379: GET /companies/:companyId/user-directory now runs through the
// company-scope middleware (companyScopeFromParam), which reserves a real
// connection via runInCompanyScope -- this test's hand-rolled db stub isn't
// a real Db, so it can't back that reservation. Bypass the reservation
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

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
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
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

// DUR-381: GET /companies/:companyId/user-directory now runs under
// companyScopeFromParam(rawDb, assertCompanyAccess) -- a real reserved
// Postgres connection with a UUID-validated companyId, and its handler
// re-queries companyMemberships/authUsers through that *scoped* db proxy.
// A hand-rolled table-shape-sniffing mock (the file's original approach)
// can't stand in for that real query, so this needs an actual embedded
// Postgres database end to end.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-user-directory tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /companies/:companyId/user-directory", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-user-directory-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await realDb.delete(companyMemberships);
    await realDb.delete(authUsers);
    await realDb.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actor: Express.Request["actor"]) {
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
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

  it("returns active human users for operators without manage-permissions access", async () => {
    const companyId = randomUUID();
    const now = new Date();
    await realDb.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await realDb.insert(authUsers).values([
      {
        id: "user-1",
        name: "Dotta",
        email: "dotta@example.com",
        image: "https://example.com/dotta.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "user-2",
        name: "",
        email: "alex@example.com",
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await realDb.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "user-2", status: "active", updatedAt: now },
      {
        companyId,
        principalType: "user",
        principalId: "user-1",
        status: "active",
        updatedAt: new Date(now.getTime() + 1000),
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    });

    const res = await request(app).get(`/api/companies/${companyId}/user-directory`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
        },
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: "", email: "alex@example.com", image: null },
        },
      ],
    });
  });
});
