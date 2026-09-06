/**
 * DUR-284: deploy approval payload carries sourceBranch/deployBranch.
 *
 * DUR-226's UI reads `payload.sourceBranch`/`payload.deployBranch` off a deploy
 * approval to render a "Deploys from <branch>" badge and a mismatch warning, but
 * DUR-227 only ever used the deploy branch transiently inside its ancestry-guard
 * error path -- nothing wrote either field onto the persisted payload, so the
 * badge rendered nothing on every card. Verifies that filing (and resubmitting)
 * a `kind:"deploy"` approval stamps both fields from server-resolved data, never
 * from whatever the caller supplied.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

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
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/deploy-branches.js", () => ({
    resolveProjectDeployBranches: vi.fn(),
    resolveProjectDeployBranchesByProjectId: mockResolveProjectDeployBranchesByProjectId,
  }));
  vi.doMock("../services/github-fetch.js", () => ({
    ghFetch: mockGhFetch,
    gitHubApiBase: () => "https://api.github.com",
  }));
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

// approvals.ts's real (not service-mocked) db.select() calls run against the
// request-scoped db built by createRequestScopedDb(rawDb) -- that proxy
// always resolves through the real drizzle-orm query builder bound to
// whatever connection runInCompanyScope reserved (see
// middleware/company-scope.ts), so a fake `.select().from().where()` chain on
// the object passed to approvalRoutes(...) is never actually reached; only
// the shape of the *reserved connection* (rawDb.$client.reserve()) matters.
// This wraps withFakeCompanyScopeReserve's fake reserved connection but
// dispatches canned rows per table (DUR-136's `projects` existence check and
// assertDeployCommitIsAncestorOfDeployBranch's `project_workspaces` repoUrl
// lookup -- resolveProjectDeployBranchesByProjectId itself is mocked at the
// module level above, so it never touches the db) by matching a substring of
// the table name against the actual SQL text `client.unsafe()` receives.
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

async function createAgentApp(db: any) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      runId: "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "request_board_approval",
    payload: {
      kind: "deploy",
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      commit: "abc1234",
      title: "Deploy widgets",
      note: "Ship it",
      ...overrides,
    },
  };
}

function branchesWhereHeadResponse(names: string[]) {
  return new Response(JSON.stringify(names.map((name) => ({ name, commit: { sha: "abc1234" } }))), {
    status: 200,
  });
}

describe("DUR-284: deploy approval branch stamp", () => {
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
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
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
      companyId: "22222222-2222-4222-8222-222222222222",
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
      projectId: PROJECT_ID,
    });
  });

  it(
    "stamps sourceBranch/deployBranch when GitHub confirms the commit is the tip of the deploy branch",
    async () => {
      mockGhFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }))
        .mockResolvedValueOnce(branchesWhereHeadResponse(["custom"]));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post("/api/companies/22222222-2222-4222-8222-222222222222/approvals").send(deployBody());

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBe("custom");
      expect(createdPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps a mismatched sourceBranch when the commit is the tip of a different branch than the deploy branch",
    async () => {
      mockGhFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "identical" }), { status: 200 }))
        .mockResolvedValueOnce(branchesWhereHeadResponse(["feature/widgets"]));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post("/api/companies/22222222-2222-4222-8222-222222222222/approvals").send(deployBody());

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBe("feature/widgets");
      expect(createdPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps deployBranch only when GitHub can't pin down which branch the commit is the tip of",
    async () => {
      mockGhFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }))
        .mockResolvedValueOnce(branchesWhereHeadResponse([]));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post("/api/companies/22222222-2222-4222-8222-222222222222/approvals").send(deployBody());

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBeUndefined();
      expect(createdPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps deployBranch only, with no GitHub call, when the payload pins no commit",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
        .send(deployBody({ commit: undefined }));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBeUndefined();
      expect(createdPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );

  it(
    "leaves both fields unset when the project declares no deploy branch",
    async () => {
      mockResolveProjectDeployBranchesByProjectId.mockResolvedValue(null);
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post("/api/companies/22222222-2222-4222-8222-222222222222/approvals").send(deployBody());

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBeUndefined();
      expect(createdPayload.deployBranch).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "never trusts a caller-supplied sourceBranch/deployBranch -- always overwrites with the server-resolved value",
    async () => {
      mockGhFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }))
        .mockResolvedValueOnce(branchesWhereHeadResponse(["custom"]));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
        .send(deployBody({ sourceBranch: "master", deployBranch: "master" }));

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.sourceBranch).toBe("custom");
      expect(createdPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps branches on resubmit too",
    async () => {
      mockGhFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }))
        .mockResolvedValueOnce(branchesWhereHeadResponse(["custom"]));
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-1",
        type: "request_board_approval",
        status: "revision_requested",
        payload: { kind: "deploy", projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
        companyId: "22222222-2222-4222-8222-222222222222",
        requestedByAgentId: "agent-1",
      });
      mockApprovalService.resubmit.mockResolvedValue({
        id: "approval-1",
        type: "request_board_approval",
        status: "pending",
        payload: {},
        companyId: "22222222-2222-4222-8222-222222222222",
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/approvals/approval-1/resubmit")
        .send({ payload: deployBody().payload });

      expect(res.status).toBe(200);
      const resubmittedPayload = mockApprovalService.resubmit.mock.calls[0][1];
      expect(resubmittedPayload.sourceBranch).toBe("custom");
      expect(resubmittedPayload.deployBranch).toBe("custom");
    },
    TEST_TIMEOUT,
  );
});
