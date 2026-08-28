/**
 * DUR-69/DUR-109: boss-proposed instructions change proposal authorization
 *
 * OPERATOR RULINGS from DUR-69:
 *   1. An agent may never change its own instructions (proven elsewhere by
 *      the rollback/PATCH guard tests).
 *   2. A boss may PROPOSE new instructions for a DIRECT REPORT.
 *   3. Nothing takes effect until an operator approves it (proven in
 *      instructions-change-approval-service.test.ts).
 *   4. A boss may not propose changes to its own instructions.
 *
 * These are all filed through the generic `POST /companies/:companyId/approvals`
 * route with `type: "request_board_approval", payload.kind: "instructions_change"`
 * — this suite proves the authorization gate on that path, and that
 * `beforeContent` is always recomputed server-side rather than trusted from
 * the requester.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const TEST_TIMEOUT = 20_000;

const bossAgentId = "11111111-1111-4111-8111-111111111111";
const reportAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  findOpenInstructionsChangeApproval: vi.fn(),
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
const mockInstructionsService = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentInstructionsService: () => mockInstructionsService,
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
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          limit: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as any;
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
  app.use("/api", approvalRoutes(withFakeCompanyScopeReserve(createRouteDb())));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "filip",
  companyIds: [companyId],
  source: "session",
  isInstanceAdmin: false,
};

function agentActor(agentId: string) {
  return { type: "agent", agentId, companyId, runId: "run-1", source: "agent_key" };
}

const boss = { id: bossAgentId, companyId, reportsTo: null };
const report = { id: reportAgentId, companyId, reportsTo: bossAgentId };
const peer = { id: peerAgentId, companyId, reportsTo: null };

function instructionsChangePayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "instructions_change",
    agentId: reportAgentId,
    relativePath: "AGENTS.md",
    afterContent: "# Refreshed instructions",
    reason: "The project moved into beta; the brief is stale.",
    title: "Update Builder's instructions",
    ...overrides,
  };
}

describe("instructions change proposal authorization (DUR-69/DUR-109)", () => {
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
    mockApprovalService.findOpenInstructionsChangeApproval.mockResolvedValue(null);
    mockApprovalService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      id: "new-approval-1",
      companyId,
      status: "pending",
      ...data,
    }));

    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === bossAgentId) return boss;
      if (id === reportAgentId) return report;
      if (id === peerAgentId) return peer;
      return null;
    });
    mockInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      content: "# Current instructions on disk",
    });
  });

  it("refuses a board-authenticated caller filing an instructions_change proposal", async () => {
    const res = await request(await createApp(boardActor))
      .post(`/api/companies/${companyId}/approvals`)
      .send({ type: "request_board_approval", payload: instructionsChangePayload() });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a boss proposing an instructions change for itself", async () => {
    const res = await request(await createApp(agentActor(bossAgentId)))
      .post(`/api/companies/${companyId}/approvals`)
      .send({ type: "request_board_approval", payload: instructionsChangePayload({ agentId: bossAgentId }) });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses an agent proposing an instructions change for an agent that is not its direct report", async () => {
    // peerAgentId reports to nobody -- bossAgentId is not its manager, so this
    // also covers "an agent cannot propose at all" for an agent with no
    // direct reports of its own: there is no target it could ever satisfy
    // this check for.
    const res = await request(await createApp(agentActor(bossAgentId)))
      .post(`/api/companies/${companyId}/approvals`)
      .send({ type: "request_board_approval", payload: instructionsChangePayload({ agentId: peerAgentId }) });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("allows a boss to propose an instructions change for its direct report, recomputing beforeContent from disk", async () => {
    const res = await request(await createApp(agentActor(bossAgentId)))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        payload: instructionsChangePayload({ beforeContent: "the proposer's forged before-text" }),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: reportAgentId }),
      "AGENTS.md",
    );
    const createCall = mockApprovalService.create.mock.calls[0];
    expect(createCall[1].payload.beforeContent).toBe("# Current instructions on disk");
    expect(createCall[1].payload.afterContent).toBe("# Refreshed instructions");
    expect(createCall[1].requestedByAgentId).toBe(bossAgentId);
  }, TEST_TIMEOUT);

  it("server-composes the approval summary from before/after/reason, ignoring a caller-supplied summary", async () => {
    const res = await request(await createApp(agentActor(bossAgentId)))
      .post(`/api/companies/${companyId}/approvals`)
      .send({
        type: "request_board_approval",
        payload: instructionsChangePayload({
          summary: "Trust me, this is a tiny harmless tweak.",
        }),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const summary = createCall[1].payload.summary as string;
    expect(summary).not.toContain("Trust me, this is a tiny harmless tweak.");
    expect(summary).toContain("# Current instructions on disk");
    expect(summary).toContain("# Refreshed instructions");
    expect(summary).toContain("The project moved into beta; the brief is stale.");
  }, TEST_TIMEOUT);

  it("refuses a proposal whose recomputed beforeContent is identical to afterContent", async () => {
    mockInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      content: "# Refreshed instructions",
    });

    const res = await request(await createApp(agentActor(bossAgentId)))
      .post(`/api/companies/${companyId}/approvals`)
      .send({ type: "request_board_approval", payload: instructionsChangePayload() });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});

describe("instructions change proposal resubmit after send-back-for-changes (DUR-69/DUR-109)", () => {
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
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === bossAgentId) return boss;
      if (id === reportAgentId) return report;
      return null;
    });
    mockInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      content: "# Current instructions on disk",
    });
    mockApprovalService.resubmit.mockImplementation(async (id: string, payload: Record<string, unknown>) => ({
      id,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload,
      requestedByAgentId: bossAgentId,
    }));
  });

  it("recomputes beforeContent fresh when the proposing boss resubmits after Filip's send-back note", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: instructionsChangePayload({ beforeContent: "# stale snapshot from the first pass" }),
      requestedByAgentId: bossAgentId,
    });

    const res = await request(await createApp(agentActor(bossAgentId)))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: instructionsChangePayload({ afterContent: "# Revised per Filip's note" }) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: reportAgentId }),
      "AGENTS.md",
    );
    const [, resubmittedPayload] = mockApprovalService.resubmit.mock.calls[0]!;
    expect(resubmittedPayload.beforeContent).toBe("# Current instructions on disk");
    expect(resubmittedPayload.afterContent).toBe("# Revised per Filip's note");
  }, TEST_TIMEOUT);

  it("server-composes the resubmitted summary too, ignoring a caller-supplied summary", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: instructionsChangePayload({ beforeContent: "# stale snapshot from the first pass" }),
      requestedByAgentId: bossAgentId,
    });

    const res = await request(await createApp(agentActor(bossAgentId)))
      .post("/api/approvals/approval-1/resubmit")
      .send({
        payload: instructionsChangePayload({
          afterContent: "# Revised per Filip's note",
          summary: "Nothing to see here.",
        }),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, resubmittedPayload] = mockApprovalService.resubmit.mock.calls[0]!;
    expect(resubmittedPayload.summary).not.toContain("Nothing to see here.");
    expect(resubmittedPayload.summary).toContain("# Current instructions on disk");
    expect(resubmittedPayload.summary).toContain("# Revised per Filip's note");
  }, TEST_TIMEOUT);

  it("refuses a resubmit from an agent other than the original proposing boss", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: instructionsChangePayload(),
      requestedByAgentId: bossAgentId,
    });

    const res = await request(await createApp(agentActor(peerAgentId)))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: instructionsChangePayload({ afterContent: "# Someone else's rewrite" }) });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a resubmit that strips payload.kind, so the forced beforeContent/summary recompute can't be dodged (DUR-112)", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: instructionsChangePayload({ beforeContent: "# Current instructions on disk" }),
      requestedByAgentId: bossAgentId,
    });

    const { kind: _kind, ...payloadWithoutKind } = instructionsChangePayload({
      afterContent: "# Forged rewrite",
      summary: "Forged summary text that looks legitimate.",
    });

    const res = await request(await createApp(agentActor(bossAgentId)))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: payloadWithoutKind });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("refuses a resubmit that swaps payload.kind to a different approval kind", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: instructionsChangePayload({ beforeContent: "# Current instructions on disk" }),
      requestedByAgentId: bossAgentId,
    });

    const res = await request(await createApp(agentActor(bossAgentId)))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { kind: "tool_grant", summary: "Forged summary text that looks legitimate." } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});
