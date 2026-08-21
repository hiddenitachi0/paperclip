import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-55 / DUR-56: an agent-authenticated caller must never be able to
// change its own (or another agent's) job title, and must never be able to
// add/change a tool connection (MCP server) on any agent's adapterConfig.
// Both holes came from `allow_self` granting blanket write access to an
// agent's own record with no field-level guard. These tests prove the
// guard added in server/src/routes/agents.ts closes both holes while
// leaving board-authenticated (human) updates and unrelated agent
// self-updates unaffected.

const agentId = "11111111-1111-4111-8111-111111111111";
const peerAgentId = "33333333-3333-4333-8333-333333333333";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  defaultEnvironmentId: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  syncEnvBindingsForTarget: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();

  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: companyId, requireBoardApprovalForNewAgents: false }]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("agent self-update guard (DUR-55 / DUR-56)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === agentId) return baseAgent;
      if (id === peerAgentId) return { ...baseAgent, id: peerAgentId, role: "general" };
      return null;
    });
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      id,
      ...patch,
    }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_test_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(async (agent: { adapterConfig: unknown }) => ({
      adapterConfig: agent.adapterConfig,
    }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  const agentActor = { type: "agent", agentId, companyId, runId: "run-1", source: "agent_key" };
  const boardActor = {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };

  describe("role", () => {
    it("rejects an agent-authenticated caller changing its own role", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller changing another agent's role", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${peerAgentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to change an agent's role", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ role: "ceo" }),
        expect.anything(),
      );
    });

    it("still allows an agent to update unrelated fields on itself", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ capabilities: "writes tests" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  describe("adapterConfig.mcpServers", () => {
    const mcpPatch = {
      adapterConfig: {
        mcpServers: [{ name: "shell", command: "bash", args: ["-c", "whoami"] }],
      },
    };

    it("rejects an agent-authenticated caller adding a tool connection to itself", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send(mcpPatch),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller adding a tool connection to another agent", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${peerAgentId}`).send(mcpPatch),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to set a tool connection", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send(mcpPatch),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
      const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      const adapterConfig = patch.adapterConfig as Record<string, unknown>;
      expect(adapterConfig.mcpServers).toEqual(mcpPatch.adapterConfig.mcpServers);
    });

    it("still allows an agent to touch adapterConfig fields that are not mcpServers", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ adapterConfig: { model: "gpt-5.4" } }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });
});
