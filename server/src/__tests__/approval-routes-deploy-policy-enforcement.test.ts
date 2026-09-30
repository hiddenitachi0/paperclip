/**
 * DUR-4139 (follow-up from the DUR-4136 security review): the deploy policy
 * UI stores `deployPolicy.mode` / `.askFirstActions`, but nothing on the
 * server enforced them before this. Verifies the `kind:"deploy"` filing (and
 * resubmit) route in routes/approvals.ts actually calls
 * deploy-policy-enforcement.ts and acts on its decision -- refusing a
 * preview_only project's live deploy request outright, and stamping the
 * project's ask-first list onto the card so the operator sees why it needs a
 * decision.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

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
const mockEvaluateDeployPolicyForProject = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, mode: "approval_every_time" as const, askFirstActions: [] as string[] })),
);
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
    const actual = await vi.importActual<typeof import("../services/deploy-workspace.js")>("../services/deploy-workspace.js");
    return { ...actual, resolveProjectDeployWorkspaceId: mockResolveProjectDeployWorkspaceId };
  });
  vi.doMock("../services/deploy-policy-enforcement.js", () => ({
    evaluateDeployPolicyForProject: mockEvaluateDeployPolicyForProject,
  }));
  vi.doMock("../services/github-fetch.js", () => ({
    ghFetch: mockGhFetch,
    gitHubApiBase: () => "https://api.github.com",
  }));
}

// Same fake reserved-connection trick as approval-routes-deploy-branch-stamp.test.ts:
// only the DUR-136 project-existence check and the ancestry guard's
// project_workspaces repoUrl lookup touch the db directly here.
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
      commit: "abc1234def5678901234567890abcdef12345678",
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

describe("DUR-4139: deploy approval filing enforces the project's deploy policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
    vi.doUnmock("../services/github-fetch.js");
    vi.doUnmock("../services/deploy-workspace.js");
    vi.doUnmock("../services/deploy-policy-enforcement.js");
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
      companyId: COMPANY_ID,
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
      projectId: PROJECT_ID,
    });
    mockResolveProjectDeployWorkspaceId.mockResolvedValue(null);
    mockEvaluateDeployPolicyForProject.mockResolvedValue({
      allowed: true,
      mode: "approval_every_time",
      askFirstActions: [],
    });
    mockGhFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ahead" }), { status: 200 }))
      .mockResolvedValueOnce(branchesWhereHeadResponse(["custom"]));
  });

  it(
    "refuses to file a live deploy request when the project's mode is preview_only",
    async () => {
      mockEvaluateDeployPolicyForProject.mockResolvedValue({
        allowed: false,
        refusalReason: "This project's deploy policy is set to preview only. Live deploys (Git or SFTP) are disabled.",
        mode: "preview_only",
        askFirstActions: [],
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/approvals`)
        .send(deployBody());

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/preview only/i);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "an agent cannot bypass preview_only by omitting the projectId check -- the refusal happens before any branch/commit work",
    async () => {
      mockEvaluateDeployPolicyForProject.mockResolvedValue({
        allowed: false,
        refusalReason: "This project's deploy policy is set to preview only.",
        mode: "preview_only",
        askFirstActions: [],
      });
      const app = await createAgentApp(createRouteDb());

      await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(mockResolveProjectDeployWorkspaceId).not.toHaveBeenCalled();
      expect(mockGhFetch).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "stamps the project's non-empty ask-first list onto a filed deploy card",
    async () => {
      mockEvaluateDeployPolicyForProject.mockResolvedValue({
        allowed: true,
        mode: "auto_after_review",
        askFirstActions: ["live_data_write", "costs_money"],
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.askFirstActions).toEqual(["live_data_write", "costs_money"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "leaves askFirstActions unset on the card when the project's list is empty",
    async () => {
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      const createdPayload = mockApprovalService.create.mock.calls[0][1].payload;
      expect(createdPayload.askFirstActions).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "still files a card under auto_after_review with no ask-first categories -- the human decision is not skipped",
    async () => {
      mockEvaluateDeployPolicyForProject.mockResolvedValue({
        allowed: true,
        mode: "auto_after_review",
        askFirstActions: [],
      });
      const app = await createAgentApp(createRouteDb());

      const res = await request(app).post(`/api/companies/${COMPANY_ID}/approvals`).send(deployBody());

      expect(res.status).toBe(201);
      expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
      expect(mockApprovalService.create.mock.calls[0][1].status).toBe("pending");
      // No approve() call anywhere -- filing never auto-decides a deploy card.
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );
});
