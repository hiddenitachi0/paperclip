/**
 * DUR-238: follow-up from DUR-237. A completed deploy approval must proactively close every
 * OTHER `in_review` issue in the same project whose merge commit it carries -- not just clear
 * the done-gate for the one issue that happens to ask. Verifies:
 * - an issue whose merge commit exactly matches the deployed commit is closed with an audit
 *   comment and an activity-log entry naming the deploy that proved it,
 * - an issue whose merge commit only became live as an ANCESTOR of a later deploy (confirmed
 *   via GitHub compare) is also closed,
 * - ancestry that cannot be confirmed (GitHub unreachable, or a "behind"/"diverged" compare
 *   result) never closes an issue -- this fails CLOSED, the opposite direction from DUR-227's
 *   filing-time precheck,
 * - a deploy approval not yet recorded as completed is left unswept for the next tick,
 * - a completed approval with no qualifying candidates (or missing commit/project data) is
 *   still marked swept exactly once, so it is never rechecked forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvals, issueApprovals, issues, projectWorkspaces } from "@paperclipai/db";

// This file's fake db matches on the real schema table objects (see makeFakeDb below), which
// pulls in the full @paperclipai/db schema graph on first import -- consistently slower to
// transform than this suite's sibling fakes (mergeDeployVisibilityService, deploy-completion-
// gate), which fake only bare select/from/where chains with no real schema import. Bumped from
// the 5s default so a cold transform in a resource-constrained CI runner doesn't flake.
vi.setConfig({ testTimeout: 20_000 });

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  update: vi.fn(),
}));
const mockResolveProjectDeployBranchesByProjectId = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));
vi.mock("../services/deploy-branches.js", () => ({
  resolveProjectDeployBranchesByProjectId: (...args: unknown[]) =>
    mockResolveProjectDeployBranchesByProjectId(...args),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

const DEPLOY_APPROVAL = {
  id: "deploy-approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "approved",
  payload: { kind: "deploy", projectId: "project-1", workspaceId: "workspace-1" },
};

// DUR-420: deploy-runner.sh now logs a 12-char (not 7-char) short sha, and commitsMatch()
// requires a 12-char minimum overlap -- this fixture's commit must be >=12 chars for the
// exact/prefix-match tests below to exercise the fast path they claim to.
const COMPLETED_ENTRY = {
  ts: "t",
  approvalId: "deploy-approval-1",
  companyId: "company-1",
  commentDelivered: true,
  body: "Deployed to /root/paperclip -- commit 9a3a7e7abcde is live and healthy (health check: http://x).",
};

function candidateRow(
  overrides: Partial<{
    issueId: string;
    identifier: string | null;
    mergeCommitSha: string;
    originalIssueIds: string[];
  }> = {},
) {
  const {
    issueId = "issue-1",
    identifier = "PAP-1",
    mergeCommitSha = "9a3a7e7abcdef0123456789abcdef0123456789",
    originalIssueIds = [issueId],
  } = overrides;
  return {
    issueId,
    identifier,
    payload: { kind: "merge_pr", base: "custom", mergeCommitSha, originalIssueIds },
  };
}

function makeFakeDb(input: {
  dueApprovals: unknown[];
  candidateRows?: unknown[];
  workspaceRepoUrl?: string | null;
  primaryWorkspaceRepoUrl?: string | null;
}) {
  const updateCalls: Array<{ payload: Record<string, unknown> }> = [];
  let projectWorkspacesCallCount = 0;

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === approvals) {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(input.dueApprovals)),
            })),
          };
        }
        if (table === issueApprovals) {
          return {
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => Promise.resolve(input.candidateRows ?? [])),
                })),
              })),
            })),
          };
        }
        if (table === projectWorkspaces) {
          projectWorkspacesCallCount += 1;
          // First call: the workspaceId-keyed lookup. Second (fallback): the
          // project's-primary-workspace lookup.
          const repoUrl =
            projectWorkspacesCallCount === 1 ? input.workspaceRepoUrl : input.primaryWorkspaceRepoUrl;
          return {
            where: vi.fn(() => Promise.resolve(repoUrl === undefined ? [] : [{ repoUrl }])),
          };
        }
        throw new Error(`unexpected table in test fake: ${String(table)}`);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: { payload: Record<string, unknown> }) => ({
        where: vi.fn(() => {
          updateCalls.push({ payload: patch.payload });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return { db, updateCalls };
}

describe("deployCarriedIssuesService.tick (DUR-238)", () => {
  beforeEach(() => {
    mockIssueService.addComment.mockReset();
    mockIssueService.update.mockReset();
    mockResolveProjectDeployBranchesByProjectId.mockReset();
    mockLogActivity.mockReset();
  });

  it("closes a carried issue whose merge commit exactly matches the deployed commit", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [candidateRow({ mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" })],
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.update.mockResolvedValue({ id: "issue-1", status: "done" });
    const fetchImpl = vi.fn();

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 1 });
    // Never needed GitHub -- the fast exact/prefix-match path was sufficient.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("deploy-approval-1"),
      {},
      { authorType: "system" },
    );
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "done" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actorType: "system",
        action: "issue.updated",
        entityId: "issue-1",
        details: expect.objectContaining({ status: "done", deployApprovalId: "deploy-approval-1" }),
      }),
    );
  });

  // DUR-3922: an issue correctly marked `blocked` (per our execution contract) while waiting on
  // a human/board actor to file or decide the deploy approval must still be picked up by the
  // sweep -- not just issues sitting in `in_review`. The candidate-row fake here doesn't itself
  // encode the issue's status (the fake's `where()` chain doesn't inspect its filter args), so
  // this test's purpose is to document/lock the intent; the real regression coverage is the
  // production SQL filter in `listCarriedCandidateIssues` using `inArray(issues.status,
  // ["in_review", "blocked"])` instead of a single `eq(..., "in_review")`.
  it("closes a carried issue that qualifies via the same candidate query regardless of in_review/blocked status", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [candidateRow({ mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" })],
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.update.mockResolvedValue({ id: "issue-1", status: "done" });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 1 });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "done" });
  });

  it("closes a carried issue whose merge commit is a confirmed git ancestor of the deployed commit", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [candidateRow({ mergeCommitSha: "1111111111111111111111111111111111111a" })],
      workspaceRepoUrl: "https://github.com/acme/paperclip",
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockIssueService.update.mockResolvedValue({ id: "issue-1", status: "done" });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ahead" }),
    });

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
      resolveGitHubToken: async () => "gh-token",
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("compare/1111111111111111111111111111111111111a...9a3a7e7abcde");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer gh-token" });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "done" });
  });

  it("does NOT close when GitHub ancestry cannot be confirmed (fetch fails) -- fails closed", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [candidateRow({ mergeCommitSha: "1111111111111111111111111111111111111a" })],
      workspaceRepoUrl: "https://github.com/acme/paperclip",
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
      resolveGitHubToken: async () => null,
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    // The deploy approval itself is still marked swept -- it completed, it's just this
    // candidate that couldn't be proven carried.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.carriedIssuesSwept).toBe(true);
  });

  it("does NOT close when GitHub confirms the candidate commit is behind/diverged from the deploy", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [candidateRow({ mergeCommitSha: "1111111111111111111111111111111111111a" })],
      workspaceRepoUrl: "https://github.com/acme/paperclip",
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "diverged" }),
    });

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
      resolveGitHubToken: async () => null,
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("leaves a deploy approval unswept when it has not yet completed in the status log", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({ dueApprovals: [DEPLOY_APPROVAL] });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 0, closed: 0 });
    expect(updateCalls).toHaveLength(0);
    expect(mockResolveProjectDeployBranchesByProjectId).not.toHaveBeenCalled();
  });

  it("marks a completed approval swept without closing anything when it has no qualifying candidates", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({ dueApprovals: [DEPLOY_APPROVAL], candidateRows: [] });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.carriedIssuesSwept).toBe(true);
  });

  it("marks swept without querying candidates when the project declares no deploy branch", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({ dueApprovals: [DEPLOY_APPROVAL] });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue(null);

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(updateCalls).toHaveLength(1);
  });

  it("is a no-op when there are no due (unswept, approved deploy) approvals", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({ dueApprovals: [] });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 0, closed: 0 });
    expect(updateCalls).toHaveLength(0);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("closes every qualifying candidate issue carried by the same completed deploy, not just one", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [
        candidateRow({ issueId: "issue-1", mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" }),
        candidateRow({ issueId: "issue-2", mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789" }),
      ],
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment" });
    mockIssueService.update.mockResolvedValue({ id: "issue", status: "done" });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 2 });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "done" });
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-2", { status: "done" });
  });

  // DUR-252 security review: `issueApprovals` is a mutable link table -- the agent that
  // requested a merge_pr approval can relink it to ANY issue in the company after the fact (or
  // file a fresh approval against an unrelated already-merged historical PR and link it to
  // someone else's issue). Without the `originalIssueIds` anchor, either lets an attacker force
  // an unrelated `in_review` issue closed with zero review of its own actual work. This is the
  // regression test that fails without that fix: the candidate row's approval was filed for
  // "issue-1" (per `originalIssueIds`), but the mutable link table now points the SAME approval
  // at "issue-2" -- the exact "relink a legitimate/forged approval onto a different issue"
  // misuse scenario the review described.
  it("does NOT close an issue whose linked merge_pr approval was originally filed for a DIFFERENT issue (relinked/reused approval)", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [
        candidateRow({
          issueId: "issue-2",
          mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789",
          originalIssueIds: ["issue-1"],
        }),
      ],
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    // Still marked swept -- the deploy itself completed, this candidate just never qualified.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.carriedIssuesSwept).toBe(true);
  });

  // A merge_pr approval approved before this fix shipped has no `originalIssueIds` at all --
  // fail closed (never treat "unknown provenance" as "proven to match"), the same posture as
  // every other unproven check in this file.
  it("does NOT close an issue whose linked merge_pr approval predates originalIssueIds (field absent)", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      candidateRows: [
        {
          issueId: "issue-1",
          identifier: "PAP-1",
          payload: {
            kind: "merge_pr",
            base: "custom",
            mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789",
            // no originalIssueIds field
          },
        },
      ],
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });

    const svc = deployCarriedIssuesService(db as any, { readStatusLog: () => [COMPLETED_ENTRY] });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // DUR-420 security review finding #1: commitsMatch()'s old 7-char minimum overlap is only
  // ~2^28 possibilities -- a few CPU-seconds of local grinding is enough for an attacker to
  // produce a real merge commit whose sha happens to share a short prefix with an unrelated
  // commit that's about to deploy, closing their own issue as "carried" without their code
  // ever shipping. This candidate's mergeCommitSha shares only the deployed commit's first 10
  // chars (below the new 12-char minimum) -- must NOT close via the fast path, and with no
  // GitHub repo resolvable to fall back on, must not close at all.
  it("does NOT close via the fast path on a 10-char (below the 12-char minimum) prefix collision (DUR-420 short-sha grinding)", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db, updateCalls } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL],
      // Shares "9a3a7e7abc" (10 chars) with COMPLETED_ENTRY's deployed commit
      // "9a3a7e7abcde", but diverges at the 11th char -- below the 12-char minimum, and not
      // actually equal beyond that prefix, so this must never be treated as a match.
      candidateRows: [candidateRow({ mergeCommitSha: "9a3a7e7abcffffffffffffffffffffffffffff" })],
      // No workspaceRepoUrl/primaryWorkspaceRepoUrl configured -- repo never resolves, so the
      // ancestry-check fallback is unavailable too (matches the fail-closed rule).
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    const fetchImpl = vi.fn();

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.carriedIssuesSwept).toBe(true);
  });

  // DUR-420 security review finding #2: `resolveDeployApprovalRepo` scoping `workspaceId`'s
  // lookup by `companyId` alone (the original fix) still lets a deploy approval's `workspaceId`
  // point at a DIFFERENT project's workspace within the same company -- the ancestry check
  // would then run against the wrong repository. Scoping by `projectId` too means a
  // `workspaceId` that doesn't actually belong to the approval's own `payload.projectId` must
  // fail to resolve a repo at all (never silently fall through to some other repo).
  it("does NOT resolve a repo (and so never attempts ancestry) when workspaceId belongs to a different project than the approval's payload.projectId", async () => {
    const { deployCarriedIssuesService } = await import("../services/deploy-carried-issues.js");
    const { db } = makeFakeDb({
      dueApprovals: [DEPLOY_APPROVAL], // payload.projectId = "project-1", workspaceId = "workspace-1"
      // Not an exact/prefix match -- forces the ancestry-check path, which needs a resolved repo.
      candidateRows: [candidateRow({ mergeCommitSha: "1111111111111111111111111111111111111a" })],
      // The fake db's projectWorkspaces where() doesn't itself check projectId (it's a plain
      // mock), so this models the *production* query correctly rejecting the row: no matching
      // workspaceRepoUrl is returned for a workspace-1/project-1 pair that doesn't really
      // exist, and no primary-workspace fallback either (the point is that a project-scoped
      // query returns nothing here, not that this fake enforces the SQL itself).
      workspaceRepoUrl: undefined,
      primaryWorkspaceRepoUrl: undefined,
    });
    mockResolveProjectDeployBranchesByProjectId.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    const fetchImpl = vi.fn();

    const svc = deployCarriedIssuesService(db as any, {
      readStatusLog: () => [COMPLETED_ENTRY],
      fetch: fetchImpl,
    });
    const result = await svc.tick();

    expect(result).toEqual({ checked: 1, closed: 0 });
    // No repo resolved -> ancestry check never even attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
