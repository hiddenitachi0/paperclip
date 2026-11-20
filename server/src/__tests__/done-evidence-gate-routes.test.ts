/**
 * Route level (DUR-5179): proves `PATCH /api/issues/:id` consults the done-evidence gate
 * (server/src/services/done-evidence-gate.ts) -- a refusal answers 409 `done_evidence_missing`
 * with the reasons, posts one plain-words system comment and never marks the issue done; it
 * moves the task to in_review only where a review path already exists; report mode lets done
 * through and still posts the note; and the gate is handed the acting agent, the done note and
 * the assignee. The gate's own logic is covered by services/done-evidence-gate.test.ts.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

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

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

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
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockGetGeneral = vi.hoisted(() =>
  vi.fn(async () => ({ doneGate: { mode: "off", maxRounds: 2, companyOverrides: {} } })),
);
const mockEvaluateDoneGateCritic = vi.hoisted(() => vi.fn(async (_input: unknown) => null as unknown));
const mockEvaluateOriginCommitDoneGate = vi.hoisted(() => vi.fn(async (_input: unknown) => null as unknown));
const mockEvaluateDoneEvidenceGate = vi.hoisted(() => vi.fn(async (_input: unknown) => null as unknown));
const mockHasRecentIdenticalNote = vi.hoisted(() => vi.fn(async (_db: unknown, _input: unknown) => false));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));
vi.mock("../services/deploy-branches.js", () => ({
  resolveProjectDeployBranches: vi.fn(async () => null),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({ id: "instance-settings-1", general: {} })),
    getGeneral: mockGetGeneral,
    listCompanyIds: vi.fn(async () => [COMPANY_ID]),
  }),
}));
vi.mock("../services/done-gate-critic.js", () => ({
  evaluateDoneGateCritic: (input: unknown) => mockEvaluateDoneGateCritic(input),
}));
vi.mock("../services/origin-commit-gate.js", () => ({
  evaluateOriginCommitDoneGate: (input: unknown) => mockEvaluateOriginCommitDoneGate(input),
}));
vi.mock("../services/done-evidence-gate.js", () => ({
  evaluateDoneEvidenceGate: (input: unknown) => mockEvaluateDoneEvidenceGate(input),
  hasRecentIdenticalNote: (db: unknown, input: unknown) => mockHasRecentIdenticalNote(db, input),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
    escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({ id: agentId, companyId: COMPANY_ID, permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: { id: reference, companyId: COMPANY_ID, status: "idle", orgChainHealth: { status: "healthy" } },
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
      get: vi.fn(async () => ({ id: "instance-settings-1", general: {} })),
      getGeneral: mockGetGeneral,
      listCompanyIds: vi.fn(async () => [COMPANY_ID]),
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
      actor ?? { type: "board", userId: "local-board", companyIds: [COMPANY_ID], source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  app.use("/api", issueRoutes(withFakeCompanyScopeReserve(mockDb) as any, {} as any));
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

function baseIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    status: "in_review",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-3001",
    title: "Done-gate critic fixture",
    description: "Acceptance: the thing works and is tested.",
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

const AGENT_ACTOR: TestActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID, runId: "run-1" };

const REFUSAL = {
  mode: "enforce",
  refuse: true,
  reason: "not_on_origin",
  message: "Not done yet: commit 1111111 is not on GitHub. Push the work and name the commit that is there.",
  reasons: ["commit 1111111 is not on GitHub. Push the work and name the commit that is there."],
  commits: ["1111111"],
};

describe("PATCH /api/issues/:id -- done-evidence gate wiring (DUR-5179)", () => {
  vi.setConfig({ testTimeout: 45000 });

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
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseIssue({ status: "in_progress" }),
      ...patch,
      updatedAt: new Date(),
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockEvaluateDoneGateCritic.mockResolvedValue(null);
    mockEvaluateOriginCommitDoneGate.mockResolvedValue(null);
    mockEvaluateDoneEvidenceGate.mockResolvedValue(null);
    mockHasRecentIdenticalNote.mockResolvedValue(false);
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

  it("refuses done with 409 done_evidence_missing, posts one plain-words comment and never marks the issue done", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress", projectId: "proj-1" }));
    mockEvaluateDoneEvidenceGate.mockResolvedValue(REFUSAL);

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "Done in commit 1111111, 29 tests pass." });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "done_evidence_missing", error: REFUSAL.message, reasons: REFUSAL.reasons });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(ISSUE_ID, REFUSAL.message, {}, { authorType: "system" });
    expect(mockIssueService.update).not.toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }), expect.anything());
    // No review path exists, so the status is left alone rather than invented.
    expect(mockIssueService.update).not.toHaveBeenCalled();

    const input = mockEvaluateDoneEvidenceGate.mock.calls[0]![0] as Record<string, any>;
    expect(input.issue).toMatchObject({ id: ISSUE_ID, companyId: COMPANY_ID, projectId: "proj-1" });
    expect(input.actor).toEqual({ actorType: "agent", agentId: AGENT_ID, runId: "run-1" });
    expect(input.requestedStatus).toBe("done");
    expect(input.patchComment).toBe("Done in commit 1111111, 29 tests pass.");
    expect(input.otherNoteAgentIds).toEqual([AGENT_ID]);
  });

  it("moves the task to in_review on a refusal when a real review path already exists", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([{ id: "ap-1", status: "pending" }]);
    mockEvaluateDoneEvidenceGate.mockResolvedValue(REFUSAL);

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "in_review" }));
    expect(mockIssueService.update).not.toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });

  it("report mode lets done through and still posts the note", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockEvaluateDoneEvidenceGate.mockResolvedValue({
      ...REFUSAL,
      mode: "report",
      refuse: false,
      message: "Check before done (this company only reports it, the task still closes): commit 1111111 is not on GitHub.",
    });

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.stringContaining("only reports it"),
      {},
      { authorType: "system" },
    );
  });

  it("does not post the same refusal twice in a row, but still answers 409", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockEvaluateDoneEvidenceGate.mockResolvedValue(REFUSAL);
    mockHasRecentIdenticalNote.mockResolvedValue(true);

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("done_evidence_missing");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHasRecentIdenticalNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ issueId: ISSUE_ID, body: REFUSAL.message }),
    );
  });

  it("gates the status AFTER the review policy: a worker whose done only moves the task to review is not gated as done", async () => {
    const REVIEWER_ID = "44444444-4444-4444-8444-444444444444";
    mockIssueService.getById.mockResolvedValue(
      baseIssue({
        status: "in_progress",
        executionPolicy: {
          mode: "normal",
          commentRequired: false,
          stages: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "review", approvalsNeeded: 1, participants: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "agent", agentId: REVIEWER_ID }] }],
        },
      }),
    );

    await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done", comment: "Ready for review." });

    expect(mockEvaluateDoneEvidenceGate).toHaveBeenCalledTimes(1);
    const input = mockEvaluateDoneEvidenceGate.mock.calls[0]![0] as Record<string, any>;
    // The review stage turned the requested done into in_review before the gate looked at it.
    expect(input.requestedStatus).toBe("in_review");
  });

  it("runs the free evidence check before the paid finish check, so a refused move costs nothing (DUR-5209)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress", projectId: "proj-1" }));
    mockEvaluateDoneEvidenceGate.mockResolvedValue(REFUSAL);

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "Done in commit 1111111." });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("done_evidence_missing");
    expect(mockEvaluateDoneGateCritic).not.toHaveBeenCalled();
  });

  it("still runs the paid finish check when the evidence passes, on the status as requested", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));
    mockEvaluateDoneEvidenceGate.mockResolvedValue(null);

    await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done", comment: "Done." });

    expect(mockEvaluateDoneGateCritic).toHaveBeenCalledTimes(1);
    expect((mockEvaluateDoneGateCritic.mock.calls[0]![0] as Record<string, any>).requestedStatus).toBe("done");
  });

  it("lets done through silently when the gate passes or does not apply", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockEvaluateDoneEvidenceGate).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("hands the gate a board actor as non-agent, so the operator is never gated", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));

    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    const input = mockEvaluateDoneEvidenceGate.mock.calls[0]![0] as Record<string, any>;
    expect(input.actor.actorType).not.toBe("agent");
    expect(input.actor.agentId).toBeNull();
  });
});
