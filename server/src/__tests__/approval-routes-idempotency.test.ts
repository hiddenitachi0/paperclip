import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

// `vi.resetModules()` in beforeEach re-transforms the large approvals.ts
// dependency graph on every test; the first test to hit that cold-start
// cost can exceed the default 5s budget.
vi.setConfig({ testTimeout: 20_000 });

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

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

type TableRows = { match: string; rows: unknown[] };

// approvals.ts runs a handful of real (not service-mocked) `db.select()`/
// `db.insert()` calls -- heartbeat_runs run-context lookups, the
// deploy-request project-existence/deploy-branch lookups, and the
// issue/project/company title-resolution lookups -- against the request-scoped
// db built by createRequestScopedDb(rawDb). That proxy always resolves through
// the real drizzle-orm query builder bound to whatever connection
// runInCompanyScope reserved (see middleware/company-scope.ts), so a fake
// `.select().from().where()` chain on the object passed to approvalRoutes(...)
// is never actually reached -- only the shape of the *reserved connection*
// (rawDb.$client.reserve()) matters. withFakeCompanyScopeReserve's `unsafeRows`
// is one static array shared by every query on that connection, which can't
// tell two different tables' queries apart within a single request. This
// builds on top of it, keeping the same reserve/release/options contract, but
// dispatches canned rows by matching a substring of the table name against
// the actual SQL text `client.unsafe()` receives, so each table queried
// during one request can return its own canned result.
function withTableAwareCompanyScopeReserve<T extends object>(fakeDb: T, rowsByTable: TableRows[]): T {
  const wrapped = withFakeCompanyScopeReserve(fakeDb);
  const client = (wrapped as unknown as { $client: { reserve: () => Promise<unknown> } }).$client;
  client.reserve = async () => {
    const reserved = async (..._args: unknown[]) => [];
    Object.assign(reserved, {
      release: () => {},
      unsafe: (query: string) => {
        const match = rowsByTable.find((entry) => query.includes(entry.match));
        const rows = match ? match.rows : [];
        const result: Promise<unknown[]> & { values?: () => Promise<unknown[]> } = Promise.resolve(rows);
        result.values = () => Promise.resolve(rows);
        return result;
      },
    });
    return reserved;
  };
  return wrapped;
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
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
      ...actorOverrides,
    };
    next();
  });
  // Board-actor approve/reject/request-revision routes never reach the
  // run-context/heartbeat_runs check (assertApprovalMutationAllowedByRunContext
  // bails out immediately for a non-agent actor), so no table rows are needed.
  app.use("/api", approvalRoutes(withFakeCompanyScopeReserve({})));
  app.use(errorHandler);
  return app;
}

async function createAgentApp(
  options: {
    runId?: string;
    contextSnapshot?: Record<string, unknown>;
    existingWakeRows?: unknown[];
    projectRow?: { id: string; companyId: string };
  } = {},
) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  const runId = options.runId ?? "run-1";
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      runId,
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  const rowsByTable: TableRows[] = [];
  if (options.contextSnapshot) {
    // assertApprovalMutationAllowedByRunContext's heartbeat_runs lookup --
    // { id, companyId, agentId, contextSnapshot }, in that column order.
    rowsByTable.push({ match: "heartbeat_runs", rows: [[runId, COMPANY_ID, "agent-1", options.contextSnapshot]] });
    // recordCheapRunEscalation's findExistingCheapRunEscalationWake / count
    // lookups both hit agent_wakeup_requests -- non-empty means "an escalation
    // wake already exists" for both checks (they're only used via truthiness/
    // .length here), so it's fine that they share one canned result.
    rowsByTable.push({ match: "agent_wakeup_requests", rows: options.existingWakeRows ?? [] });
  }
  if (options.projectRow) {
    // assertDeployRequestProjectExists's { id, companyId } projection.
    rowsByTable.push({ match: "projects", rows: [[options.projectRow.id, options.projectRow.companyId]] });
  }
  app.use("/api", approvalRoutes(withTableAwareCompanyScopeReserve({}, rowsByTable)));
  app.use(errorHandler);
  return app;
}

