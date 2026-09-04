/**
 * DUR-313, route level: proves `PATCH /api/issues/:id` actually enforces both halves of the
 * feature-launch gate (server/src/services/feature-launch-gate.ts and
 * assertFeatureLaunchFieldAllowed in server/src/routes/issues.ts), not just that the pure gate
 * function is correct in isolation (feature-launch-gate.test.ts covers that). Mirrors the
 * harness in deploy-completion-gate-routes.test.ts.
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

describe("PATCH /api/issues/:id -- feature launch gate (DUR-313)", () => {
  // Dynamically importing routes/issues.ts (a very large file) after vi.resetModules() pays a
  // real esbuild transform cost on the first test that hits it -- same pre-existing
  // characteristic documented in deploy-completion-gate-routes.test.ts. Default 5s is too tight.
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
              ["company_scope:read", "issue:read", "issue:mutate", "runtime:manage"].includes(input.action ?? "")
            ? true
            : Boolean((await mockAccessService.canUser()) || (await mockAccessService.hasPermission()));
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("blocks an agent-authored done transition on an issue marked featureLaunch with no approval on record", async () => {
    const issue = baseIssue({ featureLaunch: true });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("PAP-3130");
    expect(res.body.error).toContain("feature_launch");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows done once an approved feature_launch approval is linked to the issue", async () => {
    const issue = baseIssue({ featureLaunch: true });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { id: "launch-1", type: "request_board_approval", status: "approved", payload: { kind: "feature_launch", issueId: ISSUE_ID } },
    ]);

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });

  it("does not block done for an issue that was never marked featureLaunch (bugfixes/cleanup)", async () => {
    const issue = baseIssue({ featureLaunch: false });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });

  it("does not block a board/human-authored done transition even without an approved launch card", async () => {
    const issue = baseIssue({ featureLaunch: true });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });

  it("lets an agent mark an issue AS a feature launch -- that only ever adds friction", async () => {
    const issue = baseIssue({ featureLaunch: false, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ featureLaunch: true });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ featureLaunch: true }));
  });

  it("refuses to let an agent un-mark an issue that is already featureLaunch -- least privilege, only a board user may do that", async () => {
    const issue = baseIssue({ featureLaunch: true, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ featureLaunch: false });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a board user");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("lets a board user un-mark an issue that is already featureLaunch", async () => {
    const issue = baseIssue({ featureLaunch: true, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ featureLaunch: false });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ featureLaunch: false }));
  });
});
