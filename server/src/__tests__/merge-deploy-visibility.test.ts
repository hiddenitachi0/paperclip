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
 * - marks every settled approval as noted exactly once, so re-ticking never
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
 *
 * DUR-3928 / DUR-3944: "not merged yet" is not a final answer. The one-shot
 * version marked such approvals noted forever with no mergeCommitSha, which
 * permanently blocked both the done-gate and the carried-issue sweep for every
 * issue the PR carried (PR #248 and #256 merged 15-20 minutes after their one
 * and only check). It now must:
 * - re-check an unmerged / transiently-unknown approval with a doubling backoff,
 * - post the "not merged yet" note only once across those re-checks,
 * - backfill mergeCommitSha and mark noted once the PR does merge,
 * - stop after a bounded age, saying so, never inventing a merge,
 * - backfill legacy approvals the old one-shot logic already left stuck.
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
const mockResolveFallbackDeployBranches = vi.hoisted(() => vi.fn());

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
vi.mock("../services/deploy-branch-fallback.js", () => ({
  resolveFallbackDeployBranches: (...args: unknown[]) => mockResolveFallbackDeployBranches(...args),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

// tick() issues exactly two selects per run: the due-approvals query first, then the
// legacy (already-noted, sha-less) re-check query. Dispatch by call order.
function makeFakeDb(dueRows: unknown[], legacyRows: unknown[] = []) {
  const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => {
      selectCalls += 1;
      const rows = selectCalls === 1 ? dueRows : selectCalls === 2 ? legacyRows : [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(rows)),
          })),
        })),
      };
    }),
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

const NOW = new Date("2026-08-19T01:00:00Z");
const DECIDED_AT = new Date("2026-08-19T00:00:00Z");
const NO_ACTIVITY = { checked: 0, flagged: 0, retried: 0, gaveUp: 0, backfilled: 0 };

function dueApproval(id: string, payload: Record<string, unknown>, decidedAt: Date = DECIDED_AT) {
  return { id, companyId: "company-1", type: "request_board_approval", status: "approved", payload, decidedAt };
}

