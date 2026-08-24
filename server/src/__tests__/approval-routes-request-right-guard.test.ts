/**
 * DUR-65 / DUR-146: filing a deploy or merge_pr *request* approval requires
 * the matching "ask" right (deploys:request / merges:request). Deciding an
 * approval is untouched -- assertBoard still gates approve/reject
 * unconditionally, regardless of this grant. See
 * server/src/routes/approvals.ts: assertApprovalRequestRightAllowed.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn());

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
    resolveProjectDeployBranches: mockResolveProjectDeployBranches,
  }));
}

// The generic select chain resolves a project row matching PROJECT_ID/"company-1"
// so assertDeployRequestProjectExists (unrelated to this guard) doesn't 422 the
// deploy-body tests; the run-context check in assertApprovalMutationAllowedByRunContext
// still short-circuits to "allowed" because the resolved row's agentId never
// matches the test actor's agentId.
function createMinimalDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve([{ id: PROJECT_ID, companyId: "company-1" }]),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp() {
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
  app.use("/api", approvalRoutes(createMinimalDb()));
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

function deployBody() {
  return {
    type: "request_board_approval",
    issueIds: [ISSUE_ID],
    payload: {
      kind: "deploy",
      title: "Deploy the thing",
      note: "Ships the fix.",
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
    },
  };
}

function mergePrBody(base = "custom") {
  return {
    type: "request_board_approval",
    issueIds: [ISSUE_ID],
    payload: {
      kind: "merge_pr",
      base,
      pr: "https://github.com/example/repo/pull/1",
      plainSummary: "Ships the feature.",
    },
  };
}

/** Grants exactly the given set of permission keys, refusing everything else. */
function decideOnlyFor(...allowedActions: string[]) {
  mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => {
    const allowed = allowedActions.includes(action);
    return {
      allowed,
      action,
      reason: allowed ? "allow_test" : "no_grant",
      explanation: allowed ? "Allowed by test mock." : "Refused by test mock.",
    };
  });
}

describe("DUR-65/DUR-146: deploys:request / merges:request approval-filing guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockResolveProjectDeployBranches.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: null,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: ISSUE_ID }]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
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
    mockAgentService.getById.mockResolvedValue({
      id: "target-agent",
      companyId: "company-1",
    });
  });

  it("refuses a deploy request from an actor without deploys:request", async () => {
    decideOnlyFor("company_scope:read");
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send(deployBody());

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("allows a deploy request from an actor holding deploys:request", async () => {
    decideOnlyFor("company_scope:read", "deploys:request");
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send(deployBody());

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("refuses a merge_pr request from an actor without merges:request", async () => {
    decideOnlyFor("company_scope:read");
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send(mergePrBody());

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("allows a merge_pr request from an actor holding merges:request", async () => {
    decideOnlyFor("company_scope:read", "merges:request");
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send(mergePrBody());

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("does not gate approval kinds other than deploy/merge_pr on the new rights", async () => {
    decideOnlyFor("company_scope:read");
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "model_boost", agentId: "target-agent", issueId: ISSUE_ID, reason: "stuck" },
      });

    expect(res.status).not.toBe(403);
  });
});
