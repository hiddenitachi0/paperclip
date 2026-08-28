/**
 * DUR-101: Duplicate-approval guard
 *
 * Verifies that filing a second pending approval for the same hire role,
 * PR, or deploy target is refused with 409, and that passing
 * acknowledgedDuplicateOfApprovalId allows a legitimate second approval
 * through while linking it to the earlier record.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// vi.resetModules() + dynamic imports take ~7s in this test environment.
const TEST_TIMEOUT = 20_000;

const TEST_COMPANY_ID = "66666666-6666-4666-8666-666666666666";

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
  return {
    select: vi.fn(() => ({
      // DUR-136: the deploy-approval route now checks payload.projectId
      // resolves to a real project before filing/resubmitting -- match
      // it here for the `projects` table so the pre-existing 409
      // duplicate-guard test (which files a deploy payload) still
      // reaches that check instead of failing earlier on a fake id.
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(
              getTableName(table as any) === getTableName(projects)
                ? [{ id: "11111111-1111-4111-8111-111111111111", companyId: TEST_COMPANY_ID }]
                : [],
            ),
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
}

function createScopedRouteDb() {
  return withFakeCompanyScopeReserve(createRouteDb());
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [TEST_COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createScopedRouteDb()));
  app.use(errorHandler);
  return app;
}

describe("approval routes duplicate guard (DUR-101)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
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
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: unknown, payload: unknown) => payload,
    );

    // Default: no duplicates found
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.create.mockResolvedValue({
      id: "new-approval-1",
      companyId: TEST_COMPANY_ID,
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.listComments.mockResolvedValue([]);
  });

  it("refuses a second hire approval for the same role with 409", async () => {
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue({
      id: "existing-hire-1",
      status: "pending",
    });

    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
      .send({
        type: "hire_agent",
        payload: { role: "engineer", title: "Hire engineer" },
      });

    expect(res.status).toBe(409);
    expect(res.body.details?.existingApprovalId).toBe("existing-hire-1");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("allows a hire approval when no open approval for that role exists", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
      .send({
        type: "hire_agent",
        payload: { role: "designer", title: "Hire designer" },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  }, TEST_TIMEOUT);

  it("refuses a second merge_pr approval for the same PR with 409", async () => {
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue({
      id: "existing-merge-1",
      status: "pending",
    });

    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { kind: "merge_pr", repo: "org/repo", prNumber: 42, title: "Merge PR #42" },
      });

    expect(res.status).toBe(409);
    expect(res.body.details?.existingApprovalId).toBe("existing-merge-1");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a second deploy approval for the same project/workspace with 409", async () => {
    mockApprovalService.findOpenDeployApproval.mockResolvedValue({
      id: "existing-deploy-1",
      status: "pending",
    });

    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
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

    expect(res.status).toBe(409);
    expect(res.body.details?.existingApprovalId).toBe("existing-deploy-1");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("allows a legitimate second deploy approval when acknowledgedDuplicateOfApprovalId matches (DUR-138)", async () => {
    // DUR-138: deployRequestPayloadSchema is .strict(), so before the fix this
    // 400'd on "Unrecognized key(s): acknowledgedDuplicateOfApprovalId" before
    // the duplicate-guard logic below ever ran -- the escape hatch was dead
    // code for this kind specifically.
    mockApprovalService.findOpenDeployApproval.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      status: "pending",
    });
    mockApprovalService.create.mockResolvedValue({
      id: "new-deploy-1",
      companyId: TEST_COMPANY_ID,
      type: "request_board_approval",
      status: "pending",
      payload: { kind: "deploy" },
    });

    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
      .send({
        type: "request_board_approval",
        payload: {
          kind: "deploy",
          projectId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          title: "Deploy corrected commit to prod",
          note: "The existing open approval targets a now-stale commit.",
          acknowledgedDuplicateOfApprovalId: "44444444-4444-4444-8444-444444444444",
        },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    expect(createCall[1].payload.relatedApprovalId).toBe("44444444-4444-4444-8444-444444444444");
  }, TEST_TIMEOUT);

  it("allows a legitimate second hire approval when acknowledgedDuplicateOfApprovalId matches", async () => {
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue({
      id: "existing-hire-1",
      status: "pending",
    });

    const res = await request(await createApp())
      .post(`/api/companies/${TEST_COMPANY_ID}/approvals`)
      .send({
        type: "hire_agent",
        payload: {
          role: "engineer",
          title: "Hire second engineer",
          acknowledgedDuplicateOfApprovalId: "existing-hire-1",
        },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    expect(createCall[1].payload.relatedApprovalId).toBe("existing-hire-1");
  }, TEST_TIMEOUT);
});
