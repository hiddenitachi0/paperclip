import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  formatActivityVerb,
  formatIssueActivityAction,
  isApprovalDecisionAction,
  readActivityDecisionNote,
} from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });

  it("formats monitor activity with direct verbs", () => {
    expect(formatActivityVerb("issue.monitor_scheduled")).toBe("scheduled monitor on");
    expect(formatActivityVerb("issue.monitor_exhausted")).toBe("exhausted monitor on");
    expect(formatIssueActivityAction("issue.monitor_triggered")).toBe("triggered a monitor");
    expect(formatIssueActivityAction("issue.monitor_cleared")).toBe("cleared a monitor");
    expect(formatIssueActivityAction("issue.monitor_recovery_issue_created")).toBe("created a monitor recovery issue");
  });

  it("uses plain next-step copy for successful-run handoff activity", () => {
    expect(formatActivityVerb("issue.successful_run_handoff_required")).toBe("flagged missing next step on");
    expect(formatIssueActivityAction("issue.successful_run_handoff_required")).toBe("Run finished without a clear next step");
    expect(formatIssueActivityAction("issue.successful_run_handoff_resolved")).toBe("Next step chosen");
    expect(formatIssueActivityAction("issue.successful_run_handoff_escalated")).toBe(
      "Run finished without a next step - recovery escalated",
    );
  });

  // DUR-283: approval decisions are mirrored onto each linked issue as
  // issue.approval_<decision> entries carrying the operator's note.
  it("describes mirrored approval decisions on the issue in plain words", () => {
    expect(
      formatIssueActivityAction("issue.approval_rejected", {
        approvalId: "approval-1",
        approvalType: "merge_pr",
        decision: "rejected",
        decisionNote: "The migration drops a column we still read.",
      }),
    ).toBe("rejected the approval request (merge pull request)");
    expect(
      formatIssueActivityAction("issue.approval_revision_requested", { approvalType: "request_board_approval" }),
    ).toBe("sent the approval request back for changes (board approval)");
    expect(formatIssueActivityAction("issue.approval_approved", { approvalType: "some_new_kind" })).toBe(
      "approved the approval request (some new kind)",
    );
    expect(formatIssueActivityAction("issue.approval_approved", null)).toBe("approved the approval request");
    expect(formatActivityVerb("issue.approval_rejected")).toBe("rejected an approval request on");
    expect(formatActivityVerb("approval.revision_requested")).toBe("requested changes on");
  });

  it("reads the decision note only from approval decision entries", () => {
    expect(
      readActivityDecisionNote("approval.rejected", { type: "merge_pr", decisionNote: "  Not this week.  " }),
    ).toBe("Not this week.");
    expect(readActivityDecisionNote("issue.approval_revision_requested", { decisionNote: "Add the cost." })).toBe(
      "Add the cost.",
    );
    expect(readActivityDecisionNote("issue.approval_approved", { decisionNote: null })).toBeNull();
    expect(readActivityDecisionNote("issue.approval_approved", { decisionNote: "   " })).toBeNull();
    expect(readActivityDecisionNote("approval.approved", undefined)).toBeNull();
    // An unrelated entry with a stray decisionNote field must not be shown as a decision.
    expect(readActivityDecisionNote("issue.updated", { decisionNote: "nope" })).toBeNull();
    expect(isApprovalDecisionAction("approval.revision_requested")).toBe(true);
    expect(isApprovalDecisionAction("approval.created")).toBe(false);
  });
});
