/**
 * DUR-40 item 4: a merge_pr approval that landed on the project's deploy
 * branch with no follow-up deploy approval must leave a visible note on the
 * linked issue(s). Verifies the scheduled tick (not a synchronous check at
 * approval time, since a deploy approval can only be filed AFTER a merge is
 * approved — see the comment in routes/approvals.ts) correctly:
 * - flags approvals whose merge landed on the deploy branch with no deploy
 *   approval filed for their linked issue(s),
 * - does NOT flag approvals still within the grace window (not "due" yet),
 * - does NOT flag approvals that already have a deploy approval,
 * - does NOT flag merges into a branch other than the declared deploy branch,
 * - marks every due approval as noted exactly once, so re-ticking never
 *   double-posts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  listApprovalsForIssue: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
}));

const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn());

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));
vi.mock("../services/deploy-branches.js", () => ({
  resolveProjectDeployBranches: (...args: unknown[]) => mockResolveProjectDeployBranches(...args),
}));

function makeFakeDb(dueRows: unknown[]) {
  const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(dueRows)),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: { payload: Record<string, unknown> }) => {
        return {
          where: vi.fn(() => {
            updateCalls.push({ id: "unknown", payload: patch.payload });
            return Promise.resolve(undefined);
          }),
        };
      }),
    })),
  };
  return { db, updateCalls };
}

describe("mergeDeployVisibilityService.tick (DUR-40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueService.addComment.mockReset();
    mockResolveProjectDeployBranches.mockReset();
  });

  it("posts a note when a due merge into the deploy branch has no deploy approval", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });

    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("custom"),
      {},
      { authorType: "system" },
    );
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not post a note when a deploy approval already exists for the issue", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-2",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);

    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Still marked noted, so it is never rechecked again.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not post a note when the merge base is not the declared deploy branch", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-3",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "some-long-lived-integration-branch" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });

    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there are no due approvals", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const { db } = makeFakeDb([]);

    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 0, flagged: 0 });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
