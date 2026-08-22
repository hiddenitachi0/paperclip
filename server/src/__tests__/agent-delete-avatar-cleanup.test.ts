import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  remove: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockAssetService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(),
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    assetService: () => mockAssetService,
    companySkillService: () => ({}),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => ({ normalizeAdapterConfigForPersistence: vi.fn(), resolveAdapterConfigForRuntime: vi.fn() }),
    syncInstructionsBundleConfigFromFilePath: vi.fn(),
    workspaceOperationService: () => ({}),
    environmentService: () => ({}),
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({ getGeneral: vi.fn() }),
  }));
}

function createDbStub() {
  const deleteCalls: Array<{ id: unknown }> = [];
  const del = vi.fn(() => ({
    where: vi.fn((condition: unknown) => {
      deleteCalls.push({ id: condition });
      return Promise.resolve();
    }),
  }));
  return { delete: del, deleteCalls };
}

function createStorage() {
  const deleteObject = vi.fn().mockResolvedValue(undefined);
  return {
    provider: "local_disk" as const,
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject,
  } satisfies StorageService;
}

async function createApp(db: ReturnType<typeof createDbStub>, storage: StorageService) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    } as any;
    next();
  });
  app.use("/api", agentRoutes(db as any, { storageService: storage }));
  app.use(errorHandler);
  return app;
}

describe("DELETE /api/agents/:id avatar cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
  });

  it("deletes the asset row and stored object when the removed agent had a picture", async () => {
    mockAgentService.getById.mockResolvedValue({ id: agentId, companyId });
    mockAgentService.remove.mockResolvedValue({ id: agentId, companyId, avatarAssetId: "asset-old" });
    mockAssetService.getById.mockResolvedValue({ id: "asset-old", objectKey: "assets/agents/old.png" });

    const db = createDbStub();
    const storage = createStorage();
    const app = await createApp(db, storage);

    const res = await request(app).delete(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(mockAssetService.getById).toHaveBeenCalledWith("asset-old");
    expect(db.deleteCalls).toHaveLength(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(companyId, "assets/agents/old.png");
  });

  it("does nothing extra when the removed agent had no picture", async () => {
    mockAgentService.getById.mockResolvedValue({ id: agentId, companyId });
    mockAgentService.remove.mockResolvedValue({ id: agentId, companyId, avatarAssetId: null });

    const db = createDbStub();
    const storage = createStorage();
    const app = await createApp(db, storage);

    const res = await request(app).delete(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(mockAssetService.getById).not.toHaveBeenCalled();
    expect(db.deleteCalls).toHaveLength(0);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
