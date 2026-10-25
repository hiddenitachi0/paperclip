/**
 * "Make a short brag video when this is done", route level: only a person
 * (board user) may set or clear the pre-approval, on every issue path an
 * agent could use (create, child create, plan decomposition, update). The
 * harness is the one feature-launch-gate-routes.test.ts uses.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DUR-394/DUR-313: PATCH /api/issues/:id runs through scopeFromIssueParam(),
// which reserves a real connection via runInCompanyScope -- this test's
// hand-rolled mockIssueService/mockDb stubs aren't a real Db, so they can't
// back that reservation. Bypass the reservation machinery in tests, running
// the callback (which itself just calls next() and awaits response finish)
// directly, no real connection involved -- same pattern used pre-DUR-381 by
// e.g. invite-create-route.test.ts.
vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
    withCompanyScope: async (rawDb: any, _companyId: string, fn: (tx: unknown) => unknown) => rawDb.transaction(fn),
  };
});

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));

// Neutral fixed row for any incidental db.select() the route handler itself performs outside
// the gate under test (e.g. agent lookups) -- none of it has a projectId, so self-review-gate,
// the goal-condition judge, and the deploy-completion gate all no-op for these fixtures without
// needing their own mocks.
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  limit: vi.fn(async () => [{ companyId: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", contextSnapshot: null, permissions: null }]),
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", contextSnapshot: null, permissions: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({ select: mockDbSelect }));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));

// Backs BOTH the route's own issueApprovalService() (used by assertAgentInReviewReviewPath)
// and feature-launch-gate.ts's direct import -- same underlying module, mocked once.
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn(async () => null));
const mockReadDeployRunnerStatus = vi.hoisted(() => vi.fn(() => []));

const mockBragOnDone = vi.hoisted(() => ({
  assertEnabled: vi.fn(async () => undefined),
  setPreapproval: vi.fn(async () => ({ approvedByUserId: "local-board", approvedAt: "2026-10-17T00:00:00.000Z", maxCostCents: 39, lengthSeconds: 30 })),
  acceptOverCap: vi.fn(async () => false),
}));
vi.mock("../services/brag-on-done.js", () => ({
  bragOnDoneService: () => mockBragOnDone,
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));
vi.mock("../services/deploy-branches.js", () => ({
  resolveProjectDeployBranches: (...args: unknown[]) => mockResolveProjectDeployBranches(...args),
}));
vi.mock("../services/deploy-runner-status.js", () => ({
  readDeployRunnerStatus: (...args: unknown[]) => mockReadDeployRunnerStatus(...args),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
    escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({ id: agentId, companyId: "11111111-1111-4111-8111-111111111111", permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: { id: reference, companyId: "11111111-1111-4111-8111-111111111111", status: "idle", orgChainHealth: { status: "healthy" } },
      })),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["11111111-1111-4111-8111-111111111111"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | { type: "board"; userId: string; companyIds: string[]; source: "local_implicit"; isInstanceAdmin: boolean }
  | { type: "agent"; agentId: string; companyId: string; runId: string | null };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actor ?? { type: "board", userId: "local-board", companyIds: ["11111111-1111-4111-8111-111111111111"], source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

function baseIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "11111111-1111-4111-8111-111111111111",
    status: "in_review",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-3130",
    title: "Feature launch gate fixture",
    executionPolicy: null,
    executionState: null,
    featureLaunch: false,
    ...overrides,
  };
}

const AGENT_ACTOR: TestActor = { type: "agent", agentId: AGENT_ID, companyId: "11111111-1111-4111-8111-111111111111", runId: "run-1" };
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("brag video when a task is done -- only people may set it", () => {
  vi.setConfig({ testTimeout: 20000 });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockResolveProjectDeployBranches.mockResolvedValue(null);
    mockReadDeployRunnerStatus.mockReturnValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed =
        input.actor?.type === "board" && input.actor.source === "local_implicit"
          ? true
          : input.actor?.type === "agent" &&
              ["company_scope:read", "issue:read", "issue:mutate", "runtime:manage", "tasks:assign"].includes(input.action ?? "")
            ? true
            : false;
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockBragOnDone.assertEnabled.mockResolvedValue(undefined);
  });

  it("refuses an agent ticking the box on an existing task", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ bragOnDone: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a person");
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent unticking a person's choice", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress", bragPreapproval: { approvedByUserId: "u" } }));
    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ bragOnDone: false });
    expect(res.status).toBe(403);
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });

  it("refuses an agent ticking it in the same request that marks the task done", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done", bragOnDone: true });
    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a task with the box ticked", async () => {
    const res = await request(await createApp(AGENT_ACTOR))
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Self-brag", bragOnDone: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a person");
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a sub-task with the box ticked", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const res = await request(await createApp(AGENT_ACTOR))
      .post(`/api/issues/${ISSUE_ID}/children`)
      .send({ title: "Child self-brag", bragOnDone: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a person");
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("refuses an agent ticking it on plan-decomposition sub-tasks", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const res = await request(await createApp(AGENT_ACTOR))
      .post(`/api/issues/${ISSUE_ID}/accepted-plan-decompositions`)
      .send({ acceptedPlanRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", children: [{ title: "Step", bragOnDone: true }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a person");
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });

  it("honours a person ticking it on plan-decomposition sub-tasks, only on the ticked ones", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const childA = "aaaaaaaa-0000-4000-8000-00000000000a";
    const childB = "aaaaaaaa-0000-4000-8000-00000000000b";
    mockIssueService.decomposeAcceptedPlan.mockResolvedValue({
      decomposition: { id: "decomp-1", status: "completed" },
      childIssueIds: [childA, childB],
      newlyCreatedIssues: [
        { id: childA, companyId: COMPANY_ID, identifier: "PAP-1", title: "Step one", status: "todo", executionPolicy: null, assigneeAgentId: null },
        { id: childB, companyId: COMPANY_ID, identifier: "PAP-2", title: "Step two", status: "todo", executionPolicy: null, assigneeAgentId: null },
      ],
    });
    const res = await request(await createApp())
      .post(`/api/issues/${ISSUE_ID}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        children: [{ title: "Step one", bragOnDone: true }, { title: "Step two" }],
      });
    expect(res.status).toBe(200);
    expect(mockBragOnDone.assertEnabled).toHaveBeenCalledWith(COMPANY_ID);
    expect(mockBragOnDone.setPreapproval).toHaveBeenCalledTimes(1);
    expect(mockBragOnDone.setPreapproval).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      issueId: childA,
      userId: "local-board",
      enabled: true,
    }));
  });

  it("does not re-record the choice when a finished plan breakdown is replayed", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockIssueService.decomposeAcceptedPlan.mockResolvedValue({
      decomposition: { id: "decomp-1", status: "completed" },
      childIssueIds: ["aaaaaaaa-0000-4000-8000-00000000000a"],
      newlyCreatedIssues: [],
    });
    const res = await request(await createApp())
      .post(`/api/issues/${ISSUE_ID}/accepted-plan-decompositions`)
      .send({ acceptedPlanRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", children: [{ title: "Step one", bragOnDone: true }] });
    expect(res.status).toBe(200);
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });

  it("refuses a person's plan breakdown with a ticked sub-task when the setting is off, before any sub-task is made", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const { HttpError } = await import("../errors.js");
    mockBragOnDone.assertEnabled.mockRejectedValueOnce(new HttpError(422, "Brag videos for finished tasks are turned off for this company."));
    const res = await request(await createApp())
      .post(`/api/issues/${ISSUE_ID}/accepted-plan-decompositions`)
      .send({ acceptedPlanRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", children: [{ title: "Step one", bragOnDone: true }] });
    expect(res.status).toBe(422);
    expect(mockIssueService.decomposeAcceptedPlan).not.toHaveBeenCalled();
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });

  it("lets a person tick it, recorded through the pre-approval setter and never through the generic update", async () => {
    const issue = baseIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch, updatedAt: new Date() }));
    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ bragOnDone: true });
    expect(res.status).toBe(200);
    expect(mockBragOnDone.setPreapproval).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      userId: "local-board",
      enabled: true,
    }));
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("bragOnDone");
    expect(patch).not.toHaveProperty("bragPreapproval");
  });

  it("passes on the refusal when the company has the setting off", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    const { HttpError } = await import("../errors.js");
    mockBragOnDone.setPreapproval.mockRejectedValueOnce(new HttpError(422, "Brag videos for finished tasks are turned off for this company."));
    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ bragOnDone: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("turned off");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses a person's create with the box ticked when the setting is off, before the task is made", async () => {
    const { HttpError } = await import("../errors.js");
    mockBragOnDone.assertEnabled.mockRejectedValueOnce(new HttpError(422, "Brag videos for finished tasks are turned off for this company."));
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "Wants a video", bragOnDone: true });
    expect(res.status).toBe(422);
    expect(mockBragOnDone.setPreapproval).not.toHaveBeenCalled();
  });
});
