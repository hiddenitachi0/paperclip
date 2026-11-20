/**
 * DUR-5183: a deploy card is refused while the checks of the version it ships are still
 * running (422 deploy_ci_pending) or have failed (422 deploy_ci_failed). No checks and
 * "could not ask GitHub" let the card through, like the deploy runner. Only the board may
 * file anyway (allowUnfinishedChecks), and a board rollback never waits for checks.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects, projectWorkspaces } from "@paperclipai/db";
import { getTableName } from "drizzle-orm";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

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

// resolveProjectDeployBranchesByProjectId is mocked directly (like the DUR-40
// mirror-branch guard test mocks resolveProjectDeployBranches) so the guard's
// deploy-branch lookup doesn't need a real DB.
const mockResolveProjectDeployBranchesByProjectId = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

const mockPersonaService = vi.hoisted(() => ({
  getPersonaDisplayNamesByAgentIds: vi.fn(async () => new Map()),
}));

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
    personaService: () => mockPersonaService,
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
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

// DUR-394: approvals.ts's deploy-ancestry-guard checks now run against the
// company-scoped `db` (createRequestScopedDb(rawDb) resolved through
// runInCompanyScope's AsyncLocalStorage -- see middleware/company-scope.ts),
// which is a REAL drizzle instance layered over the fake reserved connection
// `withFakeCompanyScopeReserve` provides, not this file's own
// select()/from()/where() mock chain below (that chain is only exercised by
// code that still calls the raw, unwrapped db directly -- nothing in this
// route does for the queries these tests exercise). The scoped queries are
// real `db.select({...}).from(...).where(...)` calls that execute via the
// reserved connection's `client.unsafe(query, params).values()`, which
// withFakeCompanyScopeReserve's `unsafeRows` option backs with one static
// positional-tuple row shared by every query the request issues.
//
// Both real queries this guard makes fit in one shared 2-column tuple:
// assertDeployRequestProjectExists's `{id, companyId}` project select reads
// column 1 as companyId (column 0/"id" is unused by the guard's logic, and
// the fake connection doesn't filter by the WHERE clause's id param anyway),
// and the workspace `{repoUrl}` select reads column 0. So `[repoUrl,
// companyId]` satisfies both selects at once regardless of which one (or
// both) a given test's code path actually reaches.
function createRouteDb(workspaceRepoUrl: string | null | undefined = "https://github.com/acme/widgets") {
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => {
            if (getTableName(table as any) === getTableName(projects)) {
              return resolve([{ id: PROJECT_ID, companyId: COMPANY_ID }]);
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
  };
  return withFakeCompanyScopeReserve(fakeDb as any, {
    unsafeRows: [[workspaceRepoUrl ?? null, COMPANY_ID]],
  });
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
      companyId: "22222222-2222-4222-8222-222222222222",
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

/**
 * DUR-3964: filing a deploy card with no commit id -- deploying whatever is at
 * the top of the branch -- is something only the board may do now.
 */
