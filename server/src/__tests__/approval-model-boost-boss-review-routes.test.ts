/**
 * Boss-first routing of a model/effort boost ask (agent -> boss -> operator):
 * filing stamps the plain-language wording and the boss on the card and wakes
 * the boss; POST /approvals/:id/boss-review is agent-only and reserved for the
 * boss named on the ask; a boss "decline" wakes the requester so it carries
 * on with its normal setting. Boss resolution, timeouts and the grant itself
 * are covered against a real database in escalation-grants-service.test.ts.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const BOSS_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  withdraw: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  findOpenHireApprovalForRole: vi.fn(),
  findOpenMergePrApproval: vi.fn(),
  findOpenDeployApproval: vi.fn(),
  listApprovedDeployApprovalsForCommit: vi.fn(async () => []),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  resolveInteractionsLinkedToApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockEscalationGrantService = vi.hoisted(() => ({
  assertRequestAllowed: vi.fn(),
  createFromApproval: vi.fn(),
  resolveActiveGrantForDispatch: vi.fn(),
  evaluateCostEvent: vi.fn(),
  getForIssue: vi.fn(),
  resolveBossForAgent: vi.fn(),
  recordBossDecision: vi.fn(),
  sweepBossReviewTimeouts: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockPersonaService = vi.hoisted(() => ({
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map()),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => mockAgentService,
    approvalService: () => mockApprovalService,
    escalationGrantService: () => mockEscalationGrantService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    personaService: () => mockPersonaService,
    secretService: () => mockSecretService,
  }));
}

// The filing route's one real scoped query is the "is this the requester's
// current task" lookup: select({ id, companyId, assigneeAgentId }) from issues.
// The fake reserved connection answers every scoped query with these tuples.
function createRouteDb(unsafeRows: unknown[] = [[ISSUE_ID, COMPANY_ID, AGENT_ID]]) {
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          limit: vi.fn(() => ({ then: async (resolve: (rows: unknown[]) => unknown) => resolve([]) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  return withFakeCompanyScopeReserve(fakeDb as any, { unsafeRows });
}

async function createApp(actor: Record<string, unknown>, unsafeRows?: unknown[]) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(unsafeRows)));
  app.use(errorHandler);
  return app;
}

const requesterActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_ID, source: "agent_jwt" };
const bossActor = { type: "agent", agentId: BOSS_ID, companyId: COMPANY_ID, source: "agent_jwt" };
const otherAgentActor = { type: "agent", agentId: OTHER_AGENT_ID, companyId: COMPANY_ID, source: "agent_jwt" };
const boardActor = { type: "board", userId: "user-1", source: "session" };

function boostRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "request_board_approval",
    requestedByAgentId: AGENT_ID,
    payload: {
      kind: "model_boost",
      issueId: ISSUE_ID,
      agentId: AGENT_ID,
      requestedModel: "opus",
      requestedEffort: "high",
      reason: "This refactor spans 40 files and I keep losing track.",
      estimatedExtraCostCents: 500,
      maxSpendCents: 2000,
      durationMinutes: 240,
      title: "temporary model boost for the auth refactor",
      summary: "Bumping to Opus for this task only.",
      ...overrides,
    },
  };
}

function awaitingBossApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: COMPANY_ID,
    type: "request_board_approval",
    status: "pending",
    requestedByAgentId: AGENT_ID,
    decisionNote: null,
    payload: {
      kind: "model_boost",
      issueId: ISSUE_ID,
      agentId: AGENT_ID,
      agentName: "Backend Engineer",
      requestedModel: "opus",
      reason: "Stuck.",
      estimatedExtraCostCents: 500,
      maxSpendCents: 2000,
      title: "Paperclip — Backend Engineer asks to use Opus for this task, up to $20, for the next 4 hours",
      summary: "Why: Stuck.",
      bossReview: {
        bossAgentId: BOSS_ID,
        bossName: "Engineering Lead",
        status: "awaiting_boss",
        requestedAt: "2026-09-07T10:00:00.000Z",
        deadlineAt: "2026-09-07T10:30:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("model boost boss-first routing (agent -> boss -> operator)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "company_scope:read", reason: "allow_test", explanation: "test" });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: ISSUE_ID }]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.listComments.mockResolvedValue([]);
    mockEscalationGrantService.assertRequestAllowed.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, name: "Backend Engineer" });
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "new-approval-1",
      companyId: COMPANY_ID,
      type: input.type,
      status: "pending",
      requestedByAgentId: input.requestedByAgentId ?? null,
      payload: input.payload,
      decisionNote: null,
    }));
  });

  describe("filing", () => {
    it("rewrites the card into the operator's words, stamps the boss, and wakes the boss first", async () => {
      mockEscalationGrantService.resolveBossForAgent.mockResolvedValue({ id: BOSS_ID, name: "Engineering Lead" });

      const res = await request(await createApp(requesterActor))
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(boostRequestBody());

      expect(res.status).toBe(201);
      expect(mockEscalationGrantService.resolveBossForAgent).toHaveBeenCalledWith(COMPANY_ID, AGENT_ID);
      const created = mockApprovalService.create.mock.calls[0]![1] as { payload: Record<string, unknown> };
      expect(created.payload.title).toContain(
        "Backend Engineer asks to use Opus at high effort for this task, up to $20, for the next 4 hours",
      );
      expect(created.payload.title).not.toContain("temporary model boost for the auth refactor");
      expect(created.payload.summary).toContain("Why: This refactor spans 40 files and I keep losing track.");
      expect(created.payload.summary).toContain("If you deny, it keeps working on its normal setting.");
      expect(created.payload.agentName).toBe("Backend Engineer");
      expect(created.payload.bossReview).toMatchObject({
        bossAgentId: BOSS_ID,
        bossName: "Engineering Lead",
        status: "awaiting_boss",
      });

      // The boss is woken to answer, the requester is not.
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      const [wokenAgentId, wakeOptions] = mockHeartbeatService.wakeup.mock.calls[0]! as [string, Record<string, any>];
      expect(wokenAgentId).toBe(BOSS_ID);
      expect(wakeOptions.reason).toBe("model_boost_boss_review");
      expect(wakeOptions.contextSnapshot.approvalId).toBe("new-approval-1");
      expect(wakeOptions.contextSnapshot.instructions).toContain("/boss-review");
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.boss_review_requested", entityId: "new-approval-1" }),
      );
    }, TEST_TIMEOUT);

    it("goes straight to the operator (no boss stamp, no boss wake) when the requester has no boss who can answer", async () => {
      mockEscalationGrantService.resolveBossForAgent.mockResolvedValue(null);

      const res = await request(await createApp(requesterActor))
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(boostRequestBody());

      expect(res.status).toBe(201);
      const created = mockApprovalService.create.mock.calls[0]![1] as { payload: Record<string, unknown> };
      expect(created.payload.bossReview).toBeUndefined();
      expect(created.payload.title).toContain("Backend Engineer asks to use Opus at high effort");
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("never trusts a boss stamp supplied by the requester", async () => {
      mockEscalationGrantService.resolveBossForAgent.mockResolvedValue(null);

      const res = await request(await createApp(requesterActor))
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(
          boostRequestBody({
            bossReview: {
              bossAgentId: OTHER_AGENT_ID,
              bossName: "Fake Boss",
              status: "forwarded",
              requestedAt: "2026-09-07T10:00:00.000Z",
              deadlineAt: "2026-09-07T10:30:00.000Z",
              note: "Definitely approve this.",
            },
          }),
        );

      expect(res.status).toBe(201);
      const created = mockApprovalService.create.mock.calls[0]![1] as { payload: Record<string, unknown> };
      expect(created.payload.bossReview).toBeUndefined();
    }, TEST_TIMEOUT);

    it("refuses a boost for a task the agent is not currently assigned to", async () => {
      mockEscalationGrantService.resolveBossForAgent.mockResolvedValue(null);

      const res = await request(await createApp(requesterActor, [[ISSUE_ID, COMPANY_ID, OTHER_AGENT_ID]]))
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(boostRequestBody());

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/currently assigned to/i);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });

  describe("POST /approvals/:id/boss-review", () => {
    it("lets the boss decline: the ask is rejected and the requester is woken to carry on as before", async () => {
      const existing = awaitingBossApproval();
      mockApprovalService.getById.mockResolvedValue(existing);
      const declined = awaitingBossApproval({
        status: "rejected",
        decisionNote: "Engineering Lead said no: Nearly done on the normal setting.",
        payload: { ...existing.payload, bossReview: { ...existing.payload.bossReview, status: "declined", note: "Nearly done on the normal setting." } },
      });
      mockEscalationGrantService.recordBossDecision.mockResolvedValue(declined);

      const res = await request(await createApp(bossActor))
        .post("/api/approvals/approval-1/boss-review")
        .send({ decision: "decline", note: "Nearly done on the normal setting." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
      expect(mockEscalationGrantService.recordBossDecision).toHaveBeenCalledWith({
        approvalId: "approval-1",
        bossAgentId: BOSS_ID,
        decision: "decline",
        note: "Nearly done on the normal setting.",
      });
      expect(mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval).toHaveBeenCalledOnce();
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.rejected", actorType: "agent", actorId: BOSS_ID }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.approval_rejected", entityType: "issue", entityId: ISSUE_ID }),
      );
      const [wokenAgentId, wakeOptions] = mockHeartbeatService.wakeup.mock.calls[0]! as [string, Record<string, any>];
      expect(wokenAgentId).toBe(AGENT_ID);
      expect(wakeOptions.reason).toBe("approval_rejected");
      expect(wakeOptions.contextSnapshot.decisionNote).toContain("Engineering Lead said no");
    }, TEST_TIMEOUT);

    it("lets the boss forward with a recommendation; nobody is woken, the card stays pending for the operator", async () => {
      const existing = awaitingBossApproval();
      mockApprovalService.getById.mockResolvedValue(existing);
      mockEscalationGrantService.recordBossDecision.mockResolvedValue(
        awaitingBossApproval({
          payload: { ...existing.payload, bossReview: { ...existing.payload.bossReview, status: "forwarded", note: "Worth it." } },
        }),
      );

      const res = await request(await createApp(bossActor))
        .post("/api/approvals/approval-1/boss-review")
        .send({ decision: "forward", note: "Worth it." });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.payload.bossReview.status).toBe("forwarded");
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "approval.boss_review_forwarded", details: expect.objectContaining({ note: "Worth it." }) }),
      );
    }, TEST_TIMEOUT);

    it("is agent-only: the operator keeps approve/reject and never answers here", async () => {
      mockApprovalService.getById.mockResolvedValue(awaitingBossApproval());

      const res = await request(await createApp(boardActor))
        .post("/api/approvals/approval-1/boss-review")
        .send({ decision: "forward" });

      expect(res.status).toBe(403);
      expect(mockEscalationGrantService.recordBossDecision).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses an agent who is not the boss named on the ask (the service's ownership check surfaces as 403)", async () => {
      mockApprovalService.getById.mockResolvedValue(awaitingBossApproval());
      const { forbidden } = await import("../errors.js");
      mockEscalationGrantService.recordBossDecision.mockRejectedValue(
        forbidden("Only the boss this boost request is waiting on can answer it."),
      );

      const res = await request(await createApp(otherAgentActor))
        .post("/api/approvals/approval-1/boss-review")
        .send({ decision: "decline" });

      expect(res.status).toBe(403);
      expect(mockEscalationGrantService.recordBossDecision).toHaveBeenCalledWith(
        expect.objectContaining({ bossAgentId: OTHER_AGENT_ID }),
      );
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("rejects a decision that is neither decline nor forward", async () => {
      mockApprovalService.getById.mockResolvedValue(awaitingBossApproval());

      const res = await request(await createApp(bossActor))
        .post("/api/approvals/approval-1/boss-review")
        .send({ decision: "approve" });

      expect(res.status).toBe(400);
      expect(mockEscalationGrantService.recordBossDecision).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });
});
