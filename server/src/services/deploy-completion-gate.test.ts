/**
 * DUR-99: an issue whose only completing action was a merge into the project's declared
 * deploy branch must not reach `done` on the strength of that merge alone -- reproduces the
 * DUR-98 Class C shape (merged, no deploy ever followed, ticket still read `done`) as a gate
 * that refuses the transition outright rather than merely commenting after the fact
 * (merge-deploy-visibility.ts's job).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
}));
const mockResolveProjectDeployBranches = vi.hoisted(() => vi.fn());

vi.mock("./issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));
vi.mock("./deploy-branches.js", () => ({
  resolveProjectDeployBranches: (...args: unknown[]) => mockResolveProjectDeployBranches(...args),
}));

const AGENT_ACTOR = { actorType: "agent", agentId: "agent-1", runId: "run-1" };
const BOARD_ACTOR = { actorType: "board", agentId: null, runId: null };
const ISSUE = { id: "issue-1", identifier: "PAP-99", companyId: "company-1" };

const mergeApproval = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "merge-approval-1",
  type: "request_board_approval",
  status: "approved",
  // originalIssueIds defaults to [ISSUE.id]: this represents an approval genuinely filed for
  // the issue under test (DUR-252) -- tests of the *other* case (an approval filed for a
  // different issue) set payload.originalIssueIds explicitly.
  payload: { kind: "merge_pr", base: "custom", originalIssueIds: [ISSUE.id] },
  ...overrides,
});

const deployApproval = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "deploy-approval-1",
  type: "request_board_approval",
  status: "approved",
  payload: { kind: "deploy", projectId: "project-1" },
  ...overrides,
});

// DUR-237: mirrors listApprovedProjectDeployApprovalIds' drizzle chain
// (db.select({id}).from(approvals).where(...)) with a plain array of rows.
function fakeDbWithProjectDeployApprovalIds(ids: string[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(ids.map((id) => ({ id }))),
      }),
    }),
  } as any;
}

describe("evaluateDeployCompletionDoneGate (DUR-99)", () => {
  beforeEach(() => {
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockResolveProjectDeployBranches.mockReset();
  });

  it("reproduces the DUR-98 Class C incident: merged into the deploy branch, no deploy approval at all -- blocks done", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", mirrorBranch: "master" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval()]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("custom");
    expect(result?.message).toContain("no deploy approval has been filed");
  });

  it("blocks done when a deploy approval was filed but deploy-runner never recorded completing it", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval(), deployApproval()]);
    const readStatusLog = vi.fn().mockReturnValue([
      { ts: "t", approvalId: "deploy-approval-1", companyId: "company-1", commentDelivered: true, body: "Deploy failed -- health check timed out." },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("has not yet recorded it completing");
  });

  it("allows done when deploy-runner's status log confirms the linked deploy approval went live", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval(), deployApproval()]);
    const readStatusLog = vi.fn().mockReturnValue([
      {
        ts: "t",
        approvalId: "deploy-approval-1",
        companyId: "company-1",
        commentDelivered: true,
        body: "Deployed to /root/paperclip -- commit abc123 is live and healthy (health check: http://x).",
      },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    expect(result).toBeNull();
  });

  it("DUR-152: allows done when the linked deploy approval was superseded but deploy-runner confirmed its commit shipped as part of a different deploy", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval(), deployApproval()]);
    // This approval's own comment never contains the runner's literal success sentence --
    // it was never the one that actually ran the deploy -- but the runner independently
    // confirmed via git ancestry that its commit is live, and recorded that as a structured
    // outcome rather than free text.
    const readStatusLog = vi.fn().mockReturnValue([
      {
        ts: "t",
        approvalId: "deploy-approval-1",
        companyId: "company-1",
        commentDelivered: true,
        body: "Skipped -- a newer deploy approval (deploy-approval-2) for the same project/workspace was approved in this poll cycle and ran instead. This approval's own target commit (abc123) is already reachable from what's now live, so its change shipped as part of deploy-approval-2's deploy -- see deploy-approval-2 for that deploy's outcome.",
        outcome: "carried",
        commit: "abc123",
      },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    expect(result).toBeNull();
  });

  it("DUR-152: a plain 'skipped, superseded' entry with no confirmed outcome still blocks done", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval(), deployApproval()]);
    const readStatusLog = vi.fn().mockReturnValue([
      {
        ts: "t",
        approvalId: "deploy-approval-1",
        companyId: "company-1",
        commentDelivered: true,
        body: "Skipped -- a newer deploy approval (deploy-approval-2) for the same project/workspace was approved in this poll cycle and will run instead, to avoid two resets racing on the same checkout.",
      },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("has not yet recorded it completing");
  });

  it("DUR-116: does not let a completed deploy approval filed for a DIFFERENT project clear the gate", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      mergeApproval(),
      deployApproval({ id: "deploy-approval-other-project", payload: { kind: "deploy", projectId: "project-2" } }),
    ]);
    const readStatusLog = vi.fn().mockReturnValue([
      {
        ts: "t",
        approvalId: "deploy-approval-other-project",
        companyId: "company-1",
        commentDelivered: true,
        body: "Deployed to /root/paperclip -- commit abc123 is live and healthy (health check: http://x).",
      },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("no deploy approval has been filed");
  });

  it("is unaffected when the issue has no deploy branch declared for its project", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue(null);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  // DUR-252 security review (defense in depth, same root cause as the deploy-carried-issues.ts
  // fix): `issueApprovals` is a mutable link table -- the agent that requested a merge_pr
  // approval can relink it to a DIFFERENT issue than the one it was actually filed for.
  // `originalIssueIds` (stamped once at creation, routes/approvals.ts) anchors which issue(s)
  // an approval genuinely completes; a linked approval whose originalIssueIds does not include
  // THIS issue must never count as this issue's completing merge, even though the mutable link
  // table says it's linked and a deploy for it completed.
  it("DUR-252: does not treat a merge_pr approval linked here but originally filed for a DIFFERENT issue as this issue's completing merge", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      mergeApproval({ payload: { kind: "merge_pr", base: "custom", originalIssueIds: ["some-other-issue"] } }),
      deployApproval(),
    ]);
    const readStatusLog = vi.fn().mockReturnValue([
      {
        ts: "t",
        approvalId: "deploy-approval-1",
        companyId: "company-1",
        commentDelivered: true,
        body: "Deployed to /root/paperclip -- commit abc123 is live and healthy (health check: http://x).",
      },
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      readStatusLog,
    });

    // Same outcome as "no merge_pr approval linked at all" -- the gate does not treat this as
    // evidence of a completed deploy for THIS issue (a relinked approval must never provide
    // false reassurance), so it falls through to the ordinary self-certification path rather
    // than blocking on stale/borrowed deploy evidence.
    expect(result).toBeNull();
  });

  it("is unaffected when the issue has no merge_pr approval into the deploy branch at all", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
  });

  it("does not block a merge into a branch other than the declared deploy branch", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      mergeApproval({ payload: { kind: "merge_pr", base: "some-feature-branch" } }),
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
  });

  it("does not fire for a board/human actor -- the operator can always override", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: BOARD_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
    expect(mockResolveProjectDeployBranches).not.toHaveBeenCalled();
  });

  it("does not fire for a transition to in_review -- that is the intended safe holding status", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "in_review",
      currentStatus: "todo",
    });

    expect(result).toBeNull();
    expect(mockResolveProjectDeployBranches).not.toHaveBeenCalled();
  });

  it("does not re-fire when the issue is already done (no-op transition)", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "done",
    });

    expect(result).toBeNull();
    expect(mockResolveProjectDeployBranches).not.toHaveBeenCalled();
  });

  it("does not treat a rejected or pending merge_pr approval as a completing merge", async () => {
    const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
    mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom" });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      mergeApproval({ status: "pending" }),
      mergeApproval({ id: "merge-approval-2", status: "rejected" }),
    ]);

    const result = await evaluateDeployCompletionDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
    });

    expect(result).toBeNull();
  });

  describe("DUR-237: recognizes a commit deployed under a DIFFERENT issue's approval", () => {
    it("allows done when this issue has no deploy approval of its own, but its merge commit already shipped under another approval for the same project", async () => {
      const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
      mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
      mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
        mergeApproval({
          payload: {
            kind: "merge_pr",
            base: "custom",
            mergeCommitSha: "9a3a7e7abcdef0123456789abcdef0123456789",
            originalIssueIds: [ISSUE.id],
          },
        }),
      ]);
      const readStatusLog = vi.fn().mockReturnValue([
        {
          ts: "t",
          approvalId: "some-other-issues-deploy-approval",
          companyId: "company-1",
          commentDelivered: true,
          // DUR-420: commitsMatch() now requires a 12-char minimum overlap (deploy-runner.sh
          // logs --short=12 going forward) -- this fixture must be >=12 chars to exercise the
          // legitimate-match path this test claims to.
          body: "Deployed to /root/paperclip -- commit 9a3a7e7abcde is live and healthy (health check: http://x).",
        },
      ]);

      const result = await evaluateDeployCompletionDoneGate({
        db: fakeDbWithProjectDeployApprovalIds(["some-other-issues-deploy-approval"]),
        issue: ISSUE,
        actor: AGENT_ACTOR,
        requestedStatus: "done",
        currentStatus: "in_review",
        readStatusLog,
      });

      expect(result).toBeNull();
    });

    // DUR-420 security review finding #1: a 10-char prefix collision (below the 12-char
    // minimum) must NOT be treated as a match -- see the matching regression test/comment in
    // deploy-carried-issues.test.ts for the full grinding-attack threat model.
    it("still blocks done when the shipped commit only shares a 10-char prefix with this issue's merge commit (below the anti-collision minimum)", async () => {
      const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
      mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
      mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
        mergeApproval({
          payload: {
            kind: "merge_pr",
            base: "custom",
            mergeCommitSha: "9a3a7e7abcffffffffffffffffffffffffffff",
            originalIssueIds: [ISSUE.id],
          },
        }),
      ]);
      const readStatusLog = vi.fn().mockReturnValue([
        {
          ts: "t",
          approvalId: "some-other-issues-deploy-approval",
          companyId: "company-1",
          commentDelivered: true,
          body: "Deployed to /root/paperclip -- commit 9a3a7e7abcde is live and healthy (health check: http://x).",
        },
      ]);

      const result = await evaluateDeployCompletionDoneGate({
        db: fakeDbWithProjectDeployApprovalIds(["some-other-issues-deploy-approval"]),
        issue: ISSUE,
        actor: AGENT_ACTOR,
        requestedStatus: "done",
        currentStatus: "in_review",
        readStatusLog,
      });

      expect(result).not.toBeNull();
      expect(result?.message).toContain("no deploy approval has been filed");
    });

    it("still blocks done when no project deploy approval's shipped commit matches this issue's merge commit", async () => {
      const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
      mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
      mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
        mergeApproval({
          payload: {
            kind: "merge_pr",
            base: "custom",
            mergeCommitSha: "deadbeef00000000000000000000000000000000",
            originalIssueIds: [ISSUE.id],
          },
        }),
      ]);
      const readStatusLog = vi.fn().mockReturnValue([
        {
          ts: "t",
          approvalId: "some-other-issues-deploy-approval",
          companyId: "company-1",
          commentDelivered: true,
          body: "Deployed to /root/paperclip -- commit 9a3a7e7 is live and healthy (health check: http://x).",
        },
      ]);

      const result = await evaluateDeployCompletionDoneGate({
        db: fakeDbWithProjectDeployApprovalIds(["some-other-issues-deploy-approval"]),
        issue: ISSUE,
        actor: AGENT_ACTOR,
        requestedStatus: "done",
        currentStatus: "in_review",
        readStatusLog,
      });

      expect(result).not.toBeNull();
      expect(result?.message).toContain("no deploy approval has been filed");
    });

    it("does not run the broader project-wide check at all when the merge approval has no mergeCommitSha yet (merge-deploy-visibility hasn't ticked)", async () => {
      const { evaluateDeployCompletionDoneGate } = await import("./deploy-completion-gate.js");
      mockResolveProjectDeployBranches.mockResolvedValue({ deployBranch: "custom", projectId: "project-1" });
      mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([mergeApproval()]);
      const db = fakeDbWithProjectDeployApprovalIds(["irrelevant"]);
      const selectSpy = vi.spyOn(db, "select");

      const result = await evaluateDeployCompletionDoneGate({
        db,
        issue: ISSUE,
        actor: AGENT_ACTOR,
        requestedStatus: "done",
        currentStatus: "in_review",
      });

      expect(result).not.toBeNull();
      expect(selectSpy).not.toHaveBeenCalled();
    });
  });
});
