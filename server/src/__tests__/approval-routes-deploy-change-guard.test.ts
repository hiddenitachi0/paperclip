/**
 * Pointless deploy cards: deploy cards that cannot deploy, or would deploy nothing, are
 * refused at filing time.
 *
 * The incident: one agent filed six deploy cards in a row the operator had to
 * reject by hand -- a mistyped commit id, commits already live, a commit whose
 * only difference from the live one was documentation, and commits from a
 * rewritten history the deploy runner refuses anyway. Verifies each of those
 * four refusals, that the refusal names the version live now, that the board is
 * not blocked by the documentation-only one, that a board rollback still gets
 * through, and that the check fails OPEN whenever it cannot get an answer.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const LIVE_COMMIT = "aaaaaaaaaaaa";
const NEW_COMMIT = "bbbbbbbbbbbb";

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
  // Only the "which version is live" lookup is mocked -- the path rules and the
  // wording of every refusal stay real, so the messages these tests assert on
  // are the ones an agent actually reads.
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

// Same shape as the DUR-284 branch-stamp suite: approvals.ts's own db.select()
// calls run through the request-scoped proxy, so only the reserved connection's
// answers matter. Dispatches per table by matching the SQL text.
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
      commit: NEW_COMMIT,
      title: "Deploy widgets",
      note: "Ship it",
      ...overrides,
    },
  };
}

/**
 * Answers every GitHub call the filing path makes: the DUR-227 ancestry compare
 * (commit...deployBranch -- always "ahead" here, so that older guard never
 * fires and these tests only exercise the pointless-deploy-card guard), the branch-stamp lookup, this
 * guard's commit-exists check, and this guard's live...requested compare, whose
 * answer each test supplies.
 */
