/**
 * DUR-923 follow-up to DUR-252's security review of PR #169 (DUR-238): `originalIssueIds`
 * anchors which issue(s) a merge_pr approval was filed for, but never proved the filer had any
 * real connection to that issue's work -- only the company-level `merges:request` permission
 * gated who could file at all. Once DUR-238 merges, an approved+deployed merge_pr approval
 * naming issue X auto-closes X with zero action from X's actual assignee, so an unconstrained
 * `issueIds` lets a filer with `merges:request` (but no relationship to issue X) force a bogus
 * auto-close.
 *
 * assertMergePrIssueIdsAreRelevant (server/src/routes/approvals.ts) closes this: an agent filer
 * may only name an issue it is the assignee of, that has no assignee, or whose assignee is one
 * of its own reports (via the same isAgentInSubtree reportsTo walk `decide()` already uses for
 * "allow_manager_chain"). A board/user actor is left unconstrained -- they're the trust anchor
 * DUR-238's auto-close ultimately defers to via mandatory human approval of the merge_pr request
 * itself. Verifies both the create and resubmit paths.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

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
const mockIsAgentInSubtree = vi.hoisted(() => vi.fn(async () => false));

// No deploy/mirror branch declared for this project -- keeps the DUR-40 guard a no-op so this
// suite only exercises the issueIds-relevance guard.
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn(async () => null));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => ({ readFile: vi.fn(), writeFile: vi.fn() }),
    agentService: () => mockAgentService,
    approvalService: () => mockApprovalService,
    escalationGrantService: () => mockEscalationGrantService,
    heartbeatService: () => mockHeartbeatService,
    isAgentInSubtree: mockIsAgentInSubtree,
    issueApprovalService: () => mockIssueApprovalService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/deploy-branches.js", () => ({
    resolveProjectDeployBranches: mockResolveProjectDeployBranches,
  }));
}

// DUR-923's guard runs against the company-scoped `db` (createRequestScopedDb(rawDb) resolved
// through runInCompanyScope's AsyncLocalStorage -- see middleware/company-scope.ts), which is a
// REAL drizzle instance layered over the fake reserved connection `withFakeCompanyScopeReserve`
// provides, not a select()/from()/where() mock chain (that chain is only exercised by code that
// calls the raw, unwrapped db directly -- nothing reached by these tests does). The scoped
// queries are real `db.select({...}).from(...).where(...)` calls that execute via the reserved
// connection's `client.unsafe(query, params).values()`, which `unsafeRows` backs with one static
// positional-tuple row shared by every query the request issues.
//
// Two real queries can run per request here: this guard's own `{id, companyId,
// assigneeAgentId}` issues select, and (since `req.actor.runId` is set)
// assertApprovalMutationAllowedByRunContext's `{id, companyId, agentId, contextSnapshot}`
// heartbeatRuns select. The same 3-value tuple satisfies both -- the heartbeatRuns read's
// missing 4th column (contextSnapshot) resolves to `undefined`, which
// isStatusOnlyCheapRecoveryContext treats as "not a cheap-recovery run" regardless of the other
// three columns, so that guard is always a no-op here either way.
function createDb(issueRow: { id: string; companyId: string; assigneeAgentId: string | null } | null) {
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  };
  return withFakeCompanyScopeReserve(fakeDb as any, {
    unsafeRows: issueRow ? [[issueRow.id, issueRow.companyId, issueRow.assigneeAgentId]] : [],
  });
}

async function createApp(actorOverrides: Record<string, unknown>, db: unknown) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { companyId: "c1111111-1111-4111-8111-111111111111", runId: "run-1", isInstanceAdmin: false, ...actorOverrides };
    next();
  });
  app.use("/api", approvalRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp(db: unknown, agentId = "agent-1") {
  return createApp({ type: "agent", agentId, source: "api_key" }, db);
}

// A board actor filing on behalf of a human -- getActorInfo normalizes this to actorType
// "user". `source: "local_implicit"` mirrors the default local_trusted deployment's board
// actor shape and skips assertCompanyAccess's separate membership/company-allowlist checks,
// which are irrelevant to what this suite is verifying.
async function createUserApp(db: unknown) {
  return createApp(
    { type: "board", userId: "user-1", userName: "Board User", userEmail: null, source: "local_implicit" },
    db,
  );
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

describe("DUR-923: merge_pr issueIds ownership/relevance guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/deploy-branches.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockResolveProjectDeployBranches.mockResolvedValue(null);
    mockIsAgentInSubtree.mockResolvedValue(false);

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
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      companyId: "c1111111-1111-4111-8111-111111111111",
    });
  });

  it("allows an agent to name an issue it is the assignee of", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "agent-1" });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("allows an agent to name an issue with no assignee", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: null });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("allows an agent to name an issue assigned to a report it manages", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "report-1" });
    mockIsAgentInSubtree.mockResolvedValue(true);
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
    expect(mockIsAgentInSubtree).toHaveBeenCalledWith(expect.anything(), "c1111111-1111-4111-8111-111111111111", "agent-1", "report-1");
  });

  it("rejects an agent naming an issue assigned to an unrelated agent it does not manage", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "stranger-1" });
    mockIsAgentInSubtree.mockResolvedValue(false);
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects naming an issue that does not resolve in this company (fails closed)", async () => {
    const db = createDb(null);
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("does not constrain a board/user actor naming an issue assigned to an unrelated agent", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "stranger-1" });
    const app = await createUserApp(db);

    const res = await request(app)
      .post("/api/companies/c1111111-1111-4111-8111-111111111111/approvals")
      .send({ type: "request_board_approval", issueIds: [ISSUE_ID], payload: { kind: "merge_pr" } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
    expect(mockIsAgentInSubtree).not.toHaveBeenCalled();
  });

  it("re-validates relevance on resubmit against the issue's current assignee, not just at original filing", async () => {
    // Issue was reassigned away from the original filer sometime between create and resubmit.
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "stranger-1" });
    mockIsAgentInSubtree.mockResolvedValue(false);
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "c1111111-1111-4111-8111-111111111111",
      requestedByAgentId: "agent-1",
      type: "request_board_approval",
      status: "pending",
      payload: { kind: "merge_pr", originalIssueIds: [ISSUE_ID] },
    });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { kind: "merge_pr" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("allows resubmit when the anchored issue is still relevant to the requesting agent", async () => {
    const db = createDb({ id: ISSUE_ID, companyId: "c1111111-1111-4111-8111-111111111111", assigneeAgentId: "agent-1" });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "c1111111-1111-4111-8111-111111111111",
      requestedByAgentId: "agent-1",
      type: "request_board_approval",
      status: "pending",
      payload: { kind: "merge_pr", originalIssueIds: [ISSUE_ID] },
    });
    mockApprovalService.resubmit.mockResolvedValue({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      companyId: "c1111111-1111-4111-8111-111111111111",
    });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { kind: "merge_pr" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalled();
  });
});
