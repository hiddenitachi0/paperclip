/**
 * DUR-40: merge_pr approval branch guard.
 *
 * Verifies that:
 * - Filing a merge_pr approval whose `base` matches the project's declared
 *   `mirrorBranch` is refused with 422 and a message naming the correct branch.
 * - Filing against the deployable branch is allowed and its plainSummary gains
 *   a consequence sentence.
 * - The guard is a no-op when the project declares no deploy/mirror branches.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// `vi.resetModules()` in beforeEach re-transforms the large approvals.ts
// dependency graph on every test; the first test to hit that cold-start
// cost can exceed the default 5s budget.
vi.setConfig({ testTimeout: 20_000 });

// --- service mocks ---

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

// Mock resolveProjectDeployBranches directly so the guard logic doesn't need
// a real DB — avoids the module-identity issue where vi.resetModules() makes
// the `issues`/`projects` table objects in the test differ from those in the
// freshly-imported route module.
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

// approvals.ts's real (not service-mocked) db.select() calls -- here just
// assertApprovalMutationAllowedByRunContext's heartbeat_runs run-context
// lookup, since resolveProjectDeployBranches is fully mocked above -- run
// against the request-scoped db built by createRequestScopedDb(rawDb). That
// proxy always resolves through the real drizzle-orm query builder bound to
// whatever connection runInCompanyScope reserved (see
// middleware/company-scope.ts), so a fake `.select().from().where()` chain on
// the object passed to approvalRoutes(...) is never actually reached; only
// the shape of the *reserved connection* (rawDb.$client.reserve()) matters.
// withFakeCompanyScopeReserve's default empty `unsafeRows` makes every real
// select (including the heartbeat_runs lookup) resolve to no rows, so
// assertApprovalMutationAllowedByRunContext finds no run and returns true,
// letting the route continue -- exactly what createMinimalDb's dead fake
// chain used to simulate before company-scope wiring made it unreachable.
function createMinimalDb() {
  return withFakeCompanyScopeReserve({});
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
      companyId: "22222222-2222-4222-8222-222222222222",
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

function mergePrBody(base: string, plainSummary = "Ships the feature.") {
  return {
    type: "request_board_approval",
    issueIds: [ISSUE_ID],
    payload: {
      kind: "merge_pr",
      base,
      pr: "https://github.com/example/repo/pull/1",
      plainSummary,
    },
  };
}

describe("DUR-40: merge_pr mirror-branch guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
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
    // DUR-101 dedup guard: default to "no open duplicate" so this
    // pre-existing DUR-40 branch-guard suite isn't affected by the new check.
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
  });

  it("refuses a merge_pr approval whose base is the declared mirror branch", async () => {
    mockResolveProjectDeployBranches.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
    });
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send(mergePrBody("master"));

    expect(res.status).toBe(422);
    expect(res.body.message ?? res.body.error ?? "").toMatch(/mirror/i);
    expect(res.body.message ?? res.body.error ?? "").toMatch(/custom/);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("allows a merge_pr approval targeting the deploy branch (no guard fires)", async () => {
    mockResolveProjectDeployBranches.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
    });
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send(mergePrBody("custom"));

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("appends a consequence sentence to plainSummary when base is the deploy branch", async () => {
    mockResolveProjectDeployBranches.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
    });
    const app = await createAgentApp();

    await request(app)
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send(mergePrBody("custom", "Ships the login page."));

    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(typeof savedPayload.plainSummary).toBe("string");
    expect(savedPayload.plainSummary as string).toContain("custom");
    expect(savedPayload.plainSummary as string).toMatch(/deploy/i);
  });

  it("is a no-op when the project declares no deploy or mirror branches", async () => {
    mockResolveProjectDeployBranches.mockResolvedValue(null);
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send(mergePrBody("master"));

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });
});
