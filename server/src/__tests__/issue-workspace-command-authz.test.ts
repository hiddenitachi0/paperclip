import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// `vi.resetModules()` in beforeEach re-transforms the large issues.ts
// dependency graph on every test; the first test in this file eats that
// cold-start cost and can exceed the default 5s budget (see
// lane-b-message-routes.test.ts for the same pattern).
vi.setConfig({ testTimeout: 20_000 });

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", contextSnapshot: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

function registerRouteMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
    escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
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
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(withFakeCompanyScopeReserve(mockDb) as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "11111111-1111-4111-8111-111111111111",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1000",
    title: "Workspace authz",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue workspace command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    // The test's plain "issue-1" id happens to match the PREFIX-N issue
    // identifier shape (see packages/shared/src/issue-references.ts's
    // ISSUE_REFERENCE_IDENTIFIER_RE), so router.param("id", ...) and
    // scopeFromIssueParam() (both DUR-379) resolve it via getByIdentifier
    // rather than getById -- mirror getById's default here so that lookup
    // succeeds the same way it would for a real "PAP-N"-style identifier.
    mockIssueService.getByIdentifier.mockResolvedValue(makeIssue());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      permissions: null,
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["11111111-1111-4111-8111-111111111111"]);
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ companyId: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", contextSnapshot: null }]).then(
          onFulfilled,
          onRejected,
        ),
    }));
  });

  it("rejects agent callers that create issue workspace provision commands", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/issues")
      .send({
        title: "Exploit",
        executionWorkspaceSettings: {
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent setting changeLogVisible/changeLogSummary on issue creation", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/issues")
      .send({
        title: "Self-published bugfix",
        status: "done",
        changeLogVisible: true,
        changeLogSummary: "Fixed a critical payment bug",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("changeLogVisible/changeLogSummary");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent setting changeLogVisible/changeLogSummary on child issue creation", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: "issue-1" }));
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/issues/issue-1/children")
      .send({
        title: "Self-published bugfix",
        status: "done",
        changeLogVisible: true,
        changeLogSummary: "Fixed a critical payment bug",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("changeLogVisible/changeLogSummary");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows a board user to set changeLogVisible/changeLogSummary on issue creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/issues")
      .send({
        title: "Backfilled bugfix",
        status: "done",
        changeLogVisible: true,
        changeLogSummary: "Fixed a critical payment bug",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ changeLogVisible: true, changeLogSummary: "Fixed a critical payment bug" }),
    );
  });

  it("rejects an agent setting featureLaunch on issue creation (DUR-313 create-path bypass)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/issues")
      .send({
        title: "Self-published launch",
        status: "done",
        featureLaunch: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("featureLaunch");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent setting featureLaunch on child issue creation (DUR-313 create-path bypass)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: "issue-1" }));
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/issues/issue-1/children")
      .send({
        title: "Self-published launch",
        status: "done",
        featureLaunch: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("featureLaunch");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows a board user to set featureLaunch on issue creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["11111111-1111-4111-8111-111111111111"],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/11111111-1111-4111-8111-111111111111/issues")
      .send({
        title: "Board-filed launch",
        status: "done",
        featureLaunch: true,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ featureLaunch: true }),
    );
  });

  it("rejects agent callers that patch assignee adapter workspace teardown commands", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        assigneeAdapterOverrides: {
          adapterConfig: {
            workspaceStrategy: {
              type: "git_worktree",
              teardownCommand: "rm -rf /tmp/paperclip-rce",
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
