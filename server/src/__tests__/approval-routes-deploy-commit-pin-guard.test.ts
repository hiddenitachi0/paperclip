/**
 * DUR-3964 (a): a deploy card filed by an agent must name the exact commit, in full.
 *
 * The incident: an agent filed a deploy card with the commit id written into the
 * card's note but the card's own commit field left empty. Nothing reads the
 * note, so approving that card would have deployed whatever the branch tip
 * happened to be, not the commit that had been reviewed. A second card carried a
 * mistyped id.
 *
 * Verifies the refusal for a missing commit id (and that it says so in as many
 * words when the note mentions one), the refusal for a shortened one, that the
 * board may still file without a commit (deploying the top of the branch on
 * purpose), and that the commit the card would REALLY deploy is stamped onto the
 * payload either way -- falling back safely, never refusing, when GitHub cannot
 * answer.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
/** A written-out commit id: all 40 characters, exactly what `git rev-parse HEAD` prints. */
const FULL_COMMIT = "8623c28bd1234567890abcdef1234567890abcde";
/** The same commit as an agent typically pastes it -- an abbreviation. */
const SHORT_COMMIT = "8623c28";
/** What is at the top of the deploy branch right now. */
const BRANCH_TIP = "f00dcafe0123456789abcdef0123456789abcdef";

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

const mockResolveProjectDeployBranchesByProjectId = vi.hoisted(() => vi.fn());
const mockResolveProjectDeployWorkspaceId = vi.hoisted(() => vi.fn(async () => null as string | null));
const mockResolveLiveDeployCommit = vi.hoisted(() => vi.fn(async () => null as string | null));
const mockGhFetch = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => mockAgentService,
    approvalService: () => mockApprovalService,
    personaService: () => ({ getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map<string, string>()) }),
    escalationGrantService: () => mockEscalationGrantService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/deploy-branches.js", () => ({
    resolveProjectDeployBranches: vi.fn(),
    resolveProjectDeployBranchesByProjectId: mockResolveProjectDeployBranchesByProjectId,
  }));
  vi.doMock("../services/deploy-workspace.js", async () => {
    const actual =
      await vi.importActual<typeof import("../services/deploy-workspace.js")>("../services/deploy-workspace.js");
    return { ...actual, resolveProjectDeployWorkspaceId: mockResolveProjectDeployWorkspaceId };
  });
  // Only the "which version is live" lookup is mocked -- the wording of every
  // refusal stays real, so the messages these tests assert on are the ones an
  // agent actually reads.
  vi.doMock("../services/deploy-change-guard.js", async () => {
    const actual =
      await vi.importActual<typeof import("../services/deploy-change-guard.js")>("../services/deploy-change-guard.js");
    return { ...actual, resolveLiveDeployCommit: mockResolveLiveDeployCommit };
  });
  vi.doMock("../services/github-fetch.js", () => ({
    ghFetch: mockGhFetch,
    gitHubApiBase: () => "https://api.github.com",
  }));
}

/**
 * Same shape as the sibling deploy-guard suites: approvals.ts's own db.select()
 * calls run through the request-scoped proxy, so only the reserved connection's
 * answers matter. The workspace row is read with one column (repoUrl) by the
 * older guards and with three (repoUrl, repoRef, defaultRef) by the DUR-3964
 * target-commit lookup, so the two are told apart by the compiled SQL.
 */
function createRouteDb(workspaceRepoUrl: string | null | undefined = "https://github.com/acme/widgets") {
  const fakeDb = withFakeCompanyScopeReserve({});
  const client = (fakeDb as unknown as { $client: { reserve: () => Promise<unknown> } }).$client;
  client.reserve = async () => {
    const reserved = async (..._args: unknown[]) => [];
    Object.assign(reserved, {
      release: () => {},
      unsafe: (query: string) => {
        const rows = query.includes("project_workspaces")
          ? workspaceRepoUrl === undefined
            ? []
            : query.includes("repo_ref")
              ? [[workspaceRepoUrl, "custom", "main"]]
              : [[workspaceRepoUrl]]
          : query.includes("projects")
            ? [[PROJECT_ID, COMPANY_ID]]
            : [];
        const result: Promise<unknown[]> & { values?: () => Promise<unknown[]> } = Promise.resolve(rows);
        result.values = () => Promise.resolve(rows);
        return result;
      },
    });
    return reserved;
  };
  return fakeDb;
}

async function createApp(db: any, actor: Record<string, unknown>) {
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
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

const createAgentApp = (db: any) =>
  createApp(db, {
    type: "agent",
    agentId: "agent-1",
    companyId: COMPANY_ID,
    runId: "run-1",
    source: "api_key",
    isInstanceAdmin: false,
  });

const createBoardApp = (db: any) =>
  createApp(db, {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
  });

function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "request_board_approval",
    payload: {
      kind: "deploy",
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      commit: FULL_COMMIT,
      title: "Deploy widgets",
      note: "Ship it",
      ...overrides,
    },
  };
}

/**
 * Answers every GitHub call the filing path makes. The compare answers keep the
 * older guards quiet (nothing is known to be live in this suite anyway), and a
 * commit lookup answers with the ref itself when it is a full commit id, or with
 * the branch tip when it is a branch name -- which is what GitHub does.
 */
