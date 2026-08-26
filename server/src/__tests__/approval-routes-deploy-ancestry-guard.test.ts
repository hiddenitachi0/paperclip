/**
 * DUR-227: deploy approval ancestry guard.
 *
 * DUR-221 near-miss: a deploy approval was filed for a commit that lived on
 * `master` while the project's declared deploy branch was `custom` -- nothing
 * checked the commit was even reachable from the deploy branch before it
 * reached the operator's queue. Verifies that:
 * - Filing (or resubmitting) a `kind:"deploy"` approval whose pinned
 *   `payload.commit` GitHub confirms is NOT an ancestor of the project's
 *   declared deploy branch is refused with 422, naming both branches.
 * - Filing is allowed when GitHub confirms the commit IS an ancestor.
 * - The guard fails OPEN (allows filing) whenever ancestry can't be
 *   determined at all: no pinned commit, no declared deploy branch, the
 *   workspace isn't a github.com repo, or GitHub is unreachable.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects, projectWorkspaces } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";

const TEST_TIMEOUT = 20_000;

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

// resolveProjectDeployBranchesByProjectId is mocked directly (like the DUR-40
// mirror-branch guard test mocks resolveProjectDeployBranches) so the guard's
// deploy-branch lookup doesn't need a real DB.
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

function createRouteDb(workspaceRepoUrl: string | null | undefined = "https://github.com/acme/widgets") {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => {
            if (getTableName(table as any) === getTableName(projects)) {
              return resolve([{ id: PROJECT_ID, companyId: "company-1" }]);
            }
            if (getTableName(table as any) === getTableName(projectWorkspaces)) {
              return resolve(workspaceRepoUrl === undefined ? [] : [{ repoUrl: workspaceRepoUrl }]);
            }
            return resolve([]);
          },
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
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
      companyId: "company-1",
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

function deployBody(commit?: string) {
  return {
    type: "request_board_approval",
    payload: {
      kind: "deploy",
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      ...(commit ? { commit } : {}),
      title: "Deploy widgets",
      note: "Ship it",
    },
  };
}

describe("DUR-227: deploy approval ancestry guard", () => {
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
      companyId: "company-1",
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
      projectId: PROJECT_ID,
    });
  });

  it(
    "refuses a deploy approval whose commit GitHub confirms is not an ancestor of the deploy branch",
    async () => {
      mockGhFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: "diverged" }), { status: 200 }),
      );
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody("d55e5704"));

      expect(res.status).toBe(422);
      const message = res.body.message ?? res.body.error ?? "";
      expect(message).toMatch(/d55e5704/);
      expect(message).toMatch(/custom/);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses on resubmit too, when GitHub confirms the new commit is behind the deploy branch",
    async () => {
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ status: "behind" }), { status: 200 }));
      mockApprovalService.getById.mockResolvedValue({
        id: "approval-1",
        type: "request_board_approval",
        status: "revision_requested",
        payload: { kind: "deploy", projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
        companyId: "company-1",
        requestedByAgentId: "agent-1",
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/approvals/approval-1/resubmit")
        .send({ payload: deployBody("d55e5704").payload });

      expect(res.status).toBe(422);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "allows a deploy approval whose commit GitHub confirms IS an ancestor of the deploy branch",
    async () => {
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody("abc1234"));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "is a no-op when the payload pins no commit (deploys current branch tip)",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody());

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "is a no-op (fails open) when the project declares no deploy branch",
    async () => {
      mockResolveProjectDeployBranchesByProjectId.mockResolvedValue(null);
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody("d55e5704"));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when the workspace has no github.com repoUrl to check against",
    async () => {
      const app = await createAgentApp(createRouteDb(null));

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody("d55e5704"));

      expect(res.status).toBe(201);
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "fails open when GitHub is unreachable",
    async () => {
      mockGhFetch.mockRejectedValue(new Error("network down"));
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post("/api/companies/company-1/approvals")
        .send(deployBody("d55e5704"));

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );
});
