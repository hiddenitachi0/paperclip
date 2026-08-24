import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-55 / DUR-56 / DUR-57: an agent-authenticated caller must never be able
// to change its own (or another agent's) job title, add/change a tool
// connection (MCP server) on any agent's adapterConfig, re-parent itself
// (reportsTo), or raise its own spend ceiling (budgetMonthlyCents). All of
// these came from `allow_self` granting blanket write access to an agent's
// own record. DUR-57 replaced the field-by-field deny-list that closed the
// first two holes with a named allow-list (server/src/services/agent-self-update-policy.ts)
// so a field NOT on that list is refused by default — these tests prove that
// guard (assertAgentSelfUpdateAllowed in server/src/routes/agents.ts) on
// both the PATCH route and the config-revision rollback route, while leaving
// board-authenticated (human) updates and legitimate agent self-updates
// unaffected.

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

async function createApp(
  actor: Record<string, unknown>,
  options?: {
    // DUR-57: stands in for a future updateAgentSchema change that lets an
    // unrecognized field reach the route handler (today zod's `validate`
    // middleware strips any key it doesn't know about, so a genuinely novel
    // field can never reach assertAgentSelfUpdateAllowed through a real HTTP
    // request yet). Bypassing validation is how this suite proves the
    // allow-list itself — not zod — is what refuses an unknown field.
    bypassValidation?: boolean;
    // DUR-57: stands in for a future CONFIG_REVISION_FIELDS addition that
    // computeChangedConfigFields would surface before anyone remembers to
    // add it to AGENT_SELF_UPDATE_ALLOWED_FIELDS.
    injectUnknownRollbackField?: boolean;
  },
) {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  // DUR-57: bypassValidation / injectUnknownRollbackField register a doMock
  // for these two modules that vi.resetModules() alone does not undo — an
  // explicit doUnmock here keeps that override scoped to the single test
  // that opts in, instead of leaking into every later test in this file.
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../services/agent-self-update-policy.js");
  registerModuleMocks();
  if (options?.bypassValidation) {
    vi.doMock("../middleware/validate.js", () => ({
      validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
  }
  if (options?.injectUnknownRollbackField) {
    vi.doMock("../services/agent-self-update-policy.js", async () => {
      const actual = await vi.importActual<typeof import("../services/agent-self-update-policy.js")>(
        "../services/agent-self-update-policy.js",
      );
      return {
        ...actual,
        computeChangedConfigFields: (existing: Record<string, unknown>, patch: Record<string, unknown>) => ({
          ...actual.computeChangedConfigFields(existing, patch as never),
          aFieldNobodyHasWrittenYet: "surprise",
        }),
      };
    });
  }

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
    // DUR-148: the legacy `role` enum field is now rejected on PATCH /agents/:id
    // for every caller, board included — `role: "ceo"` silently grants
    // canCreateAgents via the "ceo" default-permissions branch with no
    // board-only/self-assignment check of its own, so it gets the same
    // route-level 422 treatment as roleId/roleOverrides rather than the
    // narrower agent-only 403 this used to expect. See the equivalent
    // board-actor coverage in agent-permissions-routes.test.ts.
    it("rejects an agent-authenticated caller changing its own role", { timeout: 20000 }, async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller changing another agent's role", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${peerAgentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects a board-authenticated caller changing an agent's role too", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ role: "ceo" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(mockAgentService.update).not.toHaveBeenCalled();
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

  // DUR-57: the self-update guard is now allow-list based (server/src/services/agent-self-update-policy.ts)
  // instead of a hand-maintained deny-list. reportsTo and budgetMonthlyCents are the two concrete fields
  // named in DUR-56's follow-up as still exploitable through the old deny-list; they are proven refused
  // here purely because they are absent from the allow-list, not because of a field-specific check.
  describe("allow-list (DUR-57)", () => {
    it("rejects an agent-authenticated caller changing who it reports to", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ reportsTo: peerAgentId }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller raising its own monthly budget", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 1_000_000 }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to change reportsTo and budgetMonthlyCents", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${agentId}`)
          .send({ reportsTo: peerAgentId, budgetMonthlyCents: 1_000_000 }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ reportsTo: peerAgentId, budgetMonthlyCents: 1_000_000 }),
        expect.anything(),
      );
    });

    it("still allows an agent to set desiredSkills on itself", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ desiredSkills: ["writes-tests"] }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
    });

    it("still allows an agent to set runtimeConfig.modelProfiles on itself", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${agentId}`)
          .send({ runtimeConfig: { modelProfiles: { cheap: { adapterConfig: {} } } } }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller setting a runtimeConfig key other than modelProfiles", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${agentId}`)
          .send({ runtimeConfig: { handOffUnhandledAfterMinutes: 30 } }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    // DUR-57: proves the allow-list itself refuses a field it has never heard
    // of — not merely the specific fields this test file happens to name —
    // by bypassing zod's own key-stripping (see bypassValidation on
    // createApp) so a genuinely novel field reaches assertAgentSelfUpdateAllowed.
    it("rejects an agent-authenticated caller setting a brand-new field the allow-list doesn't know about", async () => {
      const app = await createApp(agentActor, { bypassValidation: true });
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ aFieldNobodyHasWrittenYet: "surprise" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller setting its own personality (DUR-61)", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ personality: "Sassy and fun." }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("allows a board-authenticated caller to set personality (DUR-61)", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ personality: "Sassy and fun." }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ personality: "Sassy and fun." }),
        expect.anything(),
      );
    });

    it("rejects an agent-authenticated caller setting its own tone (DUR-61 addendum)", async () => {
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ tone: "Warm and cheerful." }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("allows a board-authenticated caller to set tone (DUR-61 addendum)", async () => {
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agentId}`).send({ tone: "Warm and cheerful." }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ tone: "Warm and cheerful." }),
        expect.anything(),
      );
    });
  });

  describe("config-revision rollback", () => {
    const revisionId = "44444444-4444-4444-8444-444444444444";

    function mockRevision(afterConfig: Record<string, unknown>) {
      mockAgentService.getConfigRevision.mockResolvedValue({
        id: revisionId,
        agentId,
        afterConfig,
      });
      mockAgentService.rollbackConfigRevision.mockResolvedValue({ ...baseAgent, ...afterConfig });
    }

    it("rejects an agent-authenticated caller rolling back to a revision that restores a different role", async () => {
      mockRevision({ ...baseAgent, role: "ceo" });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller rolling back to a revision that restores a tool connection", async () => {
      mockRevision({
        ...baseAgent,
        adapterConfig: { mcpServers: [{ name: "shell", command: "bash", args: ["-c", "whoami"] }] },
      });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to roll back to a revision that restores role and a tool connection", async () => {
      mockRevision({
        ...baseAgent,
        role: "ceo",
        adapterConfig: { mcpServers: [{ name: "shell", command: "bash", args: ["-c", "whoami"] }] },
      });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });

    // DUR-109: DUR-69's "MEASURED" section flagged this rollback route as an
    // open gap for the instructions-bundle keys specifically -- closed by
    // DUR-57 (assertAgentSelfUpdateRollbackAllowed reduces the rollback to
    // the same assertAgentSelfUpdateAllowed the PATCH path uses), but nothing
    // proved that for these five keys before this test. Mirrors the
    // mcpServers rollback test above, for adapterConfig.instructionsFilePath
    // and .instructionsBundleMode instead.
    it("rejects an agent-authenticated caller rolling back to a revision that restores a different instructions bundle path", async () => {
      mockRevision({
        ...baseAgent,
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsFilePath: "/etc/passwd",
        },
      });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to roll back to a revision that restores an instructions bundle path", async () => {
      mockRevision({
        ...baseAgent,
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsFilePath: "/etc/passwd",
        },
      });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });

    // DUR-57: rollback restores a revision's snapshot wholesale, so it must be checked against the SAME
    // allow-list the PATCH route uses (see assertAgentSelfUpdateRollbackAllowed in routes/agents.ts) —
    // otherwise an agent could use rollback to restore a reportsTo/budgetMonthlyCents value it could
    // never set directly through PATCH.
    it("rejects an agent-authenticated caller rolling back to a revision that restores a different reportsTo", async () => {
      mockRevision({ ...baseAgent, reportsTo: peerAgentId });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller rolling back to a revision that restores a higher budgetMonthlyCents", async () => {
      mockRevision({ ...baseAgent, budgetMonthlyCents: 1_000_000 });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("still allows a board-authenticated caller to roll back to a revision that restores reportsTo and budgetMonthlyCents", async () => {
      mockRevision({ ...baseAgent, reportsTo: peerAgentId, budgetMonthlyCents: 1_000_000 });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });

    // DUR-57: same property as the PATCH-path test above, proven on the
    // rollback path — a rollback diff can't smuggle in a field name the
    // route has never heard of and still succeed. Since
    // configPatchFromSnapshot only ever emits today's known
    // CONFIG_REVISION_FIELDS, this simulates a future field via
    // injectUnknownRollbackField rather than a real revision snapshot.
    it("rejects an agent-authenticated caller rolling back a diff containing a brand-new field the allow-list doesn't know about", async () => {
      mockRevision({ ...baseAgent, capabilities: "writes tests" });
      const app = await createApp(agentActor, { injectUnknownRollbackField: true });
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("still allows an agent to roll back to a revision that leaves role and tool connections unchanged", async () => {
      mockRevision({ ...baseAgent, capabilities: "writes tests" });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller rolling back to a revision that restores a different personality (DUR-61)", async () => {
      mockRevision({ ...baseAgent, personality: "Sassy and fun." });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("allows a board-authenticated caller to roll back to a revision that restores a personality (DUR-61)", async () => {
      mockRevision({ ...baseAgent, personality: "Sassy and fun." });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });

    it("rejects an agent-authenticated caller rolling back to a revision that restores a different tone (DUR-61 addendum)", async () => {
      mockRevision({ ...baseAgent, tone: "Warm and cheerful." });
      const app = await createApp(agentActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    });

    it("allows a board-authenticated caller to roll back to a revision that restores a tone (DUR-61 addendum)", async () => {
      mockRevision({ ...baseAgent, tone: "Warm and cheerful." });
      const app = await createApp(boardActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
    });
  });
});
