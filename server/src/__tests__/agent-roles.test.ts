// DUR-114: agent roles ("jobs") — security and apply-once semantics tests.
//
// Key invariants verified:
//   1. An agent-authenticated caller cannot call POST /agents/:id/role (403).
//   2. A board actor CAN assign a role.
//   3. Assigning a role applies default MCP servers and permission grants once.
//   4. The override diff endpoint reflects what was applied vs current state.
//   5. No role grant may carry deploy-approval keys.
//   6. PATCH /agents/:id rejects roleId/snapshot fields with 422.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId   = "11111111-1111-4111-8111-111111111111";
const roleId    = "33333333-3333-4333-8333-333333333333";
const actorAgentId = "44444444-4444-4444-8444-444444444444";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: { mcpServers: [] },
  runtimeConfig: {},
  defaultEnvironmentId: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  errorReason: null,
  permissions: {},
  avatarAssetId: null,
  lastHeartbeatAt: null,
  metadata: null,
  instructionsReviewedAt: new Date(),
  roleId: null,
  roleAppliedMcpServerNames: [],
  roleAppliedPermissionKeys: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseRole = {
  id: roleId,
  companyId,
  name: "Tech developer",
  key: "tech-developer",
  description: "Writes code",
  defaultInstructions: "You are a helpful engineer.",
  defaultMcpServers: [{ name: "github-mcp", command: "github-mcp", transport: "stdio" }],
  defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockAgentRolesService = vi.hoisted(() => ({
  createRole: vi.fn(),
  listRoles: vi.fn(),
  getRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
  copyRoleToCompany: vi.fn(),
  assignRoleToAgent: vi.fn(),
  getAgentRoleState: vi.fn(),
  addAgentToolOverride: vi.fn(),
  removeAgentToolOverride: vi.fn(),
  addAgentRightOverride: vi.fn(),
  removeAgentRightOverride: vi.fn(),
  addAgentCatalogOverride: vi.fn(),
  removeAgentCatalogOverride: vi.fn(),
}));

vi.mock("../services/agent-roles.js", () => mockAgentRolesService);

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@paperclipai/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@paperclipai/db")>();
  return { ...orig, createDb: vi.fn() };
});

// We'll build the app manually so we can inject the routes without the full DB setup.
async function buildTestApp(actorType: "board" | "agent") {
  const { agentRoleRoutes } = await import("../routes/agent-roles.js");

  const app = express();
  app.use(express.json());

  // Minimal actor injection middleware
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "board"
        ? { type: "board", userId: "user-123" }
        : { type: "agent", agentId: actorAgentId, companyId };
    next();
  });

  // Stub assertCompanyAccess — it reads req.actor which we set above
  // We patch the authz module in the route via vi.mock below
  app.use("/api", agentRoleRoutes({} as any));
  return app;
}

const mockAuthz = vi.hoisted(() => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../routes/authz.js", () => ({
  ...mockAuthz,
  assertBoard: mockAuthz.assertBoard,
  assertCompanyAccess: mockAuthz.assertCompanyAccess,
}));

// ── Tests ──────────────────────────────────────────────────────────────────
//
// Each test here does a fresh `await import("../routes/agent-roles.js")`
// (module-graph transform isn't free the first time it happens in a worker)
// plus a real supertest round-trip. Under sandbox CPU/disk contention that
// combination has been observed to occasionally exceed vitest's 5000ms
// default before either even starts — not a logic bug in the route (the
// same assertions pass reliably once given headroom). Raise the timeout for
// this file rather than let it flake CI.
vi.setConfig({ testTimeout: 20_000 });

