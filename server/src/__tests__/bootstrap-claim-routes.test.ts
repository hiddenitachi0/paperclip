import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { accessRoutes } from "../routes/access.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";
import { createDb as createRealDb, invites } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const claimFirstInstanceAdminMock = vi.hoisted(() => vi.fn());
const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

vi.mock("../first-admin-claim.js", () => ({
  claimFirstInstanceAdmin: claimFirstInstanceAdminMock,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createCliAuthChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// DUR-381: every route in this file now establishes company-scope bypass
// (companyScopeBypassForRoute) before it runs, which reserves a real
// connection (rawDb.$client.reserve()) -- this fake db needs that lifecycle
// satisfied even though it never issues a real query itself (POST
// /bootstrap/claim never touches `db` directly; claimFirstInstanceAdmin is
// mocked below). See helpers/fake-scoped-db.ts.
function createDb() {
  return withFakeCompanyScopeReserve({}) as any;
}

function createApp(input: {
  actor?: Record<string, unknown>;
  deploymentMode?: "authenticated" | "local_trusted";
  deploymentExposure?: "private" | "public";
  guardMutations?: boolean;
  db?: Record<string, unknown>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = input.actor ?? {
      type: "board",
      source: "session",
      userId: "user-1",
    };
    next();
  });
  if (input.guardMutations) {
    app.use(boardMutationGuard());
  }
  app.use(
    "/api",
    accessRoutes(input.db as any ?? createDb(), {
      deploymentMode: input.deploymentMode ?? "authenticated",
      deploymentExposure: input.deploymentExposure ?? "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /bootstrap/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimFirstInstanceAdminMock.mockResolvedValue({
      status: "claimed",
      userId: "user-1",
      value: null,
    });
  });

  it("claims first admin for an authenticated private browser session", async () => {
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true, userId: "user-1" });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(expect.anything(), { userId: "user-1" });
  });

  it("is not exposed in authenticated public mode", async () => {
    const app = createApp({ deploymentExposure: "public" });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("is not exposed in local trusted mode", async () => {
    const app = createApp({ deploymentMode: "local_trusted" });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "none", source: "none" }, "anonymous caller"],
    [{ type: "agent", source: "agent_key", agentId: "agent-1" }, "agent key"],
    [{ type: "board", source: "board_key", userId: "user-1" }, "board API key"],
    [{ type: "board", source: "local_implicit", userId: "local-board" }, "local implicit board"],
  ])("rejects %s before opening the first-admin transaction", async (actor) => {
    const app = createApp({ actor });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(401);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("returns conflict when first admin has already been claimed", async () => {
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });

  it("stays behind the board mutation origin guard", async () => {
    const app = createApp({ guardMutations: true });

    const blocked = await request(app).post("/api/bootstrap/claim").send({});
    expect(blocked.status).toBe(403);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();

    const allowed = await request(app)
      .post("/api/bootstrap/claim")
      .set("Host", "paperclip.local")
      .set("Origin", "http://paperclip.local")
      .send({});
    expect(allowed.status).toBe(200);
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledTimes(1);
  });
});

// DUR-381: unlike POST /bootstrap/claim above, POST /invites/:token/accept
// makes a real inline `db.select()` against the *scoped* connection (see
// access.ts's accept handler) after companyScopeBypassForRoute has entered
// bypass scope for this bootstrap_ceo (companyId-less) invite -- the fake
// reserved connection from helpers/fake-scoped-db.ts only satisfies the
// reserve/claim/release lifecycle, not a real query, so this describe block
// needs a real embedded Postgres invites row instead.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres bootstrap invite acceptance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("bootstrap invite first-admin acceptance", () => {
  let realDb!: ReturnType<typeof createRealDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bootstrap-claim-routes-");
    realDb = createRealDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await realDb.delete(invites);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function seedBootstrapInvite() {
    const inviteId = randomUUID();
    await realDb.insert(invites).values({
      id: inviteId,
      companyId: null,
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "human",
      tokenHash: hashToken("pcp_invite_test"),
      defaultsPayload: {},
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: null,
    });
    return inviteId;
  }

  it("uses the shared first-admin helper for bootstrap invite acceptance", async () => {
    const inviteId = await seedBootstrapInvite();
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "claimed",
      userId: "user-1",
      value: { id: inviteId, inviteType: "bootstrap_ceo", acceptedAt: new Date("2026-03-07T00:01:00.000Z") },
    });
    const app = createApp({ db: realDb as any });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      inviteId,
      inviteType: "bootstrap_ceo",
      bootstrapAccepted: true,
      userId: "user-1",
    });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", onClaim: expect.any(Function) }),
    );
  });

  it("conflicts cleanly when browser claim already won before invite acceptance", async () => {
    await seedBootstrapInvite();
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({ db: realDb as any });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });
});
