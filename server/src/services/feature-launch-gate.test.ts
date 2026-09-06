/**
 * DUR-313 (DUR-299 point 2): an issue explicitly marked as a user-facing feature
 * launch must not reach `done` without an approved feature_launch approval -- the
 * one plain-language "what's new / where to find it / what to test / what if it
 * fails" card the operator approves, instead of the merges that preceded it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
}));

vi.mock("./issue-approvals.js", () => ({
  issueApprovalService: () => mockIssueApprovalService,
}));

const AGENT_ACTOR = { actorType: "agent", agentId: "agent-1", runId: "run-1" };
const BOARD_ACTOR = { actorType: "board", agentId: null, runId: null };
const ISSUE = { id: "issue-1", identifier: "DUR-500", featureLaunch: true };

const launchApproval = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "launch-approval-1",
  type: "request_board_approval",
  status: "approved",
  payload: { kind: "feature_launch", issueId: "issue-1" },
  ...overrides,
});

describe("evaluateFeatureLaunchDoneGate (DUR-313)", () => {
  // First `import("./feature-launch-gate.js")` in the file pays a real transform cost
  // (it pulls in deploy-completion-gate.ts for approvalPayloadKind) -- same pre-existing
  // characteristic documented in feature-launch-gate-routes.test.ts / deploy-completion-gate-routes.test.ts.
  // Default 5s is too tight under load.
  vi.setConfig({ testTimeout: 20000 });

  beforeEach(() => {
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
  });

  it("blocks done for an issue marked featureLaunch with no linked approval at all", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: undefined,
    });

    expect(result).not.toBeNull();
    expect(result?.message).toContain("DUR-500");
    expect(result?.message).toContain("feature_launch");
  });

  it("blocks done when a feature_launch approval was filed but is still pending", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([launchApproval({ status: "pending" })]);

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: undefined,
    });

    expect(result).not.toBeNull();
  });

  it("allows done once an approved feature_launch approval is linked", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([launchApproval()]);

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: undefined,
    });

    expect(result).toBeNull();
  });

  it("never fires for an issue that isn't marked featureLaunch (bugfixes/cleanup, DUR-299 points 7-8)", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: { id: "issue-2", identifier: "DUR-501", featureLaunch: false },
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: undefined,
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("fires when this same request is what marks the issue featureLaunch (requestedFeatureLaunch wins over the stored value)", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: { id: "issue-3", identifier: "DUR-502", featureLaunch: false },
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: true,
    });

    expect(result).not.toBeNull();
  });

  it("never fires for a board actor -- a human can always override, same split as the other done-gates", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: BOARD_ACTOR,
      requestedStatus: "done",
      currentStatus: "in_review",
      requestedFeatureLaunch: undefined,
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("never fires for a transition that isn't into done", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "in_review",
      currentStatus: "in_progress",
      requestedFeatureLaunch: undefined,
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("never fires when the issue is already done", async () => {
    const { evaluateFeatureLaunchDoneGate } = await import("./feature-launch-gate.js");

    const result = await evaluateFeatureLaunchDoneGate({
      db: {} as any,
      issue: ISSUE,
      actor: AGENT_ACTOR,
      requestedStatus: "done",
      currentStatus: "done",
      requestedFeatureLaunch: undefined,
    });

    expect(result).toBeNull();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });
});