function githubAnswers(
  compare: Record<string, unknown>,
  options: { commitExists?: boolean; repoVisible?: boolean } = {},
) {
  mockGhFetch.mockImplementation(async (url: string) => {
    if (url.includes(`/compare/${LIVE_COMMIT}`)) return new Response(JSON.stringify(compare), { status: 200 });
    if (url.includes("/compare/")) return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
    if (url.includes("/branches-where-head")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/commits/")) {
      return options.commitExists === false
        ? new Response(JSON.stringify({ message: "No commit found for SHA" }), { status: 422 })
        : new Response(JSON.stringify({ sha: NEW_COMMIT }), { status: 200 });
    }
    // The repository itself: /repos/<owner>/<name> with nothing after it. This
    // is what tells a missing commit apart from a repository GitHub will not
    // show us at all.
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return options.repoVisible === false
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify({ full_name: "acme/widgets", private: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

/** Did anything ask GitHub about this repository, in any way? */
const githubUrlsCalled = () => mockGhFetch.mock.calls.map((call) => String(call[0]));

function messageOf(res: { body: any }) {
  return res.body.message ?? res.body.error ?? "";
}

describe("Pointless deploy cards: deploy cards that would deploy nothing are refused at filing time", () => {
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
    mockResolveLiveDeployCommit.mockResolvedValue(LIVE_COMMIT);
  });

  it(
    "(a) refuses a commit that does not exist in the repository, and says which version is live",
    async () => {
      githubAnswers({ status: "ahead", files: [] }, { commitExists: false });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/no commit bbbbbbbbbbbb/i);
      expect(messageOf(res)).toMatch(/acme\/widgets/);
      expect(messageOf(res)).toMatch(/aaaaaaaaaaaa/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
      // It only says that after checking the repository is really there.
      expect(githubUrlsCalled()).toContain("https://api.github.com/repos/acme/widgets");
    },
    TEST_TIMEOUT,
  );

  it(
    "(a) files the card instead when GitHub will not show us the repository at all (no key saved, or a key without access)",
    async () => {
      // A private repository answers 404 to a caller it does not know, exactly
      // like a commit that is not there. Concluding "no such commit" from that
      // would refuse every deploy card this company files, for a wrong reason.
      mockSecretService.resolveGitHubToken.mockResolvedValue(null);
      githubAnswers({ status: "ahead", files: [] }, { commitExists: false, repoVisible: false });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "(b) refuses a commit that is already part of what is live",
    async () => {
      githubAnswers({ status: "behind", files: [] });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/already running/i);
      expect(messageOf(res)).toMatch(/aaaaaaaaaaaa/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "(b) refuses a commit that is exactly what is live, in its own words",
    async () => {
      githubAnswers({ status: "identical", files: [] });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/exactly what is running now/i);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "(c) refuses a commit the live version is not part of, and says to bring the live version back in first",
    async () => {
      githubAnswers({ status: "diverged", files: [] });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/not built on top of what is running now/i);
      expect(messageOf(res)).toMatch(/aaaaaaaaaaaa/);
      expect(messageOf(res)).toMatch(/custom/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "(b) does NOT block the board from re-deploying what is already live (the only way to restart production)",
    async () => {
      githubAnswers({ status: "identical", files: [] });
      const app = await createBoardApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toMatchObject({ liveCommit: LIVE_COMMIT, changedFileCount: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    "(c) does NOT block the board from deploying a commit the live version is not part of (a deliberate rollback)",
    async () => {
      githubAnswers({ status: "diverged", files: [] });
      const app = await createBoardApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "(d) refuses an agent's card when only written notes changed since the live version",
    async () => {
      githubAnswers({
        status: "ahead",
        files: [{ filename: "PROJECT_STATUS.md" }, { filename: "docs/runbook.md" }, { filename: "docs/img/box.png" }],
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/Nothing would change/i);
      expect(messageOf(res)).toMatch(/PROJECT_STATUS\.md/);
      expect(messageOf(res)).toMatch(/aaaaaaaaaaaa/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "(d) does NOT block the board from filing a documentation-only deploy",
    async () => {
      githubAnswers({ status: "ahead", files: [{ filename: "README.md" }] });
      const app = await createBoardApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toEqual({
        liveCommit: LIVE_COMMIT,
        changedFileCount: 1,
        changedFiles: ["README.md"],
        documentationOnly: true,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps the live version and what changes onto a card that really ships work",
    async () => {
      githubAnswers({
        status: "ahead",
        files: [{ filename: "server/src/routes/approvals.ts" }, { filename: "docs/notes.md" }],
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toEqual({
        liveCommit: LIVE_COMMIT,
        changedFileCount: 2,
        changedFiles: ["server/src/routes/approvals.ts", "docs/notes.md"],
        documentationOnly: false,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "never trusts a change summary supplied by the filer",
    async () => {
      githubAnswers({ status: "ahead", files: [{ filename: "server/src/app.ts" }] });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(
          deployBody({
            changesSinceLive: {
              liveCommit: "ffffffffffff",
              changedFileCount: 99,
              changedFiles: ["made/up.ts"],
              documentationOnly: false,
            },
          }),
        );

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive.liveCommit).toBe(LIVE_COMMIT);
      expect(stamped.changesSinceLive.changedFiles).toEqual(["server/src/app.ts"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "lets a board rollback through even though its commit is already live",
    async () => {
      githubAnswers({ status: "behind", files: [] });
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ allowBackwardDeploy: true }));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "files a board rollback even when GitHub cannot be reached at all",
    async () => {
      // A rollback is the operator's emergency lever: the commit comes from the
      // deploy runner's own record of what used to be live, not from GitHub, so
      // a GitHub outage must never be the reason it cannot be asked for.
      mockGhFetch.mockRejectedValue(new Error("network down"));
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ allowBackwardDeploy: true }));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
      expect(mockApprovalService.create.mock.calls[0]?.[1]?.payload?.allowBackwardDeploy).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "files a board rollback even when GitHub says it has never heard of the commit",
    async () => {
      // The commit that used to be live can be gone from GitHub -- a squashed
      // branch, a force-push, a deleted fork. The deploy runner can still put it
      // back, so this guard must not stand in the way.
      githubAnswers({ status: "behind", files: [] }, { commitExists: false });
      const app = await createBoardApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody({ allowBackwardDeploy: true }));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps at most a handful of changed files, however big the deploy",
    async () => {
      githubAnswers({
        status: "ahead",
        files: Array.from({ length: 300 }, (_, i) => ({
          filename: `server/src/${"deeply-nested-folder/".repeat(15)}file${i}.ts`,
        })),
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive.changedFileCount).toBe(300);
      expect(stamped.changesSinceLive.changedFiles).toHaveLength(12);
      for (const path of stamped.changesSinceLive.changedFiles) expect(path.length).toBeLessThanOrEqual(160);
      expect(JSON.stringify(stamped.changesSinceLive).length).toBeLessThan(2500);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses on resubmit too -- the path an agent takes after a rejection",
    async () => {
      githubAnswers({ status: "behind", files: [] });
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
        .send({ payload: deployBody().payload });

      expect(res.status).toBe(422);
      expect(messageOf(res)).toMatch(/already running/i);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when no version is known to be live yet (nothing has ever deployed)",
    async () => {
      mockResolveLiveDeployCommit.mockResolvedValue(null);
      githubAnswers({ status: "identical", files: [] });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const stamped = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
      expect(stamped.changesSinceLive).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when GitHub is unreachable",
    async () => {
      mockGhFetch.mockRejectedValue(new Error("network down"));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when the workspace is not a github.com repo",
    async () => {
      const app = await createAgentApp(createRouteDb(null));

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when the compare answer is not in the shape we expect",
    async () => {
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url.includes("/compare/")) return new Response("not json", { status: 200 });
        return new Response(JSON.stringify({ sha: NEW_COMMIT }), { status: 200 });
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "does not call GitHub at all when the card pins no commit",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody({ commit: undefined }));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );
});