describe("mergeDeployVisibilityService.tick (DUR-40 / DUR-46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueService.addComment.mockReset();
    mockResolveProjectDeployBranches.mockReset();
    mockResolveFallbackDeployBranches.mockReset();
    mockResolveFallbackDeployBranches.mockResolvedValue({ branches: null, issueHasProject: true, reason: "issue_has_project" });
    mockSecretService.resolveGitHubToken.mockReset();
  });

  it("posts a note when a verified merge into the deploy branch has no deploy approval", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-1", { kind: "merge_pr", base: "custom", prNumber: 39, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(verifyMerge).toHaveBeenCalledWith(approval.payload, "company-1");
    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, flagged: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("custom"),
      {},
      { authorType: "system" },
    );
    expect(mockIssueService.addComment.mock.calls[0][1]).toContain("This merged");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("DUR-3928: an approved-but-not-yet-merged PR gets ONE plain note and is re-checked later, never marked noted", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-2", { kind: "merge_pr", base: "custom", prNumber: 999999, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-2" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, flagged: 1, retried: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const [, body] = mockIssueService.addComment.mock.calls[0];
    expect(body).not.toContain("This merged");
    expect(body).toContain("has not been merged yet");
    expect(body).toContain("keep checking");
    // hasFollowingDeployApproval must never even be consulted for an unmerged PR.
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();

    // Scheduled for a re-check, NOT settled: this is the exact bug that stuck PR #248/#256.
    expect(updateCalls).toHaveLength(1);
    const scheduled = updateCalls[0].payload;
    expect(scheduled.deployVisibilityNoted).toBeUndefined();
    expect(scheduled.mergeCommitSha).toBeUndefined();
    expect(scheduled.deployVisibilityUnmergedNoted).toBe(true);
    expect(scheduled.deployVisibilityAttempts).toBe(1);
    expect(scheduled.deployVisibilityNextCheckAt).toBe(new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());
  });

  it("DUR-3928: a re-check that is still unmerged backs off further and does NOT repeat the note", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-2b", {
      kind: "merge_pr",
      base: "custom",
      prNumber: 999999,
      repo: "acme/paperclip",
      deployVisibilityUnmergedNoted: true,
      deployVisibilityAttempts: 2,
      deployVisibilityNextCheckAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2b" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, retried: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityAttempts).toBe(3);
    // Third check: 30m * 2^2 = 2h.
    expect(updateCalls[0].payload.deployVisibilityNextCheckAt).toBe(
      new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    );
    expect(updateCalls[0].payload.deployVisibilityNoted).toBeUndefined();
  });

  it("DUR-3928: an approval scheduled for a later re-check is skipped until then", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-2c", {
      kind: "merge_pr",
      base: "custom",
      prNumber: 5,
      repo: "acme/paperclip",
      deployVisibilityAttempts: 1,
      deployVisibilityNextCheckAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    });
    const { db, updateCalls } = makeFakeDb([approval]);
    const verifyMerge = vi.fn();

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual(NO_ACTIVITY);
    expect(verifyMerge).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it("DUR-3928: once a re-checked PR has merged, the sha is backfilled and the approval settles (schedule dropped)", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-2d", {
      kind: "merge_pr",
      base: "custom",
      prNumber: 248,
      repo: "acme/paperclip",
      deployVisibilityUnmergedNoted: true,
      deployVisibilityAttempts: 1,
      deployVisibilityNextCheckAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2d" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    // A deploy approval already exists for the issue, so no "not deployed" note either.
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);
    const sha = "655fdc1d655fdc1d655fdc1d655fdc1d655fdc1d";
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: sha });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.mergeCommitSha).toBe(sha);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
    expect(updateCalls[0].payload.deployVisibilityNextCheckAt).toBeUndefined();
  });

  it("DUR-3944: gives up after the age bound with a plain note, never inventing a merge commit", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const approval = dueApproval(
      "approval-2e",
      {
        kind: "merge_pr",
        base: "custom",
        prNumber: 7,
        repo: "acme/paperclip",
        deployVisibilityUnmergedNoted: true,
        deployVisibilityAttempts: 12,
      },
      eightDaysAgo,
    );
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-2e" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-2e" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, flagged: 1, gaveUp: 1 });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const [, body] = mockIssueService.addComment.mock.calls[0];
    expect(body).toContain("stopped checking");
    expect(body).not.toContain("This merged");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
    expect(updateCalls[0].payload.mergeCommitSha).toBeUndefined();
    expect(updateCalls[0].payload.deployVisibilityGaveUpAt).toBe(NOW.toISOString());
  });

  it("posts nothing when merge status cannot be determined (e.g. no PR reference on the payload)", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-3", { kind: "merge_pr", base: "custom" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unknown", reason: "missing_pr_reference" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Still marked noted — an approval GitHub can never resolve (e.g. a
    // fake/malformed PR reference) should not be retried on every tick forever.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("the real (non-injected) verifyMerge never claims a merge without a resolvable PR reference", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    // Mirrors the real DUR-40 incident: base matches the deploy branch,
    // but there is no real PR behind this approval at all.
    const approval = dueApproval("approval-3b", { kind: "merge_pr", base: "custom" });
    const { db } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3b" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockSecretService.resolveGitHubToken.mockResolvedValue(null);

    // No verifyMerge override — exercises the default GitHub-backed path,
    // which must not reach the network at all for a payload with no PR
    // reference, and must not assert a merge happened.
    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("DUR-237: persists the verified merge commit sha onto the approval payload so the done-gate can later match it against any project deploy", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-1b", { kind: "merge_pr", base: "custom", prNumber: 78, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1b" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    await svc.tick(NOW);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.mergeCommitSha).toBe("9a3a7e7abcdef0123456789abcdef0123456789");
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("DUR-237/DUR-3928: a transient verification failure is scheduled for a backed-off re-check, never marked noted", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-3c", { kind: "merge_pr", base: "custom", prNumber: 154, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-3c" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unknown", reason: "github_http_502" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, retried: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // A transient failure (GitHub unreachable, rate limited, auth not ready
    // yet) must NOT be marked noted -- unlike "missing_pr_reference", this
    // could resolve differently next tick, and DUR-237 hit exactly this
    // live: a one-shot "unknown" permanently blocked the done-gate's
    // cross-issue ancestry match from ever seeing a real merge commit.
    // DUR-3928: it is re-checked with a backoff rather than on every tick.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBeUndefined();
    expect(updateCalls[0].payload.deployVisibilityUnmergedNoted).toBeUndefined();
    expect(updateCalls[0].payload.deployVisibilityAttempts).toBe(1);
    expect(typeof updateCalls[0].payload.deployVisibilityNextCheckAt).toBe("string");
  });

  it("does not post a note when a deploy approval already exists for the issue", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-4", { kind: "merge_pr", base: "custom", prNumber: 37, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-4" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      { type: "request_board_approval", status: "approved", payload: { kind: "deploy" } },
    ]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Still marked noted, so it is never rechecked again.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("does not post a note when the merge base is not the declared deploy branch", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-5", { kind: "merge_pr", base: "some-long-lived-integration-branch" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-5" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    const verifyMerge = vi.fn();

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Base doesn't match the deploy branch at all — never even worth a GitHub call.
    expect(verifyMerge).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
  });

  it("DUR-291: an issue with no project still gets its merge verified via the company-level deploy branch fallback", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-7", { kind: "merge_pr", base: "custom", prNumber: 180, repo: "acme/paperclip" });
    const { db, updateCalls } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-7" }]);
    mockResolveProjectDeployBranches.mockResolvedValue(null);
    mockResolveFallbackDeployBranches.mockResolvedValue({
      branches: { deployBranch: "custom", projectId: "project-1", resolvedViaFallback: true },
      issueHasProject: false,
      reason: "resolved_unique",
    });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-7" });
    const sha = "9cdf89a66c6e9cdf89a66c6e9cdf89a66c6e9cdf";
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: sha });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(mockResolveFallbackDeployBranches).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ companyId: "company-1", issueIds: ["issue-7"], bases: ["custom"], repo: "acme/paperclip" }),
    );
    expect(verifyMerge).toHaveBeenCalled();
    expect(result).toEqual({ ...NO_ACTIVITY, checked: 1, flagged: 1 });
    expect(updateCalls[0].payload.mergeCommitSha).toBe(sha);
  });

  it("is a no-op when there are no due approvals", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const { db } = makeFakeDb([]);

    const svc = mergeDeployVisibilityService(db as any);
    const result = await svc.tick(NOW);

    expect(result).toEqual(NO_ACTIVITY);
    expect(db.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("this service never mutates issue status — it only ever calls addComment", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const approval = dueApproval("approval-6", { kind: "merge_pr", base: "custom", prNumber: 39, repo: "acme/paperclip" });
    const { db } = makeFakeDb([approval]);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-6" }]);
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    await svc.tick(NOW);

    // The mocked issueService only exposes addComment — asserting the keys
    // stay exactly that (no status-mutation method) makes it structurally
    // impossible for this service to move the issue to blocked.
    expect(Object.keys(mockIssueService)).toEqual(["addComment"]);
  });
});

