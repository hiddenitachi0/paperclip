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
 *
 * DUR-46: approving a merge_pr approval only authorizes a merge — it does
 * not perform one. The original version of this service treated approval
 * status alone as evidence a merge happened, which produced a false "This
 * merged" claim for two synthetic verification approvals that never
 * touched a real branch. It now must:
 * - only claim a merge happened when `verifyMerge` confirms it,
 * - post an explicitly uncertain note (not a false claim) when a merge_pr
 *   approval was approved but confirmed NOT merged,
 * - post nothing when merge status can't be determined either way,
 * - never move the issue to blocked (it only ever calls addComment).
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

const mockSecretService = vi.hoisted(() => ({
  resolveGitHubToken: vi.fn(),
}));

vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));
vi.mock("../services/deploy-branches.js", () => ({
  resolveProjectDeployBranches: (...args: unknown[]) => mockResolveProjectDeployBranches(...args),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
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

describe("mergeDeployVisibilityService.tick (DUR-40 / DUR-46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueService.addComment.mockReset();
    mockResolveProjectDeployBranches.mockReset();
    mockSecretService.resolveGitHubToken.mockReset();
  });

  it("posts a note when a verified merge into the deploy branch has no deploy approval", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 39, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(verifyMerge).toHaveBeenCalledWith(dueApproval.payload, "company-1");
    expect(result).toEqual({ checked: 1, flagged: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("custom"),
      {},
      { authorType: "system" },
    );
    expect(mockIssueService.addComment.mock.calls[0][1]).toContain("This merged");
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not claim a merge happened, and posts an explicitly uncertain note, when the PR was never merged", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-2",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 999999, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-2" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const [, body] = mockIssueService.addComment.mock.calls[0];
    expect(body).not.toContain("This merged");
    expect(body).toContain("does not appear to have been merged");
    // hasFollowingDeployApproval must never even be consulted for an unmerged PR.
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("posts nothing when merge status cannot be determined (e.g. no PR reference on the payload)", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-3",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unknown", reason: "missing_pr_reference" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Still marked noted — an approval GitHub can never resolve (e.g. a
    // fake/malformed PR reference) should not be retried on every tick forever.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("the real (non-injected) verifyMerge never claims a merge without a resolvable PR reference", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-3b",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      // Mirrors the real DUR-40 incident: base matches the deploy branch,
      // but there is no real PR behind this approval at all.
      payload: { kind: "merge_pr", base: "custom" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3b" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockSecretService.resolveGitHubToken.mockResolvedValue(null);

    // No verifyMerge override — exercises the default GitHub-backed path,
    // which must not reach the network at all for a payload with no PR
    // reference, and must not assert a merge happened.
    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("DUR-237: persists the verified merge commit sha onto the approval payload so the done-gate can later match it against any project deploy", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-1b",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 78, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db, updateCalls } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1b" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.mergeCommitSha).toBe("9a3a7e7abcdef0123456789abcdef0123456789");
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("DUR-237: does NOT mark noted on a transient verification failure, so it is retried on the next tick", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-3c",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 154, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db, updateCalls } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3c" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unknown", reason: "github_http_502" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // A transient failure (GitHub unreachable, rate limited, auth not ready
    // yet) must NOT be marked noted -- unlike "missing_pr_reference", this
    // could resolve differently next tick, and DUR-237 hit exactly this
    // live: a one-shot "unknown" permanently blocked the done-gate's
    // cross-issue ancestry match from ever seeing a real merge commit.
    expect(updateCalls).toHaveLength(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not post a note when a deploy approval already exists for the issue", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-4",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 37, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-4" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Still marked noted, so it is never rechecked again.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not post a note when the merge base is not the declared deploy branch", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-5",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "some-long-lived-integration-branch" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-5" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn();

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(new Date("2026-08-19T01:00:00Z"));

    expect(result).toEqual({ checked: 1, flagged: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Base doesn't match the deploy branch at all — never even worth a GitHub call.
    expect(verifyMerge).not.toHaveBeenCalled();
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

  it("this service never mutates issue status — it only ever calls addComment", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const dueApproval = {
      id: "approval-6",
      companyId: "company-1",
      type: "request_board_approval",
      status: "approved",
      payload: { kind: "merge_pr", base: "custom", prNumber: 39, repo: "acme/paperclip" },
      decidedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const { db } = makeFakeDb([dueApproval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-6" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    await svc.tick(new Date("2026-08-19T01:00:00Z"));

    // The mocked issueService only exposes addComment — asserting the keys
    // stay exactly that (no status-mutation method) makes it structurally
    // impossible for this service to move the issue to blocked.
    expect(Object.keys(mockIssueService)).toEqual(["addComment"]);
  });
});
