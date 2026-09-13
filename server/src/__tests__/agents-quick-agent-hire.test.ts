import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_AGENT_FIELDS, type QuickAgentField } from "@paperclipai/shared";

// DUR-3971: employing someone now includes the choice between "answers
// straight away in chat" (a quick agent) and "goes away and works on tasks".
// This file proves the three things that choice depends on:
//   1. a hire made with the choice really comes out with the flag set,
//   2. a hire made WITHOUT the choice is byte-for-byte the hire we made
//      before the choice existed (no key appears, nothing flips), and
//   3. the choice is board-only on the hire path, exactly as it already is
//      on PATCH — an agent cannot hand itself the direct-model-call lane.
// The last describe block is the anti-drift test: it reads QUICK_AGENT_FIELDS
// out of @paperclipai/shared and asserts every name in it is handled by the
// create schema, the board-only guard and the hire approval payload. Adding a
// third quick-agent field to that array and nowhere else fails here.
//
// Route wiring only — the service layer is mocked, same as
// agent-skills-routes.test.ts (see its header comment for why the company
// scope helper is stubbed out below).
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  const { requestCompanyScopeStorage } = await import("@paperclipai/db/company-scope");
  return {
    ...actual,
    runInCompanyScope: async (rawDb: unknown, companyId: string, fn: () => Promise<unknown>) =>
      requestCompanyScopeStorage.run({ kind: "scoped", companyId, scopedDb: rawDb } as never, fn),
  };
});

const COMPANY_ID = "c0000001-0000-4000-8000-000000000001";
const ACTOR_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
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
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  syncEnvBindingsForTarget: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockAdapter = vi.hoisted(() => ({ listSkills: vi.fn(), syncSkills: vi.fn() }));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));
vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => mockHeartbeatService,
  isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: COMPANY_ID, requireBoardApprovalForNewAgents }]),
      })),
    })),
  };
}

type Actor = "board" | "agent";

async function createApp(actorType: Actor, db: Record<string, unknown> = createDb()) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "board"
        ? {
            type: "board",
            userId: "local-board",
            companyIds: [COMPANY_ID],
            source: "local_implicit",
            isInstanceAdmin: false,
          }
        : {
            type: "agent",
            agentId: ACTOR_AGENT_ID,
            companyId: COMPANY_ID,
            source: "agent_key",
          };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  if (process.env.DEBUG_ROUTE_ERRORS) {
    app.use((err: unknown, _req: any, _res: any, next: any) => {
      console.error(err);
      next(err);
    });
  }
  app.use(errorHandler);
  return app;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: COMPANY_ID,
    name: "Agent",
    role: "general",
    title: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    laneAEnabled: false,
    laneAInstructions: null,
    budgetMonthlyCents: 0,
    updatedAt: new Date(),
    ...overrides,
  };
}

/** The body the UI sends today for a plain hire, with no working-style choice. */
function baseHireBody() {
  return {
    name: "Analyst",
    role: "general",
    adapterType: "claude_local",
    adapterConfig: {},
  };
}

async function postHire(app: express.Express, body: Record<string, unknown>) {
  return request(app).post(`/api/companies/${COMPANY_ID}/agent-hires`).send(body);
}

function createdAgentInput(): Record<string, unknown> {
  expect(mockAgentService.create).toHaveBeenCalledTimes(1);
  return mockAgentService.create.mock.calls[0][1] as Record<string, unknown>;
}

function approvalPayload(): Record<string, unknown> {
  expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  const input = mockApprovalService.create.mock.calls[0][1] as Record<string, unknown>;
  return input.payload as Record<string, unknown>;
}

// routes/agents.ts is a large module; the first dynamic import of it inside a
// test can take longer than vitest's default 5s timeout on a cold transform
// cache. Warm it once up front so a slow import never reads as a route hang.
beforeAll(async () => {
  await vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js");
}, 60_000);

