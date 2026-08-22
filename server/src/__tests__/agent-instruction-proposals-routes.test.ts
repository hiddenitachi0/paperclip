import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalCreate = vi.fn();

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({
    create: mockApprovalCreate,
  }),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => ({ getById: vi.fn() }),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {},
      instructionsStalenessThresholdDays: 60,
    })),
  }),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {},
      instructionsStalenessThresholdDays: 60,
    })),
  }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: vi.fn() }),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({
      create: mockApprovalCreate,
    }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    environmentService: () => ({ getById: vi.fn() }),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        backupRetention: {},
        instructionsStalenessThresholdDays: 60,
      })),
    }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({
        censorUsernameInLogs: false,
        keyboardShortcuts: false,
        feedbackDataSharingPreference: "prompt",
        backupRetention: {},
        instructionsStalenessThresholdDays: 60,
      })),
    }),
  }));
  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => ({ getById: vi.fn() }),
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

const BOSS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeBoss() {
  return {
    id: BOSS_ID,
    companyId: COMPANY_ID,
    name: "Boss Agent",
    role: "manager",
    title: "Manager",
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: {},
    instructionsLastReviewedAt: null,
    updatedAt: new Date(),
  };
}

function makeTarget() {
  return {
    id: TARGET_ID,
    companyId: COMPANY_ID,
    name: "Target Agent",
    role: "engineer",
    title: "Engineer",
    status: "idle",
    reportsTo: BOSS_ID,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: {},
    instructionsLastReviewedAt: null,
    updatedAt: new Date(),
  };
}

async function createAgentApp(actorOverride?: Partial<{ type: string; agentId: string | null; companyIds: string[] }>) {
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
    (req as any).actor = {
      type: "agent",
      agentId: BOSS_ID,
      companyId: COMPANY_ID,
      companyIds: [COMPANY_ID],
      source: "api_key",
      ...actorOverride,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }
}

describe("POST /agents/:id/instruction-proposals", { timeout: 20000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent: unknown, config: unknown) => config);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_self", explanation: "" });
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: TARGET_ID,
      companyId: COMPANY_ID,
      mode: "managed",
      rootPath: "/tmp/target",
      managedRootPath: "/tmp/target",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/target/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 10,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Old instructions\n",
    });
    mockApprovalCreate.mockResolvedValue({
      id: "approval-1",
      companyId: COMPANY_ID,
      type: "request_board_approval",
      status: "pending",
      payload: { kind: "propose_instruction_change" },
    });
  });

  it("allows a boss to propose new instructions for a direct report", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === TARGET_ID) return makeTarget();
      if (id === BOSS_ID) return makeBoss();
      return null;
    });

    const app = await createAgentApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${TARGET_ID}/instruction-proposals`)
        .send({ proposedContent: "# New instructions\n", reason: "The project has shipped new modules." }),
    );

    expect(res.status).toBe(201);
    expect(mockApprovalCreate).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        type: "request_board_approval",
        requestedByAgentId: BOSS_ID,
        payload: expect.objectContaining({
          kind: "propose_instruction_change",
          targetAgentId: TARGET_ID,
          proposerAgentId: BOSS_ID,
          proposedContent: "# New instructions\n",
        }),
      }),
    );
  });

  it("rejects if the caller is not a direct boss of the target", async () => {
    const nonBossTarget = { ...makeTarget(), reportsTo: "other-boss-id" };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === TARGET_ID) return nonBossTarget;
      if (id === BOSS_ID) return makeBoss();
      return null;
    });

    const app = await createAgentApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${TARGET_ID}/instruction-proposals`)
        .send({ proposedContent: "# New\n", reason: "reason" }),
    );

    expect(res.status).toBe(403);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("rejects if the caller tries to propose for itself", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === BOSS_ID) return makeBoss();
      return null;
    });

    const app = await createAgentApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${BOSS_ID}/instruction-proposals`)
        .send({ proposedContent: "# Self\n", reason: "self proposal" }),
    );

    expect(res.status).toBe(403);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("rejects board-authenticated callers", async () => {
    mockAgentService.getById.mockResolvedValue(makeTarget());

    const app = await createAgentApp({ type: "board", agentId: null, companyIds: [COMPANY_ID] });
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${TARGET_ID}/instruction-proposals`)
        .send({ proposedContent: "# Board\n", reason: "board should not propose" }),
    );

    expect(res.status).toBe(403);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("rejects missing proposedContent", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === TARGET_ID) return makeTarget();
      if (id === BOSS_ID) return makeBoss();
      return null;
    });

    const app = await createAgentApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${TARGET_ID}/instruction-proposals`)
        .send({ reason: "reason but no content" }),
    );

    expect(res.status).toBe(400);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown target agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const app = await createAgentApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${TARGET_ID}/instruction-proposals`)
        .send({ proposedContent: "# New\n", reason: "reason" }),
    );

    expect(res.status).toBe(404);
  });
});