function githubAnswers() {
  mockGhFetch.mockImplementation(async (url: string) => {
    if (url.includes("/branches-where-head")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/compare/")) return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
    if (url.includes("/commits/")) {
      const ref = decodeURIComponent(url.split("/commits/")[1] ?? "");
      const sha = /^[0-9a-f]{40}$/i.test(ref) ? ref : BRANCH_TIP;
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }
    return new Response(JSON.stringify({ full_name: "acme/widgets" }), { status: 200 });
  });
}

function messageOf(res: { body: any }) {
  return res.body.message ?? res.body.error ?? "";
}

const stampedPayload = () => mockApprovalService.create.mock.calls[0]?.[1]?.payload;

describe("DUR-3964 (a): a deploy card must name the exact commit it would deploy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
    vi.doUnmock("../services/deploy-workspace.js");
    vi.doUnmock("../services/deploy-change-guard.js");
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
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.resolveGitHubToken.mockResolvedValue(null);
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: any) => ({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: input?.payload ?? {},
      companyId: COMPANY_ID,
      requestedByAgentId: "agent-1",
    }));
    mockApprovalService.resubmit.mockResolvedValue({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      companyId: COMPANY_ID,
      requestedByAgentId: "agent-1",
    });
    mockResolveProjectDeployWorkspaceId.mockResolvedValue(null);
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
      projectId: PROJECT_ID,
    });
    mockResolveLiveDeployCommit.mockResolvedValue(null);
    githubAnswers();
  });

  it(
    "refuses an agent's card with no commit id, and says so plainly when the note names one",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: undefined, note: `Deploying ${SHORT_COMMIT}f00 after the merge.` }));

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/does not say which commit to deploy/i);
      expect(messageOf(res)).toMatch(/commit field is empty/i);
      expect(messageOf(res)).toMatch(/8623c28f00/);
      expect(messageOf(res)).toMatch(/git rev-parse HEAD/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
      // The refusal needs nothing from GitHub -- it is about the card itself.
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses an agent's card with no commit id even when nothing in the text looks like one",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: undefined, note: "Ready to ship the new invoice page." }));

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/does not say which commit to deploy/i);
      expect(messageOf(res)).not.toMatch(/commit field is empty/i);
      expect(messageOf(res)).toMatch(/git rev-parse HEAD/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses an agent's card whose commit id is a shortened one",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: SHORT_COMMIT }));

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/not a full commit id/i);
      expect(messageOf(res)).toMatch(/40 characters/);
      expect(messageOf(res)).toMatch(/git rev-parse HEAD/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses an agent's card whose commit is a branch name rather than a commit id",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody({ commit: "custom" }));

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/not a full commit id/i);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses on resubmit too -- the path an agent takes after a rejection",
    async () => {
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-1",
        type: "request_board_approval",
        status: "revision_requested",
        payload: { kind: "deploy", projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
        companyId: COMPANY_ID,
        requestedByAgentId: "agent-1",
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/approvals/approval-1/resubmit")
        .send({ payload: deployBody({ commit: undefined }).payload });

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/does not say which commit to deploy/i);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "files an agent's card with a full commit id, and stamps that commit as what will deploy",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(stampedPayload().resolvedCommit).toBe(FULL_COMMIT);
      expect(stampedPayload().resolvedCommitSource).toBe("pinned");
    },
    TEST_TIMEOUT,
  );

  it(
    "still lets the board file a card with no commit id, and stamps the branch tip as what will deploy",
    async () => {
      // Deploying the top of the branch is a legitimate thing for a person to
      // ask for on purpose; the card then says which commit that is right now.
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: undefined }));

      expect(res.status).toBe(201);
      expect(stampedPayload().commit).toBeUndefined();
      expect(stampedPayload().resolvedCommit).toBe(BRANCH_TIP);
      expect(stampedPayload().resolvedCommitSource).toBe("branch_tip");
    },
    TEST_TIMEOUT,
  );

  it(
    "still lets the board file a shortened commit id (a person filing by hand)",
    async () => {
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: SHORT_COMMIT }));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "never trusts a 'what will deploy' stamp supplied by the filer",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ resolvedCommit: BRANCH_TIP, resolvedCommitSource: "branch_tip" }));

      expect(res.status).toBe(201);
      expect(stampedPayload().resolvedCommit).toBe(FULL_COMMIT);
      expect(stampedPayload().resolvedCommitSource).toBe("pinned");
    },
    TEST_TIMEOUT,
  );

  it(
    "falls back to the pinned commit when GitHub cannot be reached, and still files the card",
    async () => {
      mockGhFetch.mockRejectedValue(new Error("network down"));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(stampedPayload().resolvedCommit).toBe(FULL_COMMIT);
      expect(stampedPayload().resolvedCommitSource).toBe("pinned");
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps nothing, rather than guessing, when GitHub cannot say what the branch tip is",
    async () => {
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ commit: undefined }));

      expect(res.status).toBe(201);
      expect(stampedPayload().resolvedCommit).toBeUndefined();
      expect(stampedPayload().resolvedCommitSource).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps the pinned commit without asking GitHub when the workspace is not a github.com repo",
    async () => {
      const app = await createAgentApp(createRouteDb(null));

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(stampedPayload().resolvedCommit).toBe(FULL_COMMIT);
    },
    TEST_TIMEOUT,
  );
});