async function createBoardApp(db: any) {
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
      companyIds: ["22222222-2222-4222-8222-222222222222"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

/** Which compare calls the filing path made (the pointless-deploy-card guard added other GitHub calls). */
function comparesRequested(): string[] {
  return mockGhFetch.mock.calls
    .map((call: unknown[]) => (typeof call[0] === "string" ? call[0] : ""))
    .filter((url: string) => url.includes("/compare/"));
}

/**
 * DUR-3964: an agent-filed deploy card must name the commit in full, so these
 * are the same two commits this suite always used, written out to 40
 * characters. Every assertion still reads the short form the messages print.
 */
const OFF_BRANCH_COMMIT = "d55e57041234567890abcdef1234567890abcdef";
const ON_BRANCH_COMMIT = "abc1234def5678901234567890abcdef12345678";

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


type CheckRun = { name: string; status: string; conclusion: string | null };

/** GitHub as seen by the filing path: ancestry says "ahead", the commit exists, checks are as given. */
function githubWithChecks(opts: { runs?: CheckRun[]; statusTotal?: number; statusDown?: boolean }) {
  const runs = opts.runs ?? [];
  mockGhFetch.mockImplementation(async (url: string) => {
    if (url.includes("/compare/")) return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
    if (url.includes("/check-runs")) {
      return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), { status: 200 });
    }
    if (url.endsWith("/status")) {
      if (opts.statusDown) return new Response("{}", { status: 502 });
      return new Response(
        JSON.stringify({ state: opts.statusTotal ? "success" : "pending", total_count: opts.statusTotal ?? 0, statuses: [] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ sha: ON_BRANCH_COMMIT }), { status: 200 });
  });
}

function ciCalls(): string[] {
  return mockGhFetch.mock.calls
    .map((call: unknown[]) => (typeof call[0] === "string" ? call[0] : ""))
    .filter((url: string) => url.endsWith("/status") || url.includes("/check-runs"));
}

const COMPANY_APPROVALS = `/api/companies/${COMPANY_ID}/approvals`;

describe("DUR-5183: deploy card waits for green checks", () => {
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
      companyId: COMPANY_ID,
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({
      deployBranch: "custom",
      mirrorBranch: "master",
      projectId: PROJECT_ID,
    });
  });

  it("refuses a card while checks are still running, naming them", async () => {
    githubWithChecks({
      runs: [
        { name: "build", status: "in_progress", conclusion: null },
        { name: "unit tests", status: "queued", conclusion: null },
        { name: "lint", status: "completed", conclusion: "success" },
      ],
    });
    const app = await createAgentApp(createRouteDb());

    const res = await request(app).post(COMPANY_APPROVALS).send(deployBody(ON_BRANCH_COMMIT));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("deploy_ci_pending");
    expect(res.body.error).toBe("This version's checks are still running (build and unit tests). File the card when they are green.");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a card whose checks failed, naming the failed ones", async () => {
    githubWithChecks({
      runs: [
        { name: "unit tests", status: "completed", conclusion: "failure" },
        { name: "build", status: "in_progress", conclusion: null },
      ],
    });
    const app = await createAgentApp(createRouteDb());

    const res = await request(app).post(COMPANY_APPROVALS).send(deployBody(ON_BRANCH_COMMIT));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("deploy_ci_failed");
    expect(res.body.error).toMatch(/This version failed its checks: unit tests\./);
    expect(res.body.details.failedChecks).toEqual(["unit tests"]);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("files the card when every check is green", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    const app = await createAgentApp(createRouteDb());

    const res = await request(app).post(COMPANY_APPROVALS).send(deployBody(ON_BRANCH_COMMIT));

    expect(res.status).toBe(201);
    expect(ciCalls().length).toBeGreaterThan(0);
    expect(mockApprovalService.create.mock.calls[0][1].payload.checksOverride).toBeUndefined();
  }, TEST_TIMEOUT);

  it("lets a commit with no checks at all through", async () => {
    githubWithChecks({ runs: [] });
    const app = await createAgentApp(createRouteDb());

    const res = await request(app).post(COMPANY_APPROVALS).send(deployBody(ON_BRANCH_COMMIT));

    expect(res.status).toBe(201);
  }, TEST_TIMEOUT);

  it("lets the card through when GitHub cannot say (unknown)", async () => {
    githubWithChecks({ statusDown: true });
    const app = await createAgentApp(createRouteDb());

    const res = await request(app).post(COMPANY_APPROVALS).send(deployBody(ON_BRANCH_COMMIT));

    expect(res.status).toBe(201);
  }, TEST_TIMEOUT);

  it("refuses on resubmit too", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "in_progress", conclusion: null }] });
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
      .send({ payload: deployBody(ON_BRANCH_COMMIT).payload });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("deploy_ci_pending");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("never lets an agent set allowUnfinishedChecks", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "in_progress", conclusion: null }] });
    const app = await createAgentApp(createRouteDb());
    const body = deployBody(ON_BRANCH_COMMIT);

    const res = await request(app)
      .post(COMPANY_APPROVALS)
      .send({ ...body, payload: { ...body.payload, allowUnfinishedChecks: true } });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("lets the board file anyway on purpose, and notes the checks on the card", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "in_progress", conclusion: null }] });
    const app = await createBoardApp(createRouteDb());
    const body = deployBody(ON_BRANCH_COMMIT);

    const res = await request(app)
      .post(COMPANY_APPROVALS)
      .send({ ...body, payload: { ...body.payload, allowUnfinishedChecks: true } });

    expect(res.status).toBe(201);
    const payload = mockApprovalService.create.mock.calls[0][1].payload;
    expect(payload.allowUnfinishedChecks).toBe(true);
    expect(payload.checksOverride).toEqual({ state: "pending", failedChecks: [], pendingChecks: ["build"] });
  }, TEST_TIMEOUT);

  it("ignores a filer-supplied checksOverride stamp", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    const app = await createBoardApp(createRouteDb());
    const body = deployBody(ON_BRANCH_COMMIT);

    const res = await request(app)
      .post(COMPANY_APPROVALS)
      .send({
        ...body,
        payload: { ...body.payload, checksOverride: { state: "failed", failedChecks: ["x"], pendingChecks: [] } },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create.mock.calls[0][1].payload.checksOverride).toBeUndefined();
  }, TEST_TIMEOUT);

  it("does not make a board rollback wait for checks (or ask GitHub for them)", async () => {
    githubWithChecks({ runs: [{ name: "build", status: "in_progress", conclusion: null }] });
    const app = await createBoardApp(createRouteDb());
    const body = deployBody(ON_BRANCH_COMMIT);

    const res = await request(app)
      .post(COMPANY_APPROVALS)
      .send({ ...body, payload: { ...body.payload, allowBackwardDeploy: true } });

    expect(res.status).toBe(201);
    expect(ciCalls()).toEqual([]);
  }, TEST_TIMEOUT);
});