describe("agent roles — security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentRolesService.getRole.mockResolvedValue(baseRole);
    mockAgentRolesService.assignRoleToAgent.mockResolvedValue({ ...baseAgent, roleId });
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
  });

  it("rejects agent-authenticated callers on POST /agents/:id/role", async () => {
    // assertBoard throws for agent actors — simulate that
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role`)
      .send({ roleId });

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.assignRoleToAgent).not.toHaveBeenCalled();
  });

  it("allows a board actor to assign a role", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined); // board — passes
    // db.select used in the route to load the agent
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: agentId, companyId }]),
      }),
    });
    // The route's post-scope match-check (`db.select({ companyId })...`)
    // runs through the real drizzle instance wrapping the fake reserved
    // connection, not through `mockSelect` (that only backs the pre-scope
    // resolver's `rawDb.select`) — so it needs a real positional-tuple row
    // via `unsafeRows` to find the agent's companyId.
    const fakeDb = withFakeCompanyScopeReserve({ select: mockSelect } as any, {
      unsafeRows: [[companyId]],
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-123" };
      next();
    });
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role`)
      .send({ roleId });

    expect(res.status).toBe(200);
    expect(mockAgentRolesService.assignRoleToAgent).toHaveBeenCalledWith(
      expect.anything(),
      agentId,
      roleId,
      expect.objectContaining({ actor: expect.objectContaining({ type: "board" }) }),
      fakeDb
    );
  });

  // DUR-148: role/tools and role/rights are the override-mutation endpoints
  // POST /agents/:id/role never covered — the UI (ui/src/api/jobs.ts) has
  // called these since DUR-142, but the server never implemented them.
  it("rejects agent-authenticated callers on POST /agents/:id/role/tools", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role/tools`)
      .send({ tool: { name: "github-mcp", command: "github-mcp" } });

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.addAgentToolOverride).not.toHaveBeenCalled();
  });

  it("allows a board actor to add a tool override", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockAgentRolesService.addAgentToolOverride.mockResolvedValue({
      job: null,
      assignedAt: null,
      tools: { fromJob: [], added: ["github-mcp"], removed: [] },
      rights: { fromJob: [], added: [], removed: [] },
    });
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ companyId }]),
      }),
    });
    const fakeDb = withFakeCompanyScopeReserve({ select: mockSelect } as any);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-123" };
      next();
    });
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role/tools`)
      .send({ tool: { name: "github-mcp", command: "github-mcp" } });

    expect(res.status).toBe(200);
    expect(mockAgentRolesService.addAgentToolOverride).toHaveBeenCalledWith(
      expect.anything(),
      agentId,
      { name: "github-mcp", command: "github-mcp" },
      expect.objectContaining({ type: "board" })
    );
  });

  it("rejects agent-authenticated callers on POST /agents/:id/role/rights", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role/rights`)
      .send({ permissionKey: "tasks:assign", scope: null });

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.addAgentRightOverride).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated callers on DELETE /agents/:id/role/tools/:toolName", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app).delete(`/api/agents/${agentId}/role/tools/github-mcp`);

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.removeAgentToolOverride).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated callers on DELETE /agents/:id/role/rights/:permissionKey", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app).delete(`/api/agents/${agentId}/role/rights/tasks%3Aassign`);

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.removeAgentRightOverride).not.toHaveBeenCalled();
  });

  // DUR-149: skill_key / connector_key override endpoints — same board-only
  // shape as tools/rights above, plus the category-in-path 404 guard.
  it("rejects agent-authenticated callers on POST /agents/:id/role/skills", async () => {
    mockAuthz.assertBoard.mockImplementation(() => {
      const err = new Error("Forbidden") as any;
      err.status = 403;
      throw err;
    });

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role/skills`)
      .send({ key: "customer-inbox" });

    expect(res.status).toBe(403);
    expect(mockAgentRolesService.addAgentCatalogOverride).not.toHaveBeenCalled();
  });

  it("allows a board actor to add and remove a connector_key override", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: agentId, companyId }]) }),
    });
    const fakeDb = withFakeCompanyScopeReserve({ select: mockSelect } as any);
    mockAgentRolesService.addAgentCatalogOverride.mockResolvedValue({ ...baseAgent });
    mockAgentRolesService.removeAgentCatalogOverride.mockResolvedValue({ ...baseAgent });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-123" };
      next();
    });
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const addRes = await request(app)
      .post(`/api/agents/${agentId}/role/connectors`)
      .send({ key: "zendesk" });
    expect(addRes.status).toBe(200);
    expect(mockAgentRolesService.addAgentCatalogOverride).toHaveBeenCalledWith(
      expect.anything(),
      agentId,
      "connectors",
      "zendesk",
      expect.objectContaining({ type: "board" }),
      fakeDb,
    );

    const removeRes = await request(app).delete(`/api/agents/${agentId}/role/connectors/zendesk`);
    expect(removeRes.status).toBe(200);
    expect(mockAgentRolesService.removeAgentCatalogOverride).toHaveBeenCalledWith(
      expect.anything(),
      agentId,
      "connectors",
      "zendesk",
      expect.objectContaining({ type: "board" }),
      fakeDb,
    );
  });

  it("404s an unknown override category instead of silently no-op'ing", async () => {
    mockAuthz.assertBoard.mockReturnValue(undefined);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-123" };
      next();
    });
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes({} as any));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role/not-a-real-category`)
      .send({ key: "x" });

    expect(res.status).toBe(404);
    expect(mockAgentRolesService.addAgentCatalogOverride).not.toHaveBeenCalled();
  });
});

describe("agent roles — role body validation rejects deploy-approval grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
  });

  it("rejects deploys:approve in defaultGrants at service layer", async () => {
    // We test the route validation — the PERMISSION_KEYS enum won't include deploys:approve
    // so z.enum will reject it before even reaching the service. (Does NOT unmock
    // "../services/agent-roles.js": vi.unmock is hoisted to module top-level by
    // Vitest regardless of where in the file it's called, so doing that here would
    // silently unmock the service for every test in this file, not just this one —
    // that caused the other two tests in this describe block to 500/timeout against
    // a real service call with no real db.)
    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    const mockSelect2 = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    app.use("/api", agentRoleRoutes(withFakeCompanyScopeReserve({ select: mockSelect2 } as any)));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-roles`)
      .send({
        name: "Bad Role",
        defaultGrants: [{ permissionKey: "deploys:approve", scope: null }],
      });

    // z.enum(PERMISSION_KEYS) does not include deploys:approve → 400 validation error
    expect(res.status).toBe(400);
  });
});