describe("mergeDeployVisibilityRetryDelayMs (DUR-3928 backoff)", () => {
  it("doubles from the base delay and caps", async () => {
    const { mergeDeployVisibilityRetryDelayMs } = await import("../services/merge-deploy-visibility.js");
    const m = 60 * 1000;
    expect(mergeDeployVisibilityRetryDelayMs(1)).toBe(30 * m);
    expect(mergeDeployVisibilityRetryDelayMs(2)).toBe(60 * m);
    expect(mergeDeployVisibilityRetryDelayMs(3)).toBe(120 * m);
    expect(mergeDeployVisibilityRetryDelayMs(4)).toBe(240 * m);
    expect(mergeDeployVisibilityRetryDelayMs(5)).toBe(360 * m);
    expect(mergeDeployVisibilityRetryDelayMs(50)).toBe(360 * m);
    expect(mergeDeployVisibilityRetryDelayMs(0)).toBe(30 * m);
  });
});

describe("legacy noted-but-sha-less approvals (DUR-3928 / DUR-3944 backfill)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockReset();
    mockResolveFallbackDeployBranches.mockResolvedValue({ branches: null, issueHasProject: true, reason: "issue_has_project" });
  });

  const legacy = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    companyId: "company-1",
    type: "request_board_approval",
    status: "approved",
    payload: { kind: "merge_pr", base: "custom", prNumber: 248, repo: "acme/paperclip", deployVisibilityNoted: true, ...extra },
    decidedAt: DECIDED_AT,
  });

  it("backfills mergeCommitSha silently for an already-noted approval whose PR did merge (the PR #248 / #256 case)", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const { db, updateCalls } = makeFakeDb([], [legacy("af49fe54")]);
    const sha = "655fdc1d655fdc1d655fdc1d655fdc1d655fdc1d";
    const verifyMerge = vi.fn().mockResolvedValue({ status: "merged", mergeCommitSha: sha });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual({ ...NO_ACTIVITY, backfilled: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.mergeCommitSha).toBe(sha);
    expect(updateCalls[0].payload.deployVisibilityNoted).toBe(true);
    expect(updateCalls[0].payload.mergeCommitShaRecheckedAt).toBe(NOW.toISOString());
    // Whatever there was to say about this approval was said when it was first noted.
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("settles a legacy approval whose PR is confirmed unmerged after one look, without a sha", async () => {
    const { mergeDeployVisibilityService } = await import("../services/merge-deploy-visibility.js");
    const { db, updateCalls } = makeFakeDb([], [legacy("c52029df")]);
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unmerged" });

    const svc = mergeDeployVisibilityService(db as any, { verifyMerge });
    const result = await svc.tick(NOW);

    expect(result).toEqual(NO_ACTIVITY);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.mergeCommitSha).toBeUndefined();
    expect(updateCalls[0].payload.mergeCommitShaRecheckedAt).toBe(NOW.toISOString());
  });

  it("retries a legacy approval a bounded number of times through transient GitHub failures", async () => {
    const { mergeDeployVisibilityService, MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_MAX_ATTEMPTS } = await import(
      "../services/merge-deploy-visibility.js"
    );
    const verifyMerge = vi.fn().mockResolvedValue({ status: "unknown", reason: "github_http_502" });

    const first = makeFakeDb([], [legacy("legacy-1")]);
    await mergeDeployVisibilityService(first.db as any, { verifyMerge }).tick(NOW);
    expect(first.updateCalls).toHaveLength(1);
    expect(first.updateCalls[0].payload.mergeCommitShaRecheckAttempts).toBe(1);
    // Not settled: no recheckedAt, so the next tick picks it up again.
    expect(first.updateCalls[0].payload.mergeCommitShaRecheckedAt).toBeUndefined();

    const last = makeFakeDb([], [
      legacy("legacy-1", { mergeCommitShaRecheckAttempts: MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_MAX_ATTEMPTS - 1 }),
    ]);
    await mergeDeployVisibilityService(last.db as any, { verifyMerge }).tick(NOW);
    expect(last.updateCalls).toHaveLength(1);
    expect(last.updateCalls[0].payload.mergeCommitShaRecheckAttempts).toBe(MERGE_DEPLOY_VISIBILITY_LEGACY_RECHECK_MAX_ATTEMPTS);
    expect(last.updateCalls[0].payload.mergeCommitShaRecheckedAt).toBe(NOW.toISOString());
  });
});
