import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// `vi.resetModules()` in beforeEach re-transforms the large issues.ts
// dependency graph on every test; the first test to hit that cold-start
// cost can exceed the default 5s budget.
vi.setConfig({ testTimeout: 20_000 });

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CREATOR_AGENT_ID = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
  escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "99999999-9999-4999-8999-999999999999", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
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
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["99999999-9999-4999-8999-999999999999"]),
  }),
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
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
    escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "99999999-9999-4999-8999-999999999999", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
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
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["99999999-9999-4999-8999-999999999999"]),
    }),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["99999999-9999-4999-8999-999999999999"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(withFakeCompanyScopeReserve({}) as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "99999999-9999-4999-8999-999999999999",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
  });

  it("includes the new comment in assignment wakes from issue updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "write the whole thing",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "write the whole thing",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it("interrupts the active run and wakes the newly assigned agent with handoff context", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-agent",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop and hand this to CodexCoder",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "stop and hand this to CodexCoder",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
        eventPayload: expect.objectContaining({
          issueId: existing.id,
          source: "issue_comment_interrupt",
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-interrupt-agent",
          wakeCommentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it("interrupts the active run without waking an agent when the handoff assigns a user", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-2",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: "run-2",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-user",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop here, I will take it",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        comment: "stop here, I will take it",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-2",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
      }),
    );
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "stop here, I will take it",
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee on comment-only issue updates", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: "please revise this",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-2",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-2",
          wakeCommentId: "comment-2",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("wakes the assignee on top-level board issue comments", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-3",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please handle this top-level thread comment",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "please handle this top-level thread comment",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-3",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-3",
          wakeCommentId: "comment-3",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("does not route a plain-text agent name on a human-owned issue comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-plain-agent-name",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "QA please take the screenshot",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "QA please take the screenshot",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "QA please take the screenshot",
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("routes a structured mentioned agent without making that agent the issue owner", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-structured-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        payload: {
          issueId: existing.id,
          commentId: "comment-structured-mention",
        },
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-structured-mention",
          wakeCommentId: "comment-structured-mention",
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        }),
      }),
    );
  });
  describe("a person answering a task an agent made for them", () => {
    function agentMadeTask(overrides: Record<string, unknown> = {}) {
      return makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        createdByUserId: null,
        createdByAgentId: CREATOR_AGENT_ID,
        status: "todo",
        ...overrides,
      });
    }

    it("wakes the creating agent when the assigned person comments", async () => {
      const existing = agentMadeTask();
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-answer",
        issueId: existing.id,
        companyId: existing.companyId,
        body: "Use the blue one.",
      });

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: "Use the blue one." });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        CREATOR_AGENT_ID,
        expect.objectContaining({
          reason: "issue_commented",
          payload: expect.objectContaining({ issueId: existing.id, commentId: "comment-answer" }),
          contextSnapshot: expect.objectContaining({
            issueId: existing.id,
            wakeCommentId: "comment-answer",
            wakeReason: "issue_commented",
            source: "issue.comment.assignee_user",
          }),
        }),
      );
    });

    it("also wakes the creating agent when the comment arrives with an issue update", async () => {
      const existing = agentMadeTask();
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue({ ...existing });
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-answer-patch",
        issueId: existing.id,
        companyId: existing.companyId,
        body: "Use the blue one.",
      });

      const res = await request(await createApp())
        .patch(`/api/issues/${existing.id}`)
        .send({ comment: "Use the blue one." });

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        CREATOR_AGENT_ID,
        expect.objectContaining({
          reason: "issue_commented",
          payload: expect.objectContaining({ issueId: existing.id, commentId: "comment-answer-patch" }),
        }),
      );
    });

    it("leaves a task the person created themselves alone", async () => {
      const existing = agentMadeTask({ createdByAgentId: null, createdByUserId: "local-board" });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-own-task",
        issueId: existing.id,
        companyId: existing.companyId,
        body: "Note to self.",
      });

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: "Note to self." });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("does not wake the creating agent when someone else is the assigned person", async () => {
      const existing = agentMadeTask({ assigneeUserId: "someone-else" });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-not-assignee",
        issueId: existing.id,
        companyId: existing.companyId,
        body: "Chiming in.",
      });

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: "Chiming in." });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("does not wake anyone once the task is finished", async () => {
      const existing = agentMadeTask({ status: "done" });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-after-done",
        issueId: existing.id,
        companyId: existing.companyId,
        body: "Thanks.",
      });

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: "Thanks." });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });
});
