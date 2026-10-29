/**
 * Trading strategy rule cards (kind "trading_strategy_version", DUR-5002),
 * the approve and reject routes:
 *
 * - Only a person who is the company's owner/admin (or an instance admin) can
 *   approve, and only on the card route; a member, an agent, and Board chat
 *   (which is how Telegram messages reach the system) cannot.
 * - Approving first activates the stored draft whose own card this is, and only
 *   then marks the card approved, with the card-route flag set. If the
 *   activation refuses (card text differs, digest differs, replaced draft), the
 *   card is NOT approved.
 * - Rejecting a card closes its draft and leaves the running rules alone.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TIMEOUT = 20_000;

vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    createRequestScopedDb: (rawDb: unknown) => rawDb,
    runInCompanyScope: async (_rawDb: unknown, _companyId: string, fn: () => unknown) => fn(),
    withCompanyScope: async (rawDb: any, _companyId: string, fn: (tx: unknown) => unknown) => rawDb.transaction(fn),
  };
});

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
  findOpenFeatureLaunchApproval: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn(), linkManyForApproval: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockVersions = vi.hoisted(() => ({
  approveFromCard: vi.fn(),
  supersedeDraftForCard: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => ({ getById: vi.fn() }),
    approvalService: () => mockApprovalService,
    personaService: () => ({ getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map<string, string>()) }),
    escalationGrantService: () => ({}),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => mockIssueApprovalService,
    issueThreadInteractionService: () => ({ resolveInteractionsLinkedToApproval: vi.fn(async () => []) }),
    logActivity: mockLogActivity,
    secretService: () => ({ getById: vi.fn() }),
  }));
  vi.doMock("../services/trading-versions.js", () => ({
    tradingVersionsService: () => mockVersions,
  }));
}

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const card = (over: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  companyId: COMPANY_A,
  type: "request_board_approval",
  status: "pending",
  payload: { kind: "trading_strategy_version", versionId: "v", specDigest: "d".repeat(64) },
  requestedByAgentId: null,
  requestedByUserId: null,
  decisionNote: null,
  ...over,
});

const ownerActor = {
  type: "board",
  userId: "user-owner",
  companyIds: [COMPANY_A, COMPANY_B],
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: COMPANY_A, membershipRole: "owner", status: "active" }],
};
const adminActor = { ...ownerActor, userId: "user-admin", memberships: [{ companyId: COMPANY_A, membershipRole: "admin", status: "active" }] };
const memberActor = { ...ownerActor, userId: "user-member", memberships: [{ companyId: COMPANY_A, membershipRole: "member", status: "active" }] };
const operatorActor = { ...ownerActor, userId: "user-operator", memberships: [{ companyId: COMPANY_A, membershipRole: "operator", status: "active" }] };
const instanceAdminActor = { ...memberActor, userId: "user-instance", isInstanceAdmin: true, memberships: [] };
const agentActor = { type: "agent", agentId: AGENT_ID, companyId: COMPANY_A, source: "agent_jwt" };
const boardChatActor = { ...ownerActor, source: "board_chat" };
const otherCompanyOwner = { ...ownerActor, userId: "user-other", companyIds: [COMPANY_B], memberships: [{ companyId: COMPANY_B, membershipRole: "owner", status: "active" }] };

function createRouteDb() {
  return {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: async (resolve: (rows: unknown[]) => unknown) => resolve([]), limit: vi.fn(() => ({ then: async (resolve: (rows: unknown[]) => unknown) => resolve([]) })) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([import("../middleware/index.js"), import("../routes/approvals.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

describe("trading_strategy_version approvals", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/trading-versions.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "company_scope:read", reason: "allow_test", explanation: "ok" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(card());
    mockApprovalService.listComments.mockResolvedValue([]);
    mockApprovalService.approve.mockImplementation(async () => ({ approval: card({ status: "approved" }), applied: true }));
    mockApprovalService.reject.mockImplementation(async () => ({ approval: card({ status: "rejected" }), applied: true }));
    mockVersions.approveFromCard.mockResolvedValue({});
    mockVersions.supersedeDraftForCard.mockResolvedValue(undefined);
  });

  describe("approving", () => {
    it.each([
      ["owner", ownerActor, "user-owner"],
      ["admin", adminActor, "user-admin"],
      ["instance admin", instanceAdminActor, "user-instance"],
    ])("lets the company's %s approve: the stored draft goes live first, then the card is marked approved on the card route", async (_label, actor, userId) => {
      const res = await request(await createApp(actor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(200);
      expect(mockVersions.approveFromCard).toHaveBeenCalledWith(COMPANY_A, APPROVAL_ID, userId);
      expect(mockApprovalService.approve).toHaveBeenCalledTimes(1);
      expect(mockApprovalService.approve.mock.calls[0]![3]).toMatchObject({ decidedOnApprovalCard: true });
      expect(mockVersions.approveFromCard.mock.invocationCallOrder[0]!).toBeLessThan(mockApprovalService.approve.mock.invocationCallOrder[0]!);
    }, TEST_TIMEOUT);

    it.each([
      ["a plain member", memberActor],
      ["an operator", operatorActor],
      ["an owner of another company", otherCompanyOwner],
    ])("refuses %s, and nothing is activated or approved", async (_label, actor) => {
      const res = await request(await createApp(actor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(403);
      expect(mockVersions.approveFromCard).not.toHaveBeenCalled();
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses an agent, whoever filed the card", async () => {
      mockApprovalService.getById.mockResolvedValue(card({ requestedByAgentId: AGENT_ID }));
      const res = await request(await createApp(agentActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(403);
      expect(mockVersions.approveFromCard).not.toHaveBeenCalled();
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("refuses Board chat (how Telegram messages reach the system), even for an owner", async () => {
      const res = await request(await createApp(boardChatActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(403);
      expect(mockVersions.approveFromCard).not.toHaveBeenCalled();
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("does not mark the card approved when the activation refuses (card text or digest differs, draft replaced)", async () => {
      const { conflict } = await import("../errors.js");
      mockVersions.approveFromCard.mockRejectedValue(conflict("The card does not show the stored rules (the card's summary differs from the stored draft). Nothing was approved.", { code: "trading_version_card_mismatch" }));
      const res = await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("does not show the stored rules");
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("skips the activation for a card that is already decided and lets approve() answer", async () => {
      mockApprovalService.getById.mockResolvedValue(card({ status: "approved" }));
      mockApprovalService.approve.mockResolvedValue({ approval: card({ status: "approved" }), applied: false });
      const res = await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/approve`).send({});
      expect(res.status).toBe(200);
      expect(mockVersions.approveFromCard).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });

  describe("rejecting", () => {
    it("closes the draft and leaves the running rules alone", async () => {
      const res = await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/reject`).send({ decisionNote: "No." });
      expect(res.status).toBe(200);
      expect(mockVersions.supersedeDraftForCard).toHaveBeenCalledWith(COMPANY_A, APPROVAL_ID);
      expect(mockVersions.approveFromCard).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);

    it("does nothing to the draft when the reject did not apply", async () => {
      mockApprovalService.reject.mockResolvedValue({ approval: card({ status: "rejected" }), applied: false });
      await request(await createApp(ownerActor)).post(`/api/approvals/${APPROVAL_ID}/reject`).send({});
      expect(mockVersions.supersedeDraftForCard).not.toHaveBeenCalled();
    }, TEST_TIMEOUT);
  });

  it("Board chat policy refuses to decide the card in any way", async () => {
    const { boardChatApprovalRefusal } = await import("../services/board-chat-policy.js");
    expect(boardChatApprovalRefusal({ type: "request_board_approval", payload: { kind: "trading_strategy_version" } })).toMatch(/can't decide this kind of card/);
  });

  it("a confirmation card may not name it, because the decision belongs on the approval card", async () => {
    const { mustBeDecidedOnApprovalCard, describeApprovalForAgent } = await import("../services/confirmation-approval-references.js");
    const approval = { type: "request_board_approval", payload: { kind: "trading_strategy_version" } };
    expect(mustBeDecidedOnApprovalCard(approval)).toBe(true);
    expect(describeApprovalForAgent(approval)).toBe("a trading strategy rules approval");
  });
});
