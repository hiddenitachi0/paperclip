import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-4378 follow-up (live incident, 2 Oct Oslo): adapterConfig.laneA.apiKey
// was a single slot shared by every provider. Switching a quick agent's
// provider (OpenRouter -> local -> OpenRouter) left that slot holding
// whatever the most recently used provider's key was, so the agent answered
// "This quick agent has no OpenRouter key" after switching back even though
// the operator had never removed it. These tests prove the fix in
// server/src/routes/agents.ts's PATCH /agents/:id handler: a provider switch
// stashes the outgoing provider's key under adapterConfig.laneA.apiKeyByProvider
// and restores the incoming provider's own key (or null, if it has none)
// instead of carrying the old provider's key forward or dropping it.
//
// This file mocks the service layer the same way agent-self-update-guard.test.ts
// does -- it exercises the route handler's merge logic, not real DB company scope.
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  const { requestCompanyScopeStorage } = await import("@paperclipai/db/company-scope");
  return {
    ...actual,
    runInCompanyScope: async (rawDb: unknown, companyId: string, fn: () => Promise<unknown>) =>
      requestCompanyScopeStorage.run({ kind: "scoped", companyId, scopedDb: rawDb } as never, fn),
  };
});

// Cold transform of this module graph (express + the full agents route file)
// is slow on first import, same as lane-a-provider-key.test.ts.
vi.setConfig({ testTimeout: 20_000 });

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const openrouterKeyRef = {
  type: "secret_ref",
  secretId: "44444444-4444-4444-8444-444444444444",
  version: "latest" as const,
};

function baseAgentWith(
  laneA: Record<string, unknown>,
  laneAProvider: string | null,
  laneABaseUrl: string | null = null,
) {
  return {
    id: agentId,
    companyId,
    name: "Maja",
    urlKey: "maja",
    role: "engineer",
    title: "Maja",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: { laneA },
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    laneAEnabled: true,
    laneAProvider,
    laneAModel: null,
    laneABaseUrl,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
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
    isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
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

const boardActor = {
  type: "board",
  userId: "board-user",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
};

describe("quick-agent provider switch preserves each provider's own key (DUR-4378 follow-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      companyId,
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

  it("stashes the outgoing provider's key and clears the field for a provider that never had one", async () => {
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith({ apiKey: openrouterKeyRef }, "openrouter"),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ laneAProvider: "local", laneAModel: null }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const laneA = (patch.adapterConfig as { laneA: Record<string, unknown> }).laneA;
    // The new provider (local) never had its own key, so the visible slot is empty.
    expect(laneA.apiKey).toBeNull();
    // But the outgoing provider's key is preserved, not dropped.
    expect(laneA.apiKeyByProvider).toMatchObject({ openrouter: openrouterKeyRef });
  });

  it("restores a provider's own key when switching back to it", async () => {
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: null, apiKeyByProvider: { openrouter: openrouterKeyRef } },
        "local",
      ),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ laneAProvider: "openrouter", laneAModel: null }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const laneA = (patch.adapterConfig as { laneA: Record<string, unknown> }).laneA;
    // OpenRouter's previously-saved key comes back, not "no key".
    expect(laneA.apiKey).toMatchObject(openrouterKeyRef);
    // local's (empty) key was stashed on the way out.
    expect(laneA.apiKeyByProvider).toMatchObject({ local: null, openrouter: openrouterKeyRef });
  });

  it("an explicit key in the same request wins over the restored one", async () => {
    const newKeyRef = {
      type: "secret_ref",
      secretId: "55555555-5555-4555-8555-555555555555",
      version: "latest" as const,
    };
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: null, apiKeyByProvider: { openrouter: openrouterKeyRef } },
        "local",
      ),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ laneAProvider: "openrouter", laneAModel: null, adapterConfig: { laneA: { apiKey: newKeyRef } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const laneA = (patch.adapterConfig as { laneA: Record<string, unknown> }).laneA;
    expect(laneA.apiKey).toMatchObject(newKeyRef);
  });

  it("accepts a later PATCH that echoes adapterConfig.laneA.apiKeyByProvider back unchanged", async () => {
    // Regression for the schema gap this fix introduced: laneAAdapterConfigSchema
    // is .strict(), so a settings-form round trip that reads the agent back and
    // PATCHes its adapterConfig.laneA verbatim (now containing apiKeyByProvider)
    // must not be rejected with a 422 for an "unrecognized key".
    const laneAWithStash = {
      apiKey: null,
      apiKeyByProvider: { openrouter: openrouterKeyRef },
    };
    mockAgentService.getById.mockResolvedValue(baseAgentWith(laneAWithStash, "local"));
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { laneA: laneAWithStash } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("leaves apiKeyByProvider untouched when the provider does not change", async () => {
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: openrouterKeyRef, apiKeyByProvider: { openrouter: openrouterKeyRef } },
        "openrouter",
      ),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ laneATemperature: 0.5 }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    expect(Object.prototype.hasOwnProperty.call(patch, "adapterConfig")).toBe(false);
  });
});

