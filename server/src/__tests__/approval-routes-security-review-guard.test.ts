/**
 * DUR-4566 item 4: approving a merge card (`kind: "merge_pr"`) with no
 * `passed` security review at its current head commit needs an explicit,
 * reasoned "approve without security review" opt-in -- otherwise the route
 * refuses outright. Reject is never gated this way; this suite only covers
 * the /approve guard in server/src/routes/approvals.ts.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// `vi.resetModules()` in beforeEach re-transforms the large approvals.ts
// dependency graph on every test; the first test to hit that cold-start
// cost can exceed the default 5s budget.
vi.setConfig({ testTimeout: 20_000 });

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  findOpenHireApprovalForRole: vi.fn(),
  findOpenMergePrApproval: vi.fn(),
  findOpenDeployApproval: vi.fn(),
  listApprovedDeployApprovalsForCommit: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
  listApprovalsForIssue: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  resolveInteractionsLinkedToApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockEscalationGrantService = vi.hoisted(() => ({
  assertRequestAllowed: vi.fn(),
  createFromApproval: vi.fn(),
  resolveActiveGrantForDispatch: vi.fn(),
  evaluateCostEvent: vi.fn(),
  getForIssue: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockPersonaService = vi.hoisted(() => ({
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map()),
}));

// securityReviewService is imported directly by routes/approvals.ts (not
// through services/index.js), so it needs its own module mock. The real
// isMergePrApprovalPayload is trivial (`payload.kind === "merge_pr"`) and is
// reimplemented here rather than imported, so this suite doesn't also pull in
// the real security-review.ts module graph.
const mockSecurityReviewService = vi.hoisted(() => ({
  computeState: vi.fn(),
  requestReview: vi.fn(),
  recordVerdict: vi.fn(),
  getReviewerAgentId: vi.fn(),
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
  vi.doMock("../services/security-review.js", () => ({
    isMergePrApprovalPayload: (payload: unknown) =>
      Boolean(payload) && typeof payload === "object" && (payload as Record<string, unknown>).kind === "merge_pr",
    securityReviewService: () => mockSecurityReviewService,
  }));
}

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

async function createBoardApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(withFakeCompanyScopeReserve({})));
  app.use(errorHandler);
  return app;
}

function mergePrApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: COMPANY_ID,
    type: "request_board_approval",
    status: "pending",
    payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42, commit: "deadbeef", title: "Ship it" },
    requestedByAgentId: "agent-1",
    ...overrides,
  };
}

describe("DUR-4566: /approve is guarded by the merge card's security-review state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/security-review.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...mergePrApproval(), status: "approved" },
      applied: true,
    });
  });

  it("refuses to approve a merge card with no passed review and no bypass", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockSecurityReviewService.computeState.mockResolvedValue({
      state: "not_requested",
      headCommit: "deadbeef",
      reviewIssueId: null,
      reviewIssueIdentifier: null,
      verdictNote: null,
      verdictCommentUrl: null,
      decidedAt: null,
      priorState: null,
    });

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Approve without security review");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("refuses an out-of-date review (a later push invalidates a prior pass) without a bypass", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockSecurityReviewService.computeState.mockResolvedValue({
      state: "out_of_date",
      headCommit: "oldsha",
      reviewIssueId: "issue-1",
      reviewIssueIdentifier: "DUR-1",
      verdictNote: "looks good",
      verdictCommentUrl: null,
      decidedAt: new Date().toISOString(),
      priorState: "passed",
    });

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(422);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("approves with an explicit bypass reason, recording it in the activity log", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockSecurityReviewService.computeState.mockResolvedValue({
      state: "not_requested",
      headCommit: "deadbeef",
      reviewIssueId: null,
      reviewIssueIdentifier: null,
      verdictNote: null,
      verdictCommentUrl: null,
      decidedAt: null,
      priorState: null,
    });

    const res = await request(await createBoardApp())
      .post("/api/approvals/approval-1/approve")
      .send({ approveWithoutSecurityReview: { reason: "Filip reviewed it himself, shipping now" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved_without_security_review",
        entityId: "approval-1",
        details: expect.objectContaining({
          securityReviewState: "not_requested",
          reason: "Filip reviewed it himself, shipping now",
        }),
      }),
    );
  });

  it("approves a merge card directly when the review already passed at the current head commit", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockSecurityReviewService.computeState.mockResolvedValue({
      state: "passed",
      headCommit: "deadbeef",
      reviewIssueId: "issue-1",
      reviewIssueIdentifier: "DUR-1",
      verdictNote: "Looks fine",
      verdictCommentUrl: null,
      decidedAt: new Date().toISOString(),
      priorState: null,
    });

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "approval.approved_without_security_review" }),
    );
  });

  it("does not gate approvals that aren't merge cards", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: COMPANY_ID,
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockSecurityReviewService.computeState).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).toHaveBeenCalled();
  });
});
