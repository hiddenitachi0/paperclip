import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, invites } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// DUR-381: POST /companies/:companyId/invites now runs under
// companyScopeFromParam(rawDb, assertCompanyPermission) -- a real reserved
// Postgres connection with a UUID-validated companyId -- and its handler
// issues two differently-shaped queries through that *scoped* db proxy (an
// INSERT ... RETURNING into `invites`, and a SELECT ... LEFT JOIN against
// `companies`/`companyLogos` for branding). A hand-rolled mock can't stand
// in for both of those against a real query builder, so this needs an
// actual embedded Postgres database end to end. Real reserve/set-claim/
// release round trips + embedded-postgres add latency the default 5s test
// timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

const logActivityMock = vi.fn();

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
  logActivity: (...args: unknown[]) => logActivityMock(...args),
  notifyHireApproved: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite-create tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/invites", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-create-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await realDb.delete(invites);
    await realDb.delete(companies);
    logActivityMock.mockReset();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(companyId: string) {
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [companyId],
      };
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

  it("returns an absolute invite URL using the request base URL", async () => {
    const companyId = randomUUID();
    await realDb.insert(companies).values({
      id: companyId,
      name: "Acme Robotics",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const app = await createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/invites`)
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/pcp_invite_/);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\/invite\/pcp_invite_/);
  });
});
