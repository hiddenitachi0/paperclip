import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.resetModules()` in beforeEach re-transforms the large issues.ts
// dependency graph on every test; the first test in this file eats that
// cold-start cost and can exceed the default 5s budget.
vi.setConfig({ testTimeout: 20_000 });

// DUR-219: Lane B conversational front door — a plain-text request becomes a
// normal issue scoped to a target agent, runs in the background, and the
// caller polls a status endpoint that adds one thing GET /issues/:id
// doesn't provide: a computed result summary (latest agent reply) once the
// issue has settled.

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const issueId = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  listComments: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => ({
      createForIssue: vi.fn(),
      getById: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      listForIssue: vi.fn(async () => []),
    }),
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => ({
      getIssueSummaries: vi.fn(async () => new Map()),
      listForIssue: vi.fn(async () => []),
      syncCommentSafely: vi.fn(async () => undefined),
      syncDocumentSafely: vi.fn(async () => undefined),
      syncIssueSafely: vi.fn(async () => undefined),
    }),
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => ({}),
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
      getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false, enableExternalObjects: false })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => ({}),
  }));

  vi.doMock("../services/environment-runtime.js", () => ({
    environmentRuntimeService: () => ({}),
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
    readAcceptedPlanConfirmationTarget: vi.fn(),
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companyService: () => ({ getById: vi.fn() }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
    escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
      getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false, enableExternalObjects: false })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({ link: vi.fn(), unlink: vi.fn(), listApprovalsForIssue: vi.fn(async () => []) }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
      resolveActiveForIssue: vi.fn(async () => null),
    }),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
      listForIssue: vi.fn(async () => []),
    }),
    taskWatchdogService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      revalidateMutationScope: vi.fn(async () => ({
        allowed: true,
        classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
      })),
      reconcileForIssueAndAncestors: vi.fn(async () => ({
        checked: 0,
        triggered: 0,
        skipped: 0,
        watchdogIssueIds: [],
      })),
      upsertForIssue: vi.fn(),
      disableForIssue: vi.fn(async () => null),
    }),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({
      createForIssue: vi.fn(),
      getById: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      listForIssue: vi.fn(async () => []),
    }),
    externalObjectService: () => ({
      getIssueSummaries: vi.fn(async () => new Map()),
      listForIssue: vi.fn(async () => []),
      syncCommentSafely: vi.fn(async () => undefined),
      syncDocumentSafely: vi.fn(async () => undefined),
      syncIssueSafely: vi.fn(async () => undefined),
    }),
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
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
    ...overrides,
  };
}

function requesterAgentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: "44444444-4444-4444-8444-444444444444",
    companyId,
    source: "agent_key",
    runId: "55555555-5555-4555-8555-555555555555",
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: targetAgentId,
    companyId,
    status: "active",
    role: "engineer",
    ...overrides,
  };
}

describe("lane B message routes (DUR-219)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/environment-runtime.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "tasks:assign" || input.action === "issue:read",
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test default.",
    }));
    mockAgentService.getById.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.listComments.mockReset();
    mockHeartbeatService.wakeup.mockClear();
  });

  it("returns 404 when the target agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/lane-b/${targetAgentId}/messages`)
      .send({ text: "Can you check on the deploy?" });

    expect(res.status).toBe(404);
  });

  it("rejects a request scoped to another company", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(requesterAgentActor({ companyId: otherCompanyId }));

    const res = await request(app)
      .post(`/api/lane-b/${targetAgentId}/messages`)
      .send({ text: "Can you check on the deploy?" });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects an empty request body", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/lane-b/${targetAgentId}/messages`)
      .send({ text: "   " });

    expect(res.status).toBe(400);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("creates an issue scoped to the target agent and wakes it, returning immediately", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      identifier: "PAP-42",
      status: "todo",
      title: "Can you check on the deploy?",
      assigneeAgentId: targetAgentId,
    });
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/lane-b/${targetAgentId}/messages`)
      .send({ text: "Can you check on the deploy?\n\nIt's been a while." });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      issueId,
      identifier: "PAP-42",
      status: "todo",
      assigneeAgentId: targetAgentId,
    });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Can you check on the deploy?",
        description: "Can you check on the deploy?\n\nIt's been a while.",
        assigneeAgentId: targetAgentId,
        status: "todo",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      targetAgentId,
      expect.objectContaining({ payload: expect.objectContaining({ issueId }) }),
    );
  });

  it("truncates an overlong first line into the issue title", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockIssueService.create.mockResolvedValue({
      id: issueId,
      identifier: "PAP-42",
      status: "todo",
      assigneeAgentId: targetAgentId,
    });
    const app = await createApp(boardActor());
    const longText = "x".repeat(200);

    await request(app).post(`/api/lane-b/${targetAgentId}/messages`).send({ text: longText });

    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: `${"x".repeat(79)}…`,
      }),
    );
  });

  it("returns 404 for an unknown issue on the status endpoint", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/lane-b/messages/${issueId}`);
    expect(res.status).toBe(404);
  });

  it("reports in-flight status without fetching comments", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-42",
      status: "in_progress",
      projectId: null,
      parentId: null,
      assigneeAgentId: targetAgentId,
      assigneeUserId: null,
    });
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/lane-b/messages/${issueId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issueId,
      identifier: "PAP-42",
      status: "in_progress",
      settled: false,
      resultSummary: null,
    });
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });

  it("surfaces the latest non-deleted agent reply as the result summary once settled", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-42",
      status: "done",
      projectId: null,
      parentId: null,
      assigneeAgentId: targetAgentId,
      assigneeUserId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      { id: "c3", authorType: "agent", body: "All set — deploy finished cleanly.", deletedAt: null },
      { id: "c2", authorType: "agent", body: "stale deleted reply", deletedAt: new Date() },
      { id: "c1", authorType: "user", body: "the original request", deletedAt: null },
    ]);
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/lane-b/messages/${issueId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issueId,
      identifier: "PAP-42",
      status: "done",
      settled: true,
      resultSummary: "All set — deploy finished cleanly.",
    });
  });
});