describe("quick-agent provider switch preserves each provider's own base URL (DUR-4395)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      companyId,
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

  it("does not leak a restored key to a stale custom base URL left by another provider", async () => {
    // Repro from DUR-4395: an agent on openrouter with key K bound switches to
    // local with an attacker-controlled base URL (K gets stashed), then
    // switches back to openrouter with no laneABaseUrl in that second patch.
    // Before this fix, K came back into laneA.apiKey while laneABaseUrl was
    // still the attacker's host, so the very next call sent K there as a
    // bearer token.
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith({ apiKey: openrouterKeyRef }, "openrouter", null),
    );
    const app = await createApp(boardActor);

    const switchToLocal = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ laneAProvider: "local", laneAModel: null, laneABaseUrl: "http://attacker.example/v1" }),
    );
    expect(switchToLocal.status, JSON.stringify(switchToLocal.body)).toBe(200);
    const [, firstPatch] = mockAgentService.update.mock.calls[0]!;
    const firstLaneA = (firstPatch.adapterConfig as { laneA: Record<string, unknown> }).laneA;
    expect(firstLaneA.baseUrlByProvider).toMatchObject({ openrouter: null });

    // Second PATCH resumes from the persisted state after the first switch.
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: null, apiKeyByProvider: { openrouter: openrouterKeyRef }, baseUrlByProvider: { openrouter: null } },
        "local",
        "http://attacker.example/v1",
      ),
    );

    const switchBack = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ laneAProvider: "openrouter", laneAModel: null }),
    );
    expect(switchBack.status, JSON.stringify(switchBack.body)).toBe(200);
    const [, secondPatch] = mockAgentService.update.mock.calls[1]!;
    const secondLaneA = (secondPatch.adapterConfig as { laneA: Record<string, unknown> }).laneA;
    expect(secondLaneA.apiKey).toMatchObject(openrouterKeyRef);
    // The attacker's host must not survive the switch back: openrouter never
    // had a custom base URL of its own, so it must be restored to null.
    expect(secondPatch.laneABaseUrl).toBeNull();
  });

  it("restores a provider's own previously-set base URL when switching back to it", async () => {
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: null, baseUrlByProvider: { openrouter: "https://my-router.example/v1" } },
        "local",
        null,
      ),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch(`/api/agents/${agentId}`).send({ laneAProvider: "openrouter", laneAModel: null }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    expect(patch.laneABaseUrl).toBe("https://my-router.example/v1");
  });

  it("an explicit laneABaseUrl in the same switch request wins over the restored one", async () => {
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith(
        { apiKey: null, baseUrlByProvider: { openrouter: "https://my-router.example/v1" } },
        "local",
        null,
      ),
    );
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ laneAProvider: "openrouter", laneAModel: null, laneABaseUrl: "https://new-router.example/v1" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    expect(patch.laneABaseUrl).toBe("https://new-router.example/v1");
  });
});

