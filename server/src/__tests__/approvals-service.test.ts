import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => mockBudgetService),
}));

const mockSecurityReviewService = vi.hoisted(() => ({
  computeState: vi.fn(),
}));

vi.mock("../services/security-review.js", () => ({
  securityReviewService: vi.fn(() => mockSecurityReviewService),
  isMergePrApprovalPayload: (payload: unknown) =>
    Boolean(payload) && typeof payload === "object" && (payload as Record<string, unknown>).kind === "merge_pr",
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createMergePrApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status,
    payload: { kind: "merge_pr", repo: "acme/paperclip", prNumber: 42, commit: "deadbeef" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });
});

// DUR-3976: approving a hire card must leave the new agent with the monthly
// limit the card showed, enforced by a budget policy (the row column alone
// enforces nothing).
describe("approving a hire card applies its monthly spending limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-new" });
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
  });

  function approveCard(payload: Record<string, unknown>) {
    const pending = { ...createApproval("pending"), payload };
    const approved = { ...createApproval("approved"), payload };
    const dbStub = createDbStub([[pending]], [approved]);
    const svc = approvalService(dbStub.db as any);
    return { dbStub, result: svc.approve("approval-1", "board-user", "ok") };
  }

  it("creates the enforcing policy with the amount on the card", async () => {
    const { result } = approveCard({ agentId: "agent-1", budgetMonthlyCents: 5000 });
    await result;

    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      { scopeType: "agent", scopeId: "agent-1", amount: 5000, windowKind: "calendar_month_utc" },
      "board-user",
    );
  });

  it("gives a card that does not mention a limit the standard $50, never no limit", async () => {
    const { result } = approveCard({ agentId: "agent-1" });
    await result;

    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ scopeId: "agent-1", amount: 5000 }),
      "board-user",
    );
  });

  it("rebuilds an agent from the card with the card's limit, and enforces it", async () => {
    const { result } = approveCard({ name: "Analyst", budgetMonthlyCents: 30000 });
    await result;

    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ budgetMonthlyCents: 30000 }),
    );
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ scopeType: "agent", scopeId: "agent-new", amount: 30000 }),
      "board-user",
    );
  });

  it("creates no policy for an explicit 'no monthly limit' card, and makes the agent say so", async () => {
    const { dbStub, result } = approveCard({ agentId: "agent-1", budgetMonthlyCents: 0 });
    await result;

    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(dbStub.db.update).toHaveBeenCalledWith(agents);
  });
});

describe("approvalService.withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels a pending approval", async () => {
    const cancelled = createApproval("cancelled");
    const dbStub = createDbStub([[createApproval("pending")]], [cancelled]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", "stale duplicate");

    expect(result.status).toBe("cancelled");
  });

  it("cancels a revision-requested approval", async () => {
    const cancelled = createApproval("cancelled");
    const dbStub = createDbStub([[createApproval("revision_requested")]], [cancelled]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1");

    expect(result.status).toBe("cancelled");
  });

  it("refuses to withdraw an already-decided approval", async () => {
    const dbStub = createDbStub([[createApproval("approved")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1")).rejects.toThrow(
      "Only pending or revision requested approvals can be withdrawn",
    );
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});

// DUR-4568 finding #1: the security-review gate lives inside approve()
// itself so every caller is covered (the HTTP route, issue-thread-interaction
// auto-decisions, merge-pr automation) -- not just the /approve route.
describe("approve() gates merge_pr cards on their security-review state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockSecurityReviewService.computeState.mockReset();
    mockLogActivity.mockReset().mockResolvedValue(undefined);
  });

  it("refuses to approve a merge card with no passed review and no bypass reason", async () => {
    const dbStub = createDbStub([[createMergePrApproval("pending")]], []);
    mockSecurityReviewService.computeState.mockResolvedValue({ state: "not_requested" });

    const svc = approvalService(dbStub.db as any);
    await expect(svc.approve("approval-1", "board", "ship it")).rejects.toThrow(
      /security review/i,
    );

    expect(dbStub.returning).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("approves with a bypass reason and logs it to the activity log", async () => {
    const approved = createMergePrApproval("approved");
    const dbStub = createDbStub([[createMergePrApproval("pending")]], [approved]);
    mockSecurityReviewService.computeState.mockResolvedValue({ state: "out_of_date" });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it", {
      securityReviewBypass: { reason: "Filip reviewed it himself", actorType: "user", actorId: "user-1" },
    });

    expect(result.applied).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved_without_security_review",
        entityId: "approval-1",
        details: expect.objectContaining({ securityReviewState: "out_of_date", reason: "Filip reviewed it himself" }),
      }),
    );
  });

  it("approves a merge card directly when the review already passed, with no activity entry", async () => {
    const approved = createMergePrApproval("approved");
    const dbStub = createDbStub([[createMergePrApproval("pending")]], [approved]);
    mockSecurityReviewService.computeState.mockResolvedValue({ state: "passed" });

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not gate approvals that aren't merge cards", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockSecurityReviewService.computeState).not.toHaveBeenCalled();
  });
});

// Agents asked for approvals by their shortened id ("4a365896"). Postgres
// rejects that as a uuid, and the query error surfaced as a 500 on
// GET /api/approvals/:id, eight times in one afternoon.
describe("approvalService getById with an id that is not a uuid", () => {
  it("treats a shortened id as not found without asking the database", async () => {
    const select = vi.fn(() => {
      throw new Error('invalid input syntax for type uuid: "4a365896"');
    });
    const svc = approvalService({ select } as any);

    await expect(svc.getById("4a365896")).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("still looks up every full hex id, including ones without a version digit", async () => {
    const found = { ...createApproval("pending"), id: "11111111-1111-1111-1111-111111111111" };
    const dbStub = createDbStub([[found], [createApproval("pending")]], []);
    const svc = approvalService(dbStub.db as any);

    await expect(svc.getById("11111111-1111-1111-1111-111111111111")).resolves.toEqual(found);
    await expect(svc.getById("9abd6c8e-4c1d-40e7-a81e-73d1481c25ef")).resolves.toMatchObject({ id: "approval-1" });
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(2);
  });
});

// Security review of PR #625 (DUR-4719): host actions and deploys can only be
// approved by POST /approvals/:id/approve, which runs their own checks first
// (owner/admin + card shape for host actions). Every other approve() caller
// -- a linked confirmation accepted by any board member, automation -- is
// refused here, whoever the actor is.
describe("approve() refuses card-only kinds outside the approval route", () => {
  function cardOnly(kind: string): ApprovalRecord {
    return {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: { kind, action: "restart_service", target: "telegram-bridge" },
      requestedByAgentId: "requester-1",
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockReset().mockResolvedValue(undefined);
  });

  for (const kind of ["operator_action", "deploy", "deploy_pr"]) {
    it(`refuses a ${kind} card without decidedOnApprovalCard`, async () => {
      const dbStub = createDbStub([[cardOnly(kind)]], []);
      const svc = approvalService(dbStub.db as any);
      await expect(svc.approve("approval-1", "board-member", null)).rejects.toThrow(/approval card itself/);
      expect(dbStub.returning).not.toHaveBeenCalled();
    });
  }

  it("approves an operator_action card when the approval route says it ran its checks", async () => {
    const approved = { ...cardOnly("operator_action"), status: "approved" };
    const dbStub = createDbStub([[cardOnly("operator_action")]], [approved]);
    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "owner", null, { decidedOnApprovalCard: true });
    expect(result.applied).toBe(true);
    expect(result.approval.status).toBe("approved");
  });
});
