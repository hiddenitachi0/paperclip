/**
 * DUR-252 security review of PR #169 (DUR-238): `issueApprovals` is a mutable link table --
 * `assertCanManageIssueApprovalLinks` lets the agent that originally requested a `merge_pr`
 * approval relink it to ANY issue in the company later, and nothing stopped an agent with only
 * `merges:request` from filing a fresh approval against an arbitrary already-merged historical
 * PR and linking it to someone else's `in_review` issue once approved. Either lets an attacker
 * get an issue whose own work was never reviewed force-closed by `deploy-carried-issues.ts`'s
 * unattended sweep.
 *
 * `originalIssueIds` (stamped once, server-side, at creation) anchors which issue(s) an
 * approval was actually filed for, independent of the mutable link table. Verifies that:
 * - creating a merge_pr approval stamps `originalIssueIds` from the request's own `issueIds`,
 *   never from a caller-supplied value in the payload,
 * - resubmitting a merge_pr approval can never change `originalIssueIds` -- it is always
 *   re-stamped from what creation already persisted,
 * - it has no effect on non-merge_pr payloads,
 * - filing a merge_pr approval with a `repo` that provably does not match the project's own
 *   registered GitHub repo is rejected (finding #1's literal suggested fix; defense in depth
 *   alongside originalIssueIds, which is what closes the actual misuse scenario).
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

// No deploy/mirror branch declared for this project -- keeps the DUR-40 guard a no-op so this
// suite only exercises originalIssueIds/repo validation.
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn(async () => null));

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

// Discriminates on the queried table so this same fake can answer both
// resolveProjectIdForIssues (issues.projectId) and resolveProjectPrimaryRepo
// (projectWorkspaces.repoUrl) -- pass `null` for either to make that lookup resolve nothing
// (keeping the repo-validation guard a no-op), matching the fail-open-on-unknown-project
// posture the guard itself takes.
//
// Dynamically imports `@paperclipai/db` rather than a static top-level import: this suite's
// `beforeEach` calls `vi.resetModules()` and the route module is re-imported dynamically after
// that reset, so a statically-imported `issues`/`projectWorkspaces` captured before the reset
// would be a DIFFERENT module instance than the one `routes/approvals.ts` sees -- table
// identity comparisons below would silently never match.
async function createDbWithProjectAndRepo(input: { projectId: string | null; repoUrl: string | null }) {
  const { issues, projectWorkspaces } = await import("@paperclipai/db");
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => {
            if (table === issues) {
              return resolve(input.projectId ? [{ projectId: input.projectId }] : []);
            }
            if (table === projectWorkspaces) {
              return resolve(input.repoUrl ? [{ repoUrl: input.repoUrl }] : []);
            }
            return resolve([]);
          },
        })),
      })),
    })),
  } as any;
}

async function createAgentApp(db?: unknown) {
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
  app.use(
    "/api",
    approvalRoutes((db ?? (await createDbWithProjectAndRepo({ projectId: null, repoUrl: null }))) as any),
  );
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";

describe("DUR-252: merge_pr originalIssueIds anchor + repo validation guard", () => {
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

  it("stamps originalIssueIds from the request's own issueIds when filing a merge_pr approval", async () => {
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "merge_pr", base: "custom", pr: "https://github.com/example/repo/pull/1" },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(savedPayload.originalIssueIds).toEqual([ISSUE_ID]);
  });

  it("ignores a caller-supplied originalIssueIds and stamps the real linked issueIds instead", async () => {
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
          // Attacker-supplied: tries to pre-claim a different issue than what's actually linked.
          originalIssueIds: [OTHER_ISSUE_ID],
        },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(savedPayload.originalIssueIds).toEqual([ISSUE_ID]);
  });

  it("leaves originalIssueIds absent on non-merge_pr payloads", async () => {
    const app = await createAgentApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "some_other_kind", title: "Not a merge_pr approval" },
      });

    expect(res.status).toBe(201);
    const createCall = mockApprovalService.create.mock.calls[0];
    const savedPayload: Record<string, unknown> = createCall?.[1]?.payload ?? {};
    expect(savedPayload.originalIssueIds).toBeUndefined();
  });

  it("never lets resubmit change originalIssueIds, even when the caller supplies a different value", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
      type: "request_board_approval",
      status: "pending",
      payload: {
        kind: "merge_pr",
        base: "custom",
        pr: "https://github.com/example/repo/pull/1",
        originalIssueIds: [ISSUE_ID],
      },
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
          // Relink attempt: tries to overwrite the anchor with a different issue on resubmit.
          originalIssueIds: [OTHER_ISSUE_ID],
        },
      });

    const resubmitCall = mockApprovalService.resubmit.mock.calls[0];
    const resubmittedPayload: Record<string, unknown> = resubmitCall?.[1] ?? {};
    expect(resubmittedPayload.originalIssueIds).toEqual([ISSUE_ID]);
  });

  it("rejects filing a merge_pr approval whose repo does not match the project's registered GitHub repo", async () => {
    const db = await createDbWithProjectAndRepo({
      projectId: "project-1",
      repoUrl: "https://github.com/acme/real-repo",
    });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "merge_pr", base: "custom", repo: "attacker/unrelated-repo", prNumber: 1 },
      });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("allows filing a merge_pr approval whose repo matches the project's registered GitHub repo", async () => {
    const db = await createDbWithProjectAndRepo({
      projectId: "project-1",
      repoUrl: "https://github.com/acme/real-repo",
    });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "merge_pr", base: "custom", repo: "acme/real-repo", prNumber: 1 },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("does not reject an unresolvable repo claim (project has no registered repo) -- fails open on unknown, not on unproven", async () => {
    const db = await createDbWithProjectAndRepo({ projectId: "project-1", repoUrl: null });
    const app = await createAgentApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: [ISSUE_ID],
        payload: { kind: "merge_pr", base: "custom", repo: "someone/somewhere", prNumber: 1 },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalled();
  });
});