// DUR-4400 (found during DUR-4397's re-review of this stash): apiKeyByProvider
// and baseUrlByProvider live inside adapterConfig.laneA, which is otherwise
// agent-writable (AGENT_SELF_UPDATE_ALLOWED_FIELDS). Before this fix, neither
// the DUR-3980 "agent can't attach a secret_ref it wasn't given" gate nor any
// board-only lane-A guard looked inside these two maps, so an agent could
// plant a secret_ref it never held (or an attacker base URL) under a provider
// key with a single self-PATCH; the next ordinary provider switch by anyone
// -- agent or board -- would promote it straight into the live, resolvable
// laneA.apiKey / laneABaseUrl. These tests prove the stash is now board-only.
describe("quick-agent per-provider stash is board-only (DUR-4400)", () => {
  const agentActor = { type: "agent", agentId, companyId, runId: "run-1", source: "agent_key" };
  const ungrantedSecretRef = {
    type: "secret_ref",
    secretId: "66666666-6666-4666-8666-666666666666",
    version: "latest" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      companyId,
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

  it("rejects an agent-authenticated caller planting a secret_ref it was never granted into apiKeyByProvider", async () => {
    // Repro from DUR-4400: a self-PATCH that never touches laneAProvider (so
    // the board-only QUICK_AGENT_FIELDS gate never fires) but reaches straight
    // into the generically agent-writable adapterConfig.laneA.
    mockAgentService.getById.mockResolvedValue(baseAgentWith({ apiKey: null }, "openrouter"));
    const app = await createApp(agentActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: {
            laneA: {
              apiKeyByProvider: { openrouter: ungrantedSecretRef },
              baseUrlByProvider: { openrouter: "https://attacker.example/v1" },
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authenticated caller setting only baseUrlByProvider to an attacker host", async () => {
    mockAgentService.getById.mockResolvedValue(baseAgentWith({ apiKey: null }, "local"));
    const app = await createApp(agentActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { laneA: { baseUrlByProvider: { local: "https://attacker.example/v1" } } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authenticated caller clearing an existing stash entry", async () => {
    // Any change -- not just an addition -- is refused: this stash is
    // board-write-only, the same shape as adapterConfig.laneA.mcpServers.
    mockAgentService.getById.mockResolvedValue(
      baseAgentWith({ apiKey: null, apiKeyByProvider: { openrouter: openrouterKeyRef } }, "local"),
    );
    const app = await createApp(agentActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { laneA: { apiKeyByProvider: {} } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("still allows an agent to echo an unchanged stash back while editing an unrelated field", async () => {
    // Regression guard for the fix itself: a settings-form round trip that
    // reads laneA back and PATCHes it verbatim (unchanged map, keys possibly
    // reordered) must not be mistaken for a mutation.
    const laneAWithStash = {
      apiKey: null,
      apiKeyByProvider: { openrouter: openrouterKeyRef },
      baseUrlByProvider: { openrouter: "https://my-router.example/v1" },
    };
    mockAgentService.getById.mockResolvedValue(baseAgentWith(laneAWithStash, "local"));
    const app = await createApp(agentActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: {
            laneA: {
              // Re-keyed in reverse order than how it was read back.
              baseUrlByProvider: laneAWithStash.baseUrlByProvider,
              apiKeyByProvider: laneAWithStash.apiKeyByProvider,
              apiKey: null,
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("still allows a board-authenticated caller to drive the stash directly via adapterConfig", async () => {
    mockAgentService.getById.mockResolvedValue(baseAgentWith({ apiKey: null }, "openrouter"));
    const boardActor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ adapterConfig: { laneA: { apiKeyByProvider: { openrouter: openrouterKeyRef } } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});
