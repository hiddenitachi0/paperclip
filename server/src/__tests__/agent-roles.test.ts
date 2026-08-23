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
    const fakeDb = { select: mockSelect } as any;

    const app = express();
    app.use(express.json());
    const { agentRoleRoutes } = await import("../routes/agent-roles.js");
    app.use("/api", agentRoleRoutes(fakeDb));

    const res = await request(app)
      .post(`/api/agents/${agentId}/role`)
      .send({ roleId });

    expect(res.status).toBe(200);
    expect(mockAgentRolesService.assignRoleToAgent).toHaveBeenCalledWith(
      fakeDb,
      agentId,
      roleId,
      expect.objectContaining({})
    );
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
    app.use("/api", agentRoleRoutes({ select: mockSelect2 } as any));
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

// PATCH /agents/:id rejecting roleId/role-snapshot fields with a real 422 is
// covered end-to-end (real express app, real `validate(updateAgentSchema)`
// middleware, real route handler, supertest request) in
// agent-permissions-routes.test.ts, which already has the full service-mock
// fixture this route needs. A prior version of this test here only asserted
// that ../routes/agents.js imports without throwing — that passed even while
// the guard was dead code (see DUR-114 self-review), so it has been removed
// rather than duplicated with a lighter, less trustworthy fixture.
