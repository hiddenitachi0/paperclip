/**
 * DUR-4566 item 4 / DUR-4568 finding #1: approving a merge card (`kind:
 * "merge_pr"`) with no `passed` security review at its current head commit
 * needs an explicit, reasoned "approve without security review" opt-in. The
 * actual gate (the state check, the refusal, the activity log) lives inside
 * `approvalService.approve()` itself now, so every caller is covered -- not
 * just this route. This suite covers only what the /approve route still
 * owns: forwarding the user's bypass reason into `approve()`'s options, and
 * surfacing whatever `approve()` decides.
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

  it("forwards no bypass option when the request includes no reason", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-1",
      "user-1",
      undefined,
      expect.objectContaining({ securityReviewBypass: undefined }),
    );
  });

  it("forwards the bypass reason as a user-actor option on approve()", async () => {
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());

    const res = await request(await createBoardApp())
      .post("/api/approvals/approval-1/approve")
      .send({ approveWithoutSecurityReview: { reason: "Filip reviewed it himself, shipping now" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-1",
      "user-1",
      undefined,
      expect.objectContaining({
        securityReviewBypass: { reason: "Filip reviewed it himself, shipping now", actorType: "user", actorId: "user-1" },
      }),
    );
  });

  it("surfaces approve()'s refusal when the merge card has no passed review and no bypass", async () => {
    const { unprocessable } = await import("../errors.js");
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockApprovalService.approve.mockRejectedValue(
      unprocessable("This merge card has no passed security review at its current commit"),
    );

    const res = await request(await createBoardApp()).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(422);
  });

  it("does not require getById to classify the payload before calling approve()", async () => {
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
    expect(mockApprovalService.approve).toHaveBeenCalled();
  });
});