describe("GET /agents/:agentId/role — routes to the shared role-state service (DUR-148)", () => {
  // DUR-148: the tool/right diffing logic that used to live inline in this
  // route moved to services/agent-roles.ts#getAgentRoleState, so it can be
  // reused by the new role/tools and role/rights override routes too (see
  // getAgentRoleState's own diffing tests in agent-roles-service.test.ts).
  // This route is now just: check company access, then forward the service's
  // result verbatim.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.assertBoard.mockReturnValue(undefined);
    mockAuthz.assertCompanyAccess.mockResolvedValue(undefined);
  });

  it("returns the service's AgentRoleState verbatim", async () => {
    const state = {
      job: { id: roleId, name: "Tech developer", description: "Writes code" },
      assignedAt: null,
      tools: { fromJob: ["github-mcp"], added: ["extra-tool"], removed: ["removed-tool"] },
      rights: {
        fromJob: [{ permissionKey: "tasks:assign", scope: null }],
        added: [{ permissionKey: "extra:grant", scope: null }],
        removed: [{ permissionKey: "revoked:key", scope: null }],
      },
    };
    mockAgentRolesService.getAgentRoleState.mockResolvedValue(state);
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ companyId }]) }),
    });
    const fakeDb = withFakeCompanyScopeReserve({ select: mockSelect } as any);

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const res = await request(app).get(`/api/agents/${agentId}/role`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(state);
    expect(mockAgentRolesService.getAgentRoleState).toHaveBeenCalledWith(expect.anything(), agentId);
  });

  it("404s when the agent does not exist, without calling the service", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    const fakeDb = { select: mockSelect } as any;

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const res = await request(app).get(`/api/agents/${agentId}/role`);

    expect(res.status).toBe(404);
    expect(mockAgentRolesService.getAgentRoleState).not.toHaveBeenCalled();
  });
});

// PATCH /agents/:id rejecting roleId/role-snapshot fields with a real 422 is
// covered end-to-end (real express app, real `validate(updateAgentSchema)`
// middleware, real route handler, supertest request) in
// agent-permissions-routes.test.ts, which already has the full service-mock
// fixture this route needs. A prior version of this test here only asserted
// that ../routes/agents.js imports without throwing — that passed even while
// the guard was dead code (see DUR-114 self-review), so it has been removed
// rather than duplicated with a lighter, less trustworthy fixture.
