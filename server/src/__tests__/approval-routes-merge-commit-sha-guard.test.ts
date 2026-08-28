/**
 * DUR-237: `payload.mergeCommitSha` on a `kind:"merge_pr"` approval is read by
 * deploy-completion-gate.ts as proof the underlying PR merged as a specific commit, and
 * is only ever meant to be written by merge-deploy-visibility.ts after it independently
 * verifies the merge via GitHub's API. The create/resubmit request body is otherwise
 * caller-controlled, so without stripping it server-side, a requester could hand-write
 * any sha it likes -- including one already known to be live from an unrelated deploy --
 * and short-circuit the completion gate without this approval's PR ever merging.
 *
 * Verifies that:
 * - A caller-supplied `mergeCommitSha` in a create request never reaches the persisted
 *   payload.
 * - A caller-supplied `mergeCommitSha` in a resubmit request never reaches the persisted
 *   payload either.
 * - It has no effect on non-merge_pr payloads (nothing to strip, nothing to break).
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

// No deploy/mirror branch declared for this project -- keeps the DUR-40 guard a no-op so
// this suite only exercises the mergeCommitSha strip.
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn(async () => null));

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
    resolveProjectDeployBranches: mockResolveProjectDeployBranches,
  }));
}

// Minimal DB that satisfies assertApprovalMutationAllowedByRunContext (returns no run row,
// so the function returns true and the route continues) and any other select queries the
// route performs outside the mocked modules.
function createMinimalDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
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
const FORGED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("DUR-237: merge_pr mergeCommitSha strip guard", () => {
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
      companyId: "company-1",
    });
  });

  it("strips a caller-supplied mergeCommitSha when filing a merge_pr approval", async () => {
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: {
          kind: "merge_pr",
          base: "custom",
          pr: "https://github.com/example/repo/pull/1",
          mergeCommitSha: FORGED_SHA,
        },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(savedPayload.mergeCommitSha).toBeUndefined();
  });

  it("leaves mergeCommitSha untouched on non-merge_pr payloads", async () => {
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: {
          kind: "some_other_kind",
          title: "Not a merge_pr approval",
          mergeCommitSha: FORGED_SHA,
        },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(savedPayload.mergeCommitSha).toBe(FORGED_SHA);
  });

  it("strips a caller-supplied mergeCommitSha on resubmit", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
      type: "request_board_approval",
      status: "pending",
      payload: { kind: "merge_pr", base: "custom", pr: "https://github.com/example/repo/pull/1" },
    });
    mockApprovalService.resubmit.mockResolvedValue({
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      companyId: "company-1",
    });
    const app = await createAgentApp();

    await request(app)
      .post("/api/approvals/approval-1/resubmit")
      .send({
        payload: {
          kind: "merge_pr",
          base: "custom",
          pr: "https://github.com/example/repo/pull/1",
          mergeCommitSha: FORGED_SHA,
        },
      });

    const resubmitCall = mockApprovalService.resubmit.mock.calls[0];
    const resubmittedPayload: Record<string, unknown> = resubmitCall?.[1] ?? {};
    expect(resubmittedPayload.mergeCommitSha).toBeUndefined();
  });
});
