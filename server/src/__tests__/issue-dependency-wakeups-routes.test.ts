import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
// Route param ids must not look like an issue identifier (e.g. "ISSUE-1"
// matches the PAP-123-shaped identifier regex) -- resolveIssueRouteId /
// scopeFromIssueParam (DUR-379) route those through the mocked
// getByIdentifier (which returns null here) instead of getById.
const ISSUE_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_1_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));
// DUR-932: records the `db` identity every heartbeatService()/issueService()
// construction call was made with, so a test can pin that the post-response
// wakeup fan-out in routes/issues.ts is built from the raw pooled db (not
// the request-scoped proxy) -- see rawHeartbeat/rawSvc there.
const heartbeatServiceCalls = vi.hoisted(() => [] as unknown[]);
const issueServiceCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("../services/index.js", () => ({
  isHeartbeatRunLiveInThisProcess: vi.fn(() => false),
  escalationGrantService: () => ({ getForIssue: vi.fn(async () => null) }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: (db: unknown) => {
    heartbeatServiceCalls.push(db);
    return {
      wakeup: mockWakeup,
      reportRunActivity: vi.fn(async () => undefined),
    };
  },
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: (db: unknown) => {
    issueServiceCalls.push(db);
    return mockIssueService;
  },
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const rawDb = withFakeCompanyScopeReserve({});
  app.use("/api", issueRoutes(rawDb as any, {} as any));
  (app as unknown as { rawDb: unknown }).rawDb = rawDb;
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    heartbeatServiceCalls.length = 0;
    issueServiceCalls.length = 0;
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: [ISSUE_1_ID, "issue-3"],
      },
    ]);

    const app = await createApp();
    const res = await request(app).patch(`/api/issues/${ISSUE_1_ID}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: ISSUE_1_ID,
          }),
        }),
      );
    });
  }, 20_000);

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: CHILD_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: CHILD_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", CHILD_1_ID],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: CHILD_1_ID,
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch(`/api/issues/${CHILD_1_ID}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: CHILD_1_ID,
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  }, 20_000);

  // DUR-932: the PATCH /issues/:id and POST /issues/:id/comments handlers
  // fire their wakeup fan-out (heartbeat.wakeup, listWakeableBlockedDependents,
  // etc.) via `void (async () => {...})()` so the response doesn't wait on it.
  // That means it can still be running after this request's reserved
  // connection is released back to the pool -- before the fix, that block
  // reused `heartbeat`/`svc` (built on the request-scoped db), so a later
  // request could reuse the same physical connection while this one was
  // still issuing queries on it, corrupting the postgres wire protocol
  // (08P01 "bind message supplies N parameters..."). This pins that the
  // fan-out is now built from the raw pooled db instead (rawHeartbeat/rawSvc),
  // mirroring the DUR-417 queueTaskWatchdogEvaluation fix already in place.
  it("builds the post-response wakeup fan-out from the raw pooled db, not the request-scoped proxy (DUR-932)", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_1_ID,
      companyId: COMPANY_ID,
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: [ISSUE_1_ID, "issue-3"],
      },
    ]);

    const app = await createApp();
    const rawDb = (app as unknown as { rawDb: unknown }).rawDb;
    const res = await request(app).patch(`/api/issues/${ISSUE_1_ID}`).send({ status: "done" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({ reason: "issue_blockers_resolved" }),
      );
    });

    // heartbeatService() is constructed once from the scoped `db` (for
    // synchronous request-path wakeups elsewhere) and once from `rawDb`
    // (rawHeartbeat, used by the fire-and-forget block above). Before the
    // fix there was no rawDb-identity call at all.
    expect(heartbeatServiceCalls.some((db) => db === rawDb)).toBe(true);
    // issueService() likewise needs a rawDb-identity instance (rawSvc) that
    // the fire-and-forget block's listWakeableBlockedDependents/
    // findMentionedAgents/getWakeableParentAfterChildCompletion calls run
    // through instead of the request-scoped `svc`.
    expect(issueServiceCalls.some((db) => db === rawDb)).toBe(true);
  }, 20_000);
});
