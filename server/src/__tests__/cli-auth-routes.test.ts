import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb as createRealDb, invites } from "@paperclipai/db";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  listBoardApiKeys: vi.fn(),
  createNamedBoardApiKey: vi.fn(),
  getBoardApiKeyForUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

// DUR-379: GET /invites/:token/skills/:skillName now runs through the
// company-scope middleware (scopeFromInviteToken), which reserves a real
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

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

let appImportCounter = 0;

async function createApp(actor: any, db: any = {} as any) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?cli-auth-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cli-auth-routes-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      memberships: Array.isArray(actor.memberships)
        ? actor.memberships.map((membership: unknown) =>
            typeof membership === "object" && membership !== null
              ? { ...membership }
              : membership,
          )
        : actor.memberships,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(withFakeCompanyScopeReserve(db), {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

// DUR-381: each test re-imports routes/access.js under a fresh module cache
// key (see createApp above) AND now goes through a real reserve/set-claim/
// release round trip per request (see withFakeCompanyScopeReserve) -- both
// add real latency the default 5s test timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

describe.sequential("cli auth routes", () => {
  // DUR-379: vi.resetModules() below forces every test to re-import
  // @paperclipai/db (see the vi.mock factory above) -- the first cold
  // import pays a real transform cost, same rationale as
  // deploy-completion-gate-routes.test.ts. Default 5s is too tight for that.
  vi.setConfig({ testTimeout: 30000 });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("creates a CLI auth challenge with approval metadata", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "pcp_cli_auth_secret",
      pendingBoardToken: "pcp_board_token",
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "pcp_cli_auth_secret",
      approvalPath: "/cli-auth/challenge-1?token=pcp_cli_auth_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body.boardApiToken).toBe("pcp_board_token");
    expect(res.body.approvalUrl).toContain("/cli-auth/challenge-1?token=pcp_cli_auth_secret");
  });

  it.sequential("rejects anonymous access to generic skill documents", async () => {
    const indexApp = await createApp({ type: "none", source: "none" });
    const skillApp = await createApp({ type: "none", source: "none" });

    const indexRes = await request(indexApp).get("/api/skills/index");
    const skillRes = await request(skillApp).get("/api/skills/paperclip");

    expect(indexRes.status, JSON.stringify(indexRes.body)).toBe(401);
    expect(skillRes.status, skillRes.text || JSON.stringify(skillRes.body)).toBe(401);
  });

  // DUR-381: moved to the embedded-postgres describe block below -- this
  // route re-queries the invite via the *scoped* db proxy after
  // scopeFromInviteToken() resolves scope, so a plain mocked `db.select()`
  // chain (which only intercepts the raw object, not the real drizzle
  // instance the scope proxy forwards to) can no longer stand in for it.

  it.sequential("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/challenges/challenge-1?token=pcp_cli_auth_secret");

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.canApprove).toBe(false);
  });

  it.sequential("approves a CLI auth challenge for a signed-in board user", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-1",
      "pcp_cli_auth_secret",
      "user-1",
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "board_api_key.created",
      }),
    );
  });

  it.sequential("logs approve activity for instance admins without company memberships", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-2",
        boardApiKeyId: "board-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-a", "company-b"]);

    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "pcp_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-1",
      requestedCompanyId: null,
      boardApiKeyId: "board-key-2",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("logs revoke activity with resolved audit company ids", async () => {
    mockBoardAuthService.assertCurrentBoardKey.mockResolvedValue({
      id: "board-key-3",
      userId: "admin-2",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-z"]);

    const app = await createApp({
      type: "board",
      userId: "admin-2",
      keyId: "board-key-3",
      source: "board_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app).post("/api/cli-auth/revoke-current").send({});

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-2",
      boardApiKeyId: "board-key-3",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-z",
        action: "board_api_key.revoked",
      }),
    );
  });

  it.sequential("creates a named board API key and logs audit activity", async () => {
    mockBoardAuthService.createNamedBoardApiKey.mockResolvedValue({
      id: "board-key-4",
      name: "external-admin",
      token: "pcp_board_plaintext",
      createdAt: new Date("2026-05-23T12:00:00.000Z"),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: new Date("2026-06-23T12:00:00.000Z"),
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["11111111-1111-4111-8111-111111111111"]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: ["11111111-1111-4111-8111-111111111111"],
    });
    const res = await request(app)
      .post("/api/board-api-keys")
      .send({
        name: "external-admin",
        requestedCompanyId: "11111111-1111-4111-8111-111111111111",
        expiresAt: "2026-06-23T12:00:00.000Z",
      });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      id: "board-key-4",
      name: "external-admin",
      token: "pcp_board_plaintext",
      expiresAt: "2026-06-23T12:00:00.000Z",
    });
    expect(mockBoardAuthService.createNamedBoardApiKey).toHaveBeenCalledWith({
      userId: "user-1",
      name: "external-admin",
      expiresAt: new Date("2026-06-23T12:00:00.000Z"),
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "11111111-1111-4111-8111-111111111111",
        action: "board_api_key.created",
        details: expect.objectContaining({ name: "external-admin" }),
      }),
    );
  });

  it.sequential("lists and revokes named board API keys for the current board user", async () => {
    const keyId = "55555555-5555-4555-8555-555555555555";
    mockBoardAuthService.listBoardApiKeys.mockResolvedValue([
      {
        id: keyId,
        name: "external-admin",
        createdAt: new Date("2026-05-23T12:00:00.000Z"),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    mockBoardAuthService.getBoardApiKeyForUser.mockResolvedValue({
      id: keyId,
      userId: "user-1",
      name: "external-admin",
    });
    mockBoardAuthService.revokeBoardApiKey.mockResolvedValue({
      id: keyId,
      userId: "user-1",
      name: "external-admin",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const listRes = await request(app).get("/api/board-api-keys");
    expect(listRes.status).toBe(200);
    expect(listRes.body[0]).toMatchObject({ id: keyId, name: "external-admin" });
    expect(mockBoardAuthService.listBoardApiKeys).toHaveBeenCalledWith(
      "user-1",
      { includeInactive: false },
    );

    const revokeRes = await request(app).delete(`/api/board-api-keys/${keyId}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body).toEqual({ ok: true, keyId });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "board_api_key.revoked",
      }),
    );
  });

  it.sequential("rejects malformed board API key IDs before database lookup", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).delete("/api/board-api-keys/not-a-uuid");

    expect(res.status).toBe(400);
    expect(mockBoardAuthService.getBoardApiKeyForUser).not.toHaveBeenCalled();
    expect(mockBoardAuthService.revokeBoardApiKey).not.toHaveBeenCalled();
  });
});

// DUR-381: GET /invites/:token/skills/:skillName resolves scope via
// scopeFromInviteToken() (a real rawDb lookup) and then re-queries the
// invite through the *scoped* db proxy inside the handler -- a plain
// `db.select()` mock (as the rest of this file uses for its fully-mocked
// accessService routes) can't stand in for that second, real query, so
// this one route needs an actual reserved Postgres connection end to end.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite-skill test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("GET /invites/:token/skills/:skillName (DUR-381)", () => {
  let realDb!: ReturnType<typeof createRealDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cli-auth-invite-skill-");
    realDb = createRealDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await realDb.delete(invites);
    await realDb.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createRealApp() {
    appImportCounter += 1;
    const routeModulePath = `../routes/access.js?cli-auth-invite-skill-${appImportCounter}`;
    const middlewareModulePath = `../middleware/index.js?cli-auth-invite-skill-${appImportCounter}`;
    const [{ accessRoutes }, { errorHandler }] = await Promise.all([
      import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
      import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
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

  it("serves the invite-scoped paperclip skill anonymously for active invites", async () => {
    const token = "token-123";
    const companyId = randomUUID();
    await realDb.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await realDb.insert(invites).values({
      id: randomUUID(),
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = await createRealApp();
    const res = await request(app).get(`/api/invites/${token}/skills/paperclip`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("# Paperclip Skill");
  });
});
