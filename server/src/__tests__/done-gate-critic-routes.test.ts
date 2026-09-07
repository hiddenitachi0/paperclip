/**
 * Route level: proves `PATCH /api/issues/:id` actually consults the done-gate quality check
 * (server/src/services/done-gate-critic.ts) and answers 409 with the findings, and that a
 * board actor / a gate that is off never hits it. The gate's own logic (rounds, dry run,
 * escalation) is covered by services/done-gate-critic.test.ts against a real database.
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

describe("PATCH /api/issues/:id -- done-gate quality check wiring", () => {
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
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockEvaluateDoneGateCritic.mockResolvedValue(null);
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

  it("refuses an agent's done with 409 carrying the findings when the critic says needs_work, and never updates the issue", async () => {
    const issue = baseIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockEvaluateDoneGateCritic.mockResolvedValue({
      message: "PAP-3001 can't move to done yet -- an independent quality check found 1 thing(s) that still need work.",
      findings: ["No test was added."],
      escalated: false,
    });

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "All done." });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("can't move to done yet");
    expect(res.body.findings).toEqual(["No test was added."]);
    expect(res.body.escalated).toBe(false);
    expect(mockIssueService.update).not.toHaveBeenCalled();

    // The gate is handed the issue's text, the acting agent, the requested transition, the
    // PATCH's own comment and a way to read the instance setting.
    expect(mockEvaluateDoneGateCritic).toHaveBeenCalledTimes(1);
    const input = mockEvaluateDoneGateCritic.mock.calls[0]![0] as Record<string, any>;
    expect(input.issue).toMatchObject({ id: ISSUE_ID, companyId: COMPANY_ID, title: issue.title, description: issue.description });
    expect(input.actor).toEqual({ actorType: "agent", agentId: AGENT_ID, runId: "run-1" });
    expect(input.requestedStatus).toBe("done");
    expect(input.currentStatus).toBe("in_review");
    expect(input.patchComment).toBe("All done.");
    await expect(input.readGeneralSettings()).resolves.toEqual({ doneGate: { mode: "off", maxRounds: 2, companyOverrides: {} } });
  });

  it("lets done through when the gate returns null (off, dry run, pass, or critic unavailable)", async () => {
    const issue = baseIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp(AGENT_ACTOR)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockEvaluateDoneGateCritic).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });

  it("passes a board actor through to the gate as non-agent so it is never gated", async () => {
    const issue = baseIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    const input = mockEvaluateDoneGateCritic.mock.calls[0]![0] as Record<string, any>;
    // getActorInfo reports a local board session as "user"; what matters is that it is not "agent".
    expect(input.actor.actorType).not.toBe("agent");
    expect(input.actor.agentId).toBeNull();
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "done" }));
  });
});
