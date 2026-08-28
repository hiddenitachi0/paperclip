/**
 * DUR-146 Stage 1: filing a `request_board_approval` approval with
 * payload.kind "deploy" or "merge_pr" requires the deploys:request /
 * merges:request permission grant respectively — company_scope:read alone
 * is not enough. Approving is untouched (still assertBoard-only regardless
 * of any grant); this only covers who may ASK.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;
const companyId = "33333333-3333-4333-8333-333333333333";

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
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

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
}

function createRouteDb() {
  return withFakeCompanyScopeReserve({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(
              getTableName(table as any) === getTableName(projects)
                ? [{ id: "11111111-1111-4111-8111-111111111111", companyId }]
                : [],
            ),
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any);
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
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId,
  source: "agent_jwt",
};

describe("approval-request permission gate (DUR-146)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: unknown, payload: unknown) => payload,
    );
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.create.mockResolvedValue({
      id: "new-approval-1",
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    mockApprovalService.listComments.mockResolvedValue([]);
  });

  it("refuses a merge_pr request with 403 when the actor lacks merges:request", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "company_scope:read",
      action,
      reason: action === "company_scope:read" ? "allow_test" : "deny_missing_grant",
      explanation: "test",
    }));

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { kind: "merge_pr", repo: "org/repo", prNumber: 42, title: "Merge PR #42" },
      });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a deploy request with 403 when the actor lacks deploys:request", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "company_scope:read",
      action,
      reason: action === "company_scope:read" ? "allow_test" : "deny_missing_grant",
      explanation: "test",
    }));

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        payload: {
          kind: "deploy",
          projectId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          title: "Deploy to prod",
          note: "Deploying the latest build.",
        },
      });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("allows a merge_pr request through when the actor holds merges:request", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "merges:request",
      reason: "allow_test",
      explanation: "test",
    });

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { kind: "merge_pr", repo: "org/repo", prNumber: 42, title: "Merge PR #42" },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  }, TEST_TIMEOUT);

  it("dryRun still refuses with 403 when the actor lacks deploys:request, and does not create anything", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "company_scope:read",
      action,
      reason: action === "company_scope:read" ? "allow_test" : "deny_missing_grant",
      explanation: "test",
    }));

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        dryRun: true,
        payload: {
          kind: "deploy",
          projectId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          title: "Deploy to prod",
          note: "Deploying the latest build.",
        },
      });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("dryRun returns 200 without creating a live approval when the actor holds merges:request (DUR-162)", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "merges:request",
      reason: "allow_test",
      explanation: "test",
    });

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        dryRun: true,
        payload: { kind: "merge_pr", repo: "org/repo", prNumber: 42, title: "Merge PR #42" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dryRun: true, wouldSucceed: true });
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("does not gate a hire_agent request on deploys:request/merges:request", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "company_scope:read",
      action,
      reason: action === "company_scope:read" ? "allow_test" : "deny_missing_grant",
      explanation: "test",
    }));

    const res = await request(await createApp(agentActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "hire_agent",
        payload: { role: "designer", title: "Hire designer" },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  }, TEST_TIMEOUT);
});
