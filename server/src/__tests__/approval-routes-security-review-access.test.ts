/**
 * DUR-4568 finding #2: POST /approvals/:id/security-review/request and
 * POST /approvals/:id/security-review/verdict used to sit behind plain
 * `company_scope:read` -- any company agent or read-only board member could
 * file a review request or, worse, record a verdict. `recordVerdict` itself
 * still re-checks that an agent actor really is the configured reviewer, but
 * a board actor needs the same owner/admin bar as changing who the reviewer
 * is (security-review-settings.ts). This suite covers that route-level gate
 * (checkSecurityReviewActionAccess in routes/approvals.ts), not the
 * authorization logic inside the service itself (covered in
 * security-review.test.ts).
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

vi.setConfig({ testTimeout: 20_000 });

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

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

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
  listApprovalsForIssue: vi.fn(),
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
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockPersonaService = vi.hoisted(() => ({
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map()),
}));

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

type Actor =
  | { type: "board"; userId: string; role: "owner" | "admin" | "member" | null; isInstanceAdmin?: boolean }
  | { type: "agent"; agentId: string; companyId: string };

async function createApp(actor: Actor) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "board") {
      (req as any).actor = {
        type: "board",
        userId: actor.userId,
        companyIds: [COMPANY_ID],
        source: "session",
        isInstanceAdmin: actor.isInstanceAdmin ?? false,
        memberships: actor.role
          ? [{ companyId: COMPANY_ID, status: "active", membershipRole: actor.role }]
          : [],
      };
    } else {
      (req as any).actor = {
        type: "agent",
        agentId: actor.agentId,
        companyId: actor.companyId,
        source: "agent",
      };
    }
    next();
  });
  app.use("/api", approvalRoutes(withFakeCompanyScopeReserve({})));
  app.use(errorHandler);
  return app;
}

function mergePrApproval() {
  return {
    id: "approval-1",
    companyId: COMPANY_ID,
    type: "request_board_approval",
    status: "pending",
    payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42, commit: "deadbeef", title: "Ship it" },
    requestedByAgentId: "agent-1",
  };
}

describe("DUR-4568 finding #2: /security-review/request and /verdict require more than read access", () => {
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
    mockApprovalService.getById.mockResolvedValue(mergePrApproval());
    mockSecurityReviewService.requestReview.mockResolvedValue({ state: "in_progress" });
    mockSecurityReviewService.recordVerdict.mockResolvedValue({ state: "passed" });
  });

  it("refuses a read-only board member on /security-review/request", async () => {
    const res = await request(await createApp({ type: "board", userId: "user-1", role: "member" }))
      .post("/api/approvals/approval-1/security-review/request")
      .send({});

    expect(res.status).toBe(403);
    expect(mockSecurityReviewService.requestReview).not.toHaveBeenCalled();
  });

  it("refuses a read-only board member on /security-review/verdict", async () => {
    const res = await request(await createApp({ type: "board", userId: "user-1", role: "member" }))
      .post("/api/approvals/approval-1/security-review/verdict")
      .send({ verdict: "passed", note: "forged" });

    expect(res.status).toBe(403);
    expect(mockSecurityReviewService.recordVerdict).not.toHaveBeenCalled();
  });

  it("refuses a board member with no membership role at all", async () => {
    const res = await request(await createApp({ type: "board", userId: "user-1", role: null }))
      .post("/api/approvals/approval-1/security-review/verdict")
      .send({ verdict: "passed", note: "forged" });

    expect(res.status).toBe(403);
    expect(mockSecurityReviewService.recordVerdict).not.toHaveBeenCalled();
  });

  it("allows a company owner to request a review", async () => {
    const res = await request(await createApp({ type: "board", userId: "owner-1", role: "owner" }))
      .post("/api/approvals/approval-1/security-review/request")
      .send({});

    expect(res.status).toBe(200);
    expect(mockSecurityReviewService.requestReview).toHaveBeenCalled();
  });

  it("allows a company admin to record a verdict", async () => {
    const res = await request(await createApp({ type: "board", userId: "admin-1", role: "admin" }))
      .post("/api/approvals/approval-1/security-review/verdict")
      .send({ verdict: "passed", note: "Looks fine" });

    expect(res.status).toBe(200);
    expect(mockSecurityReviewService.recordVerdict).toHaveBeenCalled();
  });

  it("lets a company agent through the route gate (recordVerdict still enforces the configured-reviewer check itself)", async () => {
    const res = await request(await createApp({ type: "agent", agentId: "agent-2", companyId: COMPANY_ID }))
      .post("/api/approvals/approval-1/security-review/verdict")
      .send({ verdict: "passed", note: "Looks fine" });

    expect(res.status).toBe(200);
    expect(mockSecurityReviewService.recordVerdict).toHaveBeenCalled();
  });
});
