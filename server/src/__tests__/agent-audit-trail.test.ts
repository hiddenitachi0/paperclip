import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A human acting through the board can still change an agent's job title
// (role) or tool connections (adapterConfig.mcpServers) exactly as before --
// only agent-authenticated callers were closed off (see
// agent-self-update-guard.test.ts). This file proves that any such change,
// by any actor the guard still lets through, produces an operator-visible,
// plain-language activity log entry: which agent, what changed (old value ->
// new value), who did it. Also covers the same for a change to an agent's
// rights (permissions).

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const revisionId = "44444444-4444-4444-8444-444444444444";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Engineer",
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
  permissions: { canCreateAgents: false, canCreateSkills: true, trustPreset: "standard" },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
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

describe("agent role/rights/tool-connection audit trail", () => {
  const boardActor = {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id: string) => (id === agentId ? baseAgent : null));
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      id,
      ...patch,
    }));
    mockAgentService.updatePermissions.mockImplementation(async (id: string, permissions: Record<string, unknown>) => ({
      ...baseAgent,
      id,
      permissions: { ...baseAgent.permissions, ...permissions },
    }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_test_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(async (agent: { adapterConfig: unknown }) => ({
      adapterConfig: agent.adapterConfig,
    }));
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("records old -> new role in plain language when a board caller changes an agent's job title", { timeout: 20000 }, async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ role: "ceo" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const call = mockLogActivity.mock.calls.find(([, input]) => input.action === "agent.updated");
    expect(call).toBeTruthy();
    const [, input] = call!;
    expect(input.entityId).toBe(agentId);
    expect(input.actorType).toBe("user");
    expect(input.details.roleChange).toEqual({ from: "engineer", to: "ceo" });
  });

  it("records old -> new title in plain language when a board caller changes an agent's display title", { timeout: 20000 }, async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ title: "Staff Engineer" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.updated")!;
    expect(input.details.titleChange).toEqual({ from: "Engineer", to: "Staff Engineer" });
  });

  it("records an added tool connection, by name and capability, when a board caller adds one", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({
        adapterConfig: { mcpServers: [{ name: "shell", command: "bash", args: ["-c", "whoami"] }] },
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.updated")!;
    expect(input.details.toolConnectionChange.added).toEqual([
      { name: "shell", capability: expect.stringContaining("bash") },
    ]);
    expect(input.details.toolConnectionChange.removed).toEqual([]);
  });

  it("records a removed tool connection when a board caller replaces adapterConfig without it", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === agentId
        ? { ...baseAgent, adapterConfig: { mcpServers: [{ name: "shell", command: "bash" }] } }
        : null,
    );
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({
        replaceAdapterConfig: true,
        adapterConfig: {},
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.updated")!;
    expect(input.details.toolConnectionChange.removed).toEqual([{ name: "shell" }]);
    expect(input.details.toolConnectionChange.added).toEqual([]);
  });

  it("does not attach a toolConnectionChange when adapterConfig changes but mcpServers does not", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ adapterConfig: { model: "gpt-5.4" } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.updated")!;
    expect(input.details.toolConnectionChange).toBeUndefined();
  });

  it("records role and tool-connection changes on a config-revision rollback", async () => {
    const afterConfig = {
      ...baseAgent,
      role: "ceo",
      adapterConfig: { mcpServers: [{ name: "shell", command: "bash" }] },
    };
    mockAgentService.getConfigRevision.mockResolvedValue({ id: revisionId, agentId, afterConfig });
    mockAgentService.rollbackConfigRevision.mockResolvedValue(afterConfig);

    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.config_rolled_back")!;
    expect(input.details.roleChange).toEqual({ from: "engineer", to: "ceo" });
    expect(input.details.toolConnectionChange.added).toEqual([
      { name: "shell", capability: expect.stringContaining("bash") },
    ]);
  });

  it("records the old -> new rights (permissions) when the board changes an agent's permissions", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}/permissions`).send({ canCreateAgents: true, canAssignTasks: false, canCreateSkills: true, trustPreset: "standard" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, input] = mockLogActivity.mock.calls.find(([, i]) => i.action === "agent.permissions_updated")!;
    expect(input.details.canCreateAgents).toBe(true);
    expect(input.details._previous.canCreateAgents).toBe(false);
    expect(input.actorType).toBe("user");
  });
});
