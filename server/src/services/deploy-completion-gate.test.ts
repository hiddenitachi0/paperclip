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
  payload: { kind: "merge_pr", base: "custom" },
  ...overrides,
});

const deployApproval = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "deploy-approval-1",
  type: "request_board_approval",
  status: "approved",
  payload: { kind: "deploy", projectId: "project-1" },
  ...overrides,
});

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
});