async function createAgentAppWithTableRows(rowsByTable: TableRows[]) {
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
  app.use("/api", approvalRoutes(withTableAwareCompanyScopeReserve({}, rowsByTable)));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockApprovalService.findOpenHireApprovalForRole.mockReset();
    mockApprovalService.findOpenMergePrApproval.mockReset();
    mockApprovalService.findOpenDeployApproval.mockReset();
    // DUR-101 dedup guard: default to "no open duplicate" so these
    // pre-existing idempotency cases aren't affected by the new check.
    mockApprovalService.findOpenHireApprovalForRole.mockResolvedValue(null);
    mockApprovalService.findOpenMergePrApproval.mockResolvedValue(null);
    mockApprovalService.findOpenDeployApproval.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mockIssueThreadInteractionService.resolveInteractionsLinkedToApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "33333333-3333-4333-8333-333333333333",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "33333333-3333-4333-8333-333333333333",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "22222222-2222-4222-8222-222222222222",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it");
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "22222222-2222-4222-8222-222222222222",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now");
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-6",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "hire_agent",
      status: "revision_requested",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "22222222-2222-4222-8222-222222222222",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("rewrites payload.title to '<project> — <what this does>' from the linked issue's project (DUR-24)", async () => {
    mockApprovalService.create.mockResolvedValue({ id: "approval-title-1" });

    const res = await request(
      await createAgentAppWithTableRows([
        { match: "issues", rows: [["11111111-1111-4111-8111-111111111111"]] },
        { match: "projects", rows: [["Nordstrand dashboard"]] },
      ]),
    )
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "put the 2026 look, translations and Finance fixes live" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Nordstrand dashboard — put the 2026 look, translations and Finance fixes live",
        }),
      }),
    );
  });

  it("strips a legacy PR-number title prefix and lifts prNumber/repo into a technicalReference line, never the title (DUR-24)", async () => {
    mockApprovalService.create.mockResolvedValue({ id: "approval-title-2" });

    const res = await request(
      await createAgentAppWithTableRows([{ match: "companies", rows: [["Paperclip Fork Co"]] }]),
    )
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          kind: "merge_pr",
          title: "Merge PR #12 — sub-tasks inherit the model and effort you set on a task",
          repo: "fork",
          prNumber: 12,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        payload: expect.objectContaining({
          title: "Paperclip Fork Co — sub-tasks inherit the model and effort you set on a task",
          technicalReference: "Technical reference: fork repo, pull request #12",
        }),
      }),
    );
    const [, createArg] = mockApprovalService.create.mock.calls[0];
    expect(createArg.payload.title).not.toMatch(/#12/);
  });

  it("rejects deploy-request approvals whose payload does not match deployRequestPayloadSchema", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          kind: "deploy",
          projectId: "not-a-uuid",
          title: "Deploy dashboard",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts a well-formed deploy-request approval payload", async () => {
    const payload = {
      kind: "deploy",
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      commit: "abc1234",
      title: "Deploy dashboard main",
      note: "Routine deploy after merge.",
    };
    mockApprovalService.create.mockResolvedValue({
      id: "approval-9",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(
      await createAgentApp({
        projectRow: { id: "11111111-1111-4111-8111-111111111111", companyId: COMPANY_ID },
      }),
    )
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({ type: "request_board_approval", payload });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("rejects deploy-request payloads injected via resubmit", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-10",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      status: "revision_requested",
      payload: { kind: "deploy" },
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-10/resubmit")
      .send({ payload: { kind: "deploy", title: "missing required fields" } });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  // DUR-45: a cheap/status-only run that cannot file an approval must hand the
  // action off to a normal-model run on the same issue instead of just failing.
  it("escalates to a normal-model run instead of leaving a blocked approval unfiled", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        payload: { kind: "merge_pr", title: "Merge the finished PR" },
        issueIds: ["11111111-1111-4111-8111-111111111111"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.escalation).toMatchObject({
      escalated: true,
      alreadyPending: false,
      capped: false,
      count: 1,
    });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const [wokenAgentId, wakeOpts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(wokenAgentId).toBe("agent-1");
    expect(wakeOpts.contextSnapshot.modelProfile).toBeUndefined();
    expect(wakeOpts.contextSnapshot.resumeRequiresNormalModel).toBeUndefined();
    expect(wakeOpts.payload.issueId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("does not enqueue a second escalation wake for a repeat attempt from the same run", async () => {
    const cheapContextSnapshot = {
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    };
    // Simulate an escalation wake already in flight for this (issue, run) pair.
    const res = await request(
      await createAgentApp({
        contextSnapshot: cheapContextSnapshot,
        existingWakeRows: [["existing-wake-run", "queued"]],
      }),
    )
      .post("/api/companies/22222222-2222-4222-8222-222222222222/approvals")
      .send({
        type: "request_board_approval",
        payload: { kind: "merge_pr", title: "Merge the finished PR" },
        issueIds: ["11111111-1111-4111-8111-111111111111"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.escalation).toMatchObject({ escalated: true, alreadyPending: true });
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from resubmitting approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from commenting on approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "22222222-2222-4222-8222-222222222222",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });
});