describe.sequential("quick-agent choice on the employment path (DUR-3971)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockLogActivity.mockResolvedValue(undefined);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation(
      (_agent: unknown, config: unknown) => config,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockCompanySkillService.resolveRequestedSkillEntries.mockImplementation(
      async (_companyId: string, requested: Array<{ key: string }>) => requested,
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: false,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: false,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockAgentService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => makeAgent(input),
    );
    // The agent-authenticated caller's own row, for
    // assertCanCreateAgentsForCompany.
    mockAgentService.getById.mockResolvedValue(makeAgent({ id: ACTOR_AGENT_ID }));
    mockApprovalService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "approval-1",
        companyId: COMPANY_ID,
        type: "hire_agent",
        status: "pending",
        payload: input.payload ?? {},
      }),
    );
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({
        bundle: null,
        adapterConfig: (agent.adapterConfig as Record<string, unknown> | undefined) ?? {},
      }),
    );
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("employs a quick agent with the flag actually set", async () => {
    const res = await postHire(await createApp("board"), {
      ...baseHireBody(),
      name: "Front desk",
      laneAEnabled: true,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(createdAgentInput()).toMatchObject({ laneAEnabled: true });
    expect(res.body.agent.laneAEnabled).toBe(true);
  });

  it("carries the quick-agent instructions written at employment time", async () => {
    const res = await postHire(await createApp("board"), {
      ...baseHireBody(),
      laneAEnabled: true,
      laneAInstructions: "You are the front desk. Answer in Norwegian.",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(createdAgentInput()).toMatchObject({
      laneAEnabled: true,
      laneAInstructions: "You are the front desk. Answer in Norwegian.",
    });
  });

  it("leaves a hire made without the choice exactly as it was before", async () => {
    const res = await postHire(await createApp("board"), baseHireBody());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const input = createdAgentInput();
    // Not "laneAEnabled: false" — the key must not appear at all, so the
    // column default is what decides, exactly as before this choice existed.
    for (const field of QUICK_AGENT_FIELDS) {
      expect(Object.hasOwn(input, field)).toBe(false);
    }
    expect(res.body.agent.laneAEnabled).toBe(false);
  });

  it("shows the choice on the hire card the board approves", async () => {
    const res = await postHire(await createApp("board", createDb(true)), {
      ...baseHireBody(),
      laneAEnabled: true,
      laneAInstructions: "Front desk.",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(approvalPayload()).toMatchObject({
      laneAEnabled: true,
      laneAInstructions: "Front desk.",
    });
  });

  it("says 'works on tasks' on the card when no choice was made", async () => {
    const res = await postHire(await createApp("board", createDb(true)), baseHireBody());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(approvalPayload()).toMatchObject({ laneAEnabled: false, laneAInstructions: null });
  });

  it("refuses an agent-authenticated caller that employs a quick agent", async () => {
    const res = await postHire(await createApp("agent", createDb(true)), {
      ...baseHireBody(),
      laneAEnabled: true,
    });

    expect(res.status).toBe(403);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("still lets an agent-authenticated caller propose an ordinary hire", async () => {
    const res = await postHire(await createApp("agent", createDb(true)), baseHireBody());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// Anti-drift: QUICK_AGENT_FIELDS is the one list; every place that has to
// agree with it is checked against it here rather than by hand.
describe.sequential("every quick-agent field is handled on the employment path", () => {
  // Typed as a total map over QuickAgentField, so adding a field to
  // QUICK_AGENT_FIELDS without adding a sample value here fails typecheck
  // before it can fail at runtime.
  const SAMPLE_VALUES: Record<QuickAgentField, unknown> = {
    laneAEnabled: true,
    laneAInstructions: "Front desk.",
    // DUR-3977 quick-agent settings.
    laneAModel: "claude-haiku-4-5",
    laneAMaxOutputTokens: 512,
    laneATransformDailyCallCap: 1500,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: false,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockAgentService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => makeAgent(input),
    );
    mockAgentService.getById.mockResolvedValue(makeAgent({ id: ACTOR_AGENT_ID }));
    mockApprovalService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        id: "approval-1",
        companyId: COMPANY_ID,
        type: "hire_agent",
        status: "pending",
        payload: input.payload ?? {},
      }),
    );
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({
        bundle: null,
        adapterConfig: (agent.adapterConfig as Record<string, unknown> | undefined) ?? {},
      }),
    );
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
  });

  it("has a sample value for every field", () => {
    expect(Object.keys(SAMPLE_VALUES).sort()).toEqual([...QUICK_AGENT_FIELDS].sort());
    expect(QUICK_AGENT_FIELDS.length).toBeGreaterThan(0);
  });

  for (const field of QUICK_AGENT_FIELDS) {
    it(`accepts and stores "${field}" when the board employs someone`, async () => {
      const res = await postHire(await createApp("board"), {
        ...baseHireBody(),
        [field]: SAMPLE_VALUES[field],
      });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(createdAgentInput()).toMatchObject({ [field]: SAMPLE_VALUES[field] });
    });

    it(`puts "${field}" on the hire approval card`, async () => {
      const res = await postHire(await createApp("board", createDb(true)), {
        ...baseHireBody(),
        [field]: SAMPLE_VALUES[field],
      });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(Object.hasOwn(approvalPayload(), field)).toBe(true);
    });

    it(`refuses an agent-authenticated caller that sets "${field}" at hire`, async () => {
      const res = await postHire(await createApp("agent", createDb(true)), {
        ...baseHireBody(),
        [field]: SAMPLE_VALUES[field],
      });

      expect(res.status).toBe(403);
      expect(mockAgentService.create).not.toHaveBeenCalled();
    });
  }
});
