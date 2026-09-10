/**
 * DUR-3964 (c): a merge card whose change is already in the branch it asks to
 * merge into is refused at filing time.
 *
 * The incident: an agent filed a merge card whose commit was already an ancestor
 * of `payload.base`, so there was nothing left to merge -- the operator had to
 * work that out by hand and reject it. The card looked exactly like an ordinary
 * merge request.
 *
 * Verifies the refusal (and that it points at the deploy card the agent
 * actually wanted), that the board is never blocked, and that the check fails
 * OPEN in every case where GitHub cannot give a plain answer -- GitHub being
 * unreachable, or a repository it will not show us, must never be the reason a
 * real merge cannot be asked for.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const COMMIT = "8623c28bd1234567890abcdef1234567890abcde";

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
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
  resolveGitHubToken: vi.fn(),
}));
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
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map<string, string>()),
}));
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

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
  vi.doMock("../services/deploy-branches.js", () => ({
    resolveProjectDeployBranches: mockResolveProjectDeployBranches,
    resolveProjectDeployBranchesByProjectId: vi.fn(),
  }));
  vi.doMock("../services/github-fetch.js", () => ({
    ghFetch: mockGhFetch,
    gitHubApiBase: () => "https://api.github.com",
  }));
}

// See the DUR-40 mirror-branch suite for why a single shared 3-value tuple is
// enough here: the run-context lookup falls into its "not this run's own row"
// branch, and the DUR-923 relevance guard sees an unassigned issue, which any
// agent may name. This suite is about the orthogonal already-merged check.
function createMinimalDb() {
  return withFakeCompanyScopeReserve({}, { unsafeRows: [[ISSUE_ID, COMPANY_ID, null]] });
}

async function createApp(actor: Record<string, unknown>) {
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
  app.use("/api", approvalRoutes(createMinimalDb()));
  app.use(errorHandler);
  return app;
}

const createAgentApp = () =>
  createApp({
    type: "agent",
    agentId: "agent-1",
    companyId: COMPANY_ID,
    runId: "run-1",
    source: "api_key",
    isInstanceAdmin: false,
  });

const createBoardApp = () =>
  createApp({
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
  });

function mergePrBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "request_board_approval",
    issueIds: [ISSUE_ID],
    payload: {
      kind: "merge_pr",
      base: "custom",
      repo: "acme/widgets",
      prNumber: 42,
      commit: COMMIT,
      plainSummary: "Ships the invoice page.",
      ...overrides,
    },
  };
}

/** base=commit, head=payload.base: "ahead"/"identical" mean the base already has it. */
function compareAnswers(status: string) {
  mockGhFetch.mockImplementation(async (url: string) => {
    if (url.includes("/compare/")) return new Response(JSON.stringify({ status }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

function messageOf(res: { body: any }) {
  return res.body.message ?? res.body.error ?? "";
}

describe("DUR-3964 (c): a merge card with nothing left to merge is refused at filing time", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
    vi.doUnmock("../services/github-fetch.js");
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
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: ISSUE_ID }]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.resolveGitHubToken.mockResolvedValue(null);
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      companyId: COMPANY_ID,
    });
    // The DUR-40 mirror-branch guard is orthogonal here; leave it a no-op.
    mockResolveProjectDeployBranches.mockResolvedValue(null);
  });

  it(
    "refuses an agent's merge card whose commit the base branch already contains",
    async () => {
      compareAnswers("ahead");
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/already merged into "custom"/i);
      expect(messageOf(res)).toMatch(/8623c28bd123/);
      expect(messageOf(res)).toMatch(/file a deploy card with the commit id/i);
      expect(messageOf(res)).toContain(COMMIT);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses it too when the base is exactly that commit",
    async () => {
      compareAnswers("identical");
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/already merged into "custom"/i);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "files the card when the base does not contain the commit yet -- a real merge",
    async () => {
      compareAnswers("behind");
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "files the card when the two lines of work have diverged",
    async () => {
      compareAnswers("diverged");
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "never blocks the board -- a person may have a reason to file it anyway",
    async () => {
      compareAnswers("identical");
      const app = await createBoardApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when GitHub cannot be reached at all",
    async () => {
      mockGhFetch.mockRejectedValue(new Error("network down"));
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when GitHub will not show us the repository (no key saved, or a key without access)",
    async () => {
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when GitHub's answer is not in the shape we expect",
    async () => {
      mockGhFetch.mockResolvedValue(new Response("not json", { status: 200 }));
      const app = await createAgentApp();

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(mergePrBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "asks GitHub nothing when the card names no commit -- there is nothing to check",
    async () => {
      const app = await createAgentApp();

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(mergePrBody({ commit: undefined }));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "asks GitHub nothing when no repository can be worked out",
    async () => {
      const app = await createAgentApp();

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(mergePrBody({ repo: undefined }));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );
});
