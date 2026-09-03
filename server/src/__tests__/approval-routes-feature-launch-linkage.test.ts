/**
 * DUR-313 follow-up: a `feature_launch` approval must be linked (issueIds) to EXACTLY the
 * one issue named in payload.issueId, not merely include it. `linkManyForApproval` links the
 * approval to every id in issueIds, and evaluateFeatureLaunchDoneGate treats any approved
 * feature_launch approval linked to an issue as covering that issue -- it never cross-checks
 * payload.issueId. A loose `.includes()` check would let a filer pad issueIds with an extra
 * issue (issueIds: [X, Y], payload.issueId: X) and get Y silently approved as a launch riding
 * on a card the operator only ever reviewed for X.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issues } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";

const TEST_TIMEOUT = 20_000;

// DUR-347: POST /api/approvals runs through company-scope middleware, which
// reserves a real connection via runInCompanyScope -- this test's
// hand-rolled db stub isn't a real Db, so it can't back that reservation.
// Bypass the reservation machinery in tests, running the callback directly,
// no real connection involved -- same pattern used elsewhere pre-DUR-381.
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
  findOpenFeatureLaunchApproval: vi.fn(),
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

const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const LAUNCH_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(
              getTableName(table as any) === getTableName(issues)
                ? [{ id: LAUNCH_ISSUE_ID, companyId: COMPANY_ID }]
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
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function launchPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "feature_launch",
    issueId: LAUNCH_ISSUE_ID,
    whatIsNew: "Agents can now attach files to a comment.",
    whereToFindIt: "Issue detail page, comment composer.",
    whatToTest: "Attach a PDF and confirm it renders inline.",
    whatIfItFails: "Ping Backend Engineer, revert PR #213.",
    title: "Launch: comment attachments",
    ...overrides,
  };
}

describe("feature_launch approval linkage guard (DUR-313 follow-up)", () => {
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
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.findOpenFeatureLaunchApproval.mockResolvedValue(null);
    mockApprovalService.create.mockResolvedValue({
      id: "new-approval-1",
      companyId: COMPANY_ID,
      type: "request_board_approval",
      status: "pending",
      payload: launchPayload(),
    });
    mockApprovalService.listComments.mockResolvedValue([]);
  });

  it("rejects a feature_launch approval whose issueIds pad in an extra issue beyond payload.issueId", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send({
        type: "request_board_approval",
        payload: launchPayload(),
        issueIds: [LAUNCH_ISSUE_ID, OTHER_ISSUE_ID],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("exactly the one issue");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("rejects a feature_launch approval not linked to payload.issueId at all", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send({
        type: "request_board_approval",
        payload: launchPayload(),
        issueIds: [OTHER_ISSUE_ID],
      });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("allows a feature_launch approval linked to exactly payload.issueId", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send({
        type: "request_board_approval",
        payload: launchPayload(),
        issueIds: [LAUNCH_ISSUE_ID],
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  }, TEST_TIMEOUT);
});
