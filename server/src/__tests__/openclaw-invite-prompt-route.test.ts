import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { assets, companies, companyLogos, createDb, invites } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// DUR-381: every request now does a real reserve/set-claim/release round
// trip through embedded Postgres -- real latency the default 5s test
// timeout doesn't leave much room for.
vi.setConfig({ testTimeout: 15_000 });

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  isInstanceAdmin: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  setPrincipalGrants: vi.fn(),
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
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockStorage = vi.hoisted(() => ({
  headObject: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  deduplicateAgentName: vi.fn(),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: () => mockStorage,
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// DUR-381: POST /companies/:companyId/openclaw/invite-prompt now runs under
// companyScopeFromParam(rawDb, assertCanGenerateOpenClawInvitePrompt) and GET
// /invites/:token under scopeFromInviteToken() -- both reserve a real
// Postgres connection (UUID-validated companyId for the former, an invite
// row's resolved companyId for the latter) and the handlers' own
// insert/select queries run through that *scoped* db proxy. A hand-rolled
// table-shape-sniffing mock (the file's original approach) can't stand in
// for that real query, so this needs an actual embedded Postgres database
// end to end. See company-user-directory-route.test.ts for the same pattern.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres openclaw-invite-prompt-route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/openclaw/invite-prompt", () => {
  let realDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-openclaw-invite-prompt-");
    realDb = createDb(tempDb.connectionString);
  }, 30_000);

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

  beforeEach(() => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentService.getById.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
    mockStorage.headObject.mockResolvedValue({ exists: true, contentLength: 3, contentType: "image/png" });
  });

  async function createCompanyRow(companyId: string, overrides: Partial<typeof companies.$inferInsert> = {}) {
    await realDb.insert(companies).values({
      id: companyId,
      name: "Acme AI",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      brandColor: "#225577",
      ...overrides,
    });
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
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

  it("rejects non-CEO agent callers", async () => {
    const companyId = randomUUID();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "engineer",
      permissions: {},
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Missing permission to generate OpenClaw invite prompts");
  });

  it("rejects a ceo-titled agent once canManageCompanySettings is explicitly revoked", async () => {
    const companyId = randomUUID();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "ceo",
      permissions: { canManageCompanySettings: false },
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Missing permission to generate OpenClaw invite prompts");
  });

  it("rejects CEO agent callers outside the target company scope", async () => {
    const targetCompanyId = randomUUID();
    const actorCompanyId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: actorCompanyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${targetCompanyId}/openclaw/invite-prompt`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another company");
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    const createdInvites = await realDb.select().from(invites).where(eq(invites.companyId, targetCompanyId));
    expect(createdInvites).toHaveLength(0);
  });

  it("allows CEO agent callers and creates an agent-only invite", async () => {
    const companyId = randomUUID();
    await createCompanyRow(companyId);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "ceo",
      permissions: { canManageCompanySettings: true },
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({ agentMessage: "Join and configure OpenClaw gateway." });

    expect([200, 201]).toContain(res.status);
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.onboardingTextPath).toContain("/api/invites/");
    const createdInvites = await realDb.select().from(invites).where(eq(invites.companyId, companyId));
    expect(createdInvites).toHaveLength(1);
    expect(createdInvites[0]).toEqual(
      expect.objectContaining({
        companyId,
        inviteType: "company_join",
        allowedJoinTypes: "agent",
      }),
    );
  });

  it("allows a non-ceo agent with an explicit canManageCompanySettings grant", async () => {
    const companyId = randomUUID();
    await createCompanyRow(companyId);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId,
      role: "engineering-manager",
      permissions: { canManageCompanySettings: true },
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({ agentMessage: "Join and configure OpenClaw gateway." });

    expect([200, 201]).toContain(res.status);
  });

  it("includes companyName in invite summary responses", async () => {
    const companyId = randomUUID();
    await createCompanyRow(companyId);
    const [asset] = await realDb
      .insert(assets)
      .values({
        companyId,
        provider: "s3",
        objectKey: `${companyId}/assets/companies/logo-1`,
        contentType: "image/png",
        byteSize: 3,
        sha256: "deadbeef",
        originalFilename: "logo.png",
      })
      .returning();
    await realDb.insert(companyLogos).values({ companyId, assetId: asset.id });

    const token = "pcp_invite_test";
    await realDb.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/invites/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.companyBrandColor).toBe("#225577");
    expect(res.body.companyLogoUrl).toBe(`/api/invites/${token}/logo`);
    expect(res.body.inviteType).toBe("company_join");
    expect(res.body.allowedJoinTypes).toBe("agent");
  });

  it("allows board callers with invite permission", async () => {
    const companyId = randomUUID();
    await createCompanyRow(companyId);
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({});

    expect([200, 201]).toContain(res.status);
    expect(res.body.companyName).toBe("Acme AI");
    expect(res.body.inviteUrl).toContain("/invite/");
    expect(res.body.onboardingTextPath).toContain("/api/invites/");
  }, 15_000);

  it("rejects board callers without invite permission", async () => {
    const companyId = randomUUID();
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/openclaw/invite-prompt`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });
});
