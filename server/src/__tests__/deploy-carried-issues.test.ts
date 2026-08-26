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

const COMPLETED_ENTRY = {
  ts: "t",
  approvalId: "deploy-approval-1",
  companyId: "company-1",
  commentDelivered: true,
  body: "Deployed to /root/paperclip -- commit 9a3a7e7abc is live and healthy (health check: http://x).",
};

function candidateRow(overrides: Partial<{ issueId: string; identifier: string | null; mergeCommitSha: string }> = {}) {
  const { issueId = "issue-1", identifier = "PAP-1", mergeCommitSha = "9a3a7e7abcdef0123456789abcdef0123456789" } =
    overrides;
  return {
    issueId,
    identifier,
    payload: { kind: "merge_pr", base: "custom", mergeCommitSha },
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
    expect(url).toContain("compare/1111111111111111111111111111111111111a...9a3a7e7abc");
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
});
