/**
 * DUR-3923 item 2 (NOR-1242): an approved deploy card that the runner never processes must
 * get a plain-language note on the approval AND its linked issue(s) -- silence must never be
 * the response to an approval. Verifies the scheduled tick:
 * - says nothing about a card the runner's status log shows it reached (the runner's own
 *   comment is the answer), but still stops re-checking it,
 * - names the likely reason for a real `deploy` card: no such project, deploy settings
 *   off, wrong workspace, runner alive-but-skipped, runner apparently stopped,
 * - tells the operator plainly that a `deploy_pr`-style card will never be acted on,
 * - posts once per approval, and never for cards outside the [maxAge, delay] window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({ addComment: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ addComment: vi.fn() }));

vi.mock("../services/approvals.js", () => ({ approvalService: () => mockApprovalService }));
vi.mock("../services/issue-approvals.js", () => ({ issueApprovalService: () => mockIssueApprovalService }));
vi.mock("../services/issues.js", () => ({ issueService: () => mockIssueService }));

const NOW = new Date("2026-09-05T12:00:00Z");
const COMPANY = "company-1";
const PROJECT = "project-1";
const WS = "11111111-1111-4111-8111-111111111111";

// tick() selects the due approvals first (with .limit); every later select is a
// `projects` lookup by id (thenable). Dispatch by call order.
function makeFakeDb(dueRows: unknown[], projectRowsById: Record<string, unknown> = {}) {
  const updateCalls: Array<{ payload: Record<string, unknown> }> = [];
  let selectCalls = 0;
  let lastLookedUpProject: string | null = null;
  const db = {
    select: vi.fn(() => {
      selectCalls += 1;
      const isDue = selectCalls === 1;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => {
            if (isDue) return { limit: vi.fn(() => Promise.resolve(dueRows)) };
            // Project lookup: the caller only ever looks up the projectId on the current
            // approval, so serve whichever project the test registered for it.
            const rows = lastLookedUpProject && projectRowsById[lastLookedUpProject] ? [projectRowsById[lastLookedUpProject]] : [];
            return {
              then: (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
            };
          }),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((patch: { payload: Record<string, unknown> }) => ({
        where: vi.fn(() => {
          updateCalls.push({ payload: patch.payload });
          return Promise.resolve(undefined);
        }),
      })),
    })),
    // Test hook: which project the next lookup should resolve.
    _expectProject(projectId: string | null) {
      lastLookedUpProject = projectId;
    },
  };
  return { db, updateCalls };
}

function approved(id: string, payload: Record<string, unknown>, decidedAt = new Date("2026-09-05T11:30:00Z")) {
  return { id, companyId: COMPANY, type: "request_board_approval", status: "approved", payload, decidedAt };
}

const deployPayload = { kind: "deploy", projectId: PROJECT, workspaceId: WS, commit: "abc123", title: "Deploy", note: "" };
const enabledProject = { deployPolicy: { enabled: true, workspaceId: WS, deployBranch: "custom" } };

describe("deployApprovalFeedbackService.tick (DUR-3923)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.addComment.mockResolvedValue({ id: "ac-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockIssueService.addComment.mockResolvedValue({ id: "ic-1" });
  });

  it("says nothing about a card the runner reached, but stops re-checking it", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const { db, updateCalls } = makeFakeDb([approved("a-1", deployPayload)]);
    const readStatusLog = vi.fn().mockReturnValue([
      { ts: "2026-09-05T11:32:00Z", approvalId: "a-1", companyId: COMPANY, commentDelivered: true, body: "Deploy failed — x" },
    ]);

    const result = await deployApprovalFeedbackService(db as any, { readStatusLog }).tick(NOW);

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployRunnerFeedbackNoted).toBe(true);
    expect(updateCalls[0].payload.deployRunnerFeedbackOutcome).toBe("processed_by_runner");
  });

  it("tells the operator plainly that a deploy_pr card will never be acted on, on the card and its issue", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const { db, updateCalls } = makeFakeDb([approved("a-2", { kind: "deploy_pr", prNumber: 42, repo: "acme/paperclip" })]);
    const readStatusLog = vi.fn().mockReturnValue([]);

    const result = await deployApprovalFeedbackService(db as any, { readStatusLog }).tick(NOW);

    expect(result).toEqual({ checked: 1, flagged: 1 });
    expect(mockApprovalService.addComment).toHaveBeenCalledTimes(1);
    const [approvalId, body] = mockApprovalService.addComment.mock.calls[0];
    expect(approvalId).toBe("a-2");
    expect(body).toContain("approved 30 minutes ago");
    expect(body).toContain('kind "deploy_pr"');
    expect(body).toContain('kind "deploy"');
    expect(body).toContain("nothing has acted on it and nothing will");
    expect(mockIssueService.addComment).toHaveBeenCalledWith("issue-1", body, {}, { authorType: "system" });
    expect(updateCalls[0].payload.deployRunnerFeedbackNoted).toBe(true);
    expect(updateCalls[0].payload.deployRunnerFeedbackOutcome).toBe("unsupported_kind");
  });

  it("diagnoses a real deploy card nobody picked up: runner apparently stopped", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const { db } = makeFakeDb([approved("a-3", deployPayload)], { [PROJECT]: enabledProject });
    db._expectProject(PROJECT);
    // Last runner activity predates the approval.
    const readStatusLog = vi.fn().mockReturnValue([
      { ts: "2026-09-05T09:00:00Z", approvalId: "older", companyId: COMPANY, commentDelivered: true, body: "Deployed — is live and healthy" },
    ]);

    const result = await deployApprovalFeedbackService(db as any, { readStatusLog }).tick(NOW);

    expect(result).toEqual({ checked: 1, flagged: 1 });
    const [, body] = mockApprovalService.addComment.mock.calls[0];
    expect(body).toContain("the deploy runner has not picked it up");
    expect(body).toContain("may be stopped");
    expect(body).toContain("Nothing has deployed for it yet");
  });

  it("diagnoses a real deploy card nobody picked up: runner alive but skipped it", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const { db } = makeFakeDb([approved("a-4", deployPayload)], { [PROJECT]: enabledProject });
    db._expectProject(PROJECT);
    const readStatusLog = vi.fn().mockReturnValue([
      { ts: "2026-09-05T11:45:00Z", approvalId: "other", companyId: COMPANY, commentDelivered: true, body: "Deployed — is live and healthy" },
    ]);

    await deployApprovalFeedbackService(db as any, { readStatusLog }).tick(NOW);

    const [, body] = mockApprovalService.addComment.mock.calls[0];
    expect(body).toContain("running but skipped this one");
    expect(body).toContain("deploy-runner.log");
  });

  it("diagnoses the wrong-workspace card the runner refuses (the DUR-3926 shape)", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const otherWs = "99999999-9999-4999-8999-999999999999";
    const { db } = makeFakeDb([approved("a-5", { ...deployPayload, workspaceId: otherWs })], { [PROJECT]: enabledProject });
    db._expectProject(PROJECT);

    await deployApprovalFeedbackService(db as any, { readStatusLog: () => [] }).tick(NOW);

    const [, body] = mockApprovalService.addComment.mock.calls[0];
    expect(body).toContain(`names workspace ${otherWs.slice(0, 8)}`);
    expect(body).toContain(`deploys from workspace ${WS.slice(0, 8)}`);
    expect(body).toContain("runner refuses it");
  });

  it("diagnoses deploy settings that are missing or switched off, and a project that does not exist", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");

    const disabled = makeFakeDb([approved("a-6", deployPayload)], { [PROJECT]: { deployPolicy: { enabled: false } } });
    disabled.db._expectProject(PROJECT);
    await deployApprovalFeedbackService(disabled.db as any, { readStatusLog: () => [] }).tick(NOW);
    expect(mockApprovalService.addComment.mock.calls[0][1]).toContain("deploy settings are missing or switched off");

    mockApprovalService.addComment.mockClear();
    const missing = makeFakeDb([approved("a-7", deployPayload)], {});
    missing.db._expectProject(null);
    await deployApprovalFeedbackService(missing.db as any, { readStatusLog: () => [] }).tick(NOW);
    expect(mockApprovalService.addComment.mock.calls[0][1]).toContain("project that does not exist");
  });

  it("ignores approvals outside the window and non-deploy kinds even if the query handed them over", async () => {
    const { deployApprovalFeedbackService } = await import("../services/deploy-approval-feedback.js");
    const { db, updateCalls } = makeFakeDb([
      // Too fresh: approved 2 minutes ago.
      approved("fresh", deployPayload, new Date("2026-09-05T11:58:00Z")),
      // Too old: the status log is trimmed, so "no entry" means nothing for a 3-day-old card.
      approved("stale", deployPayload, new Date("2026-09-02T11:00:00Z")),
      // Not deploy-shaped at all.
      approved("merge", { kind: "merge_pr", prNumber: 1, repo: "acme/paperclip" }),
    ]);

    const result = await deployApprovalFeedbackService(db as any, { readStatusLog: () => [] }).tick(NOW);

    expect(result).toEqual({ checked: 0, flagged: 0 });
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});
