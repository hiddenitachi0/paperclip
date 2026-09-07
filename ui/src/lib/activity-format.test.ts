import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  formatActivityVerb,
  formatIssueActivityAction,
  formatOperatorNotice,
  isApprovalDecisionAction,
  isOperatorNoticeAction,
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

  // DUR-98: platform-written notices read as sentences, never as raw action keys.
  it("gives the watchdog and agent-error notices plain-language verbs", () => {
    expect(formatActivityVerb("heartbeat.run_reaped")).toBe("ended a run that had stopped responding for");
    expect(formatActivityVerb("agent.entered_error")).toBe("flagged that attention is needed for");
    expect(formatActivityVerb("agent.error_stalled")).toBe("is still waiting for someone to clear the error on");
    expect(formatIssueActivityAction("heartbeat.run_reaped")).toBe("ended a run that had stopped responding");
    // DUR-3940 item 2: the frozen-run / run-cap watchdog notice.
    expect(formatActivityVerb("heartbeat.run_stopped")).toBe("stopped a run that was taking too long for");
    expect(formatIssueActivityAction("heartbeat.run_stopped")).toBe("stopped a run that was taking too long");
    expect(isOperatorNoticeAction("heartbeat.run_stopped")).toBe(true);
    // DUR-3943 item 4: repeated turn-limit stops on one task.
    expect(formatActivityVerb("heartbeat.turn_limit_repeated")).toBe(
      "stopped queuing fresh runs after repeated turn-limit stops for",
    );
    expect(formatIssueActivityAction("heartbeat.turn_limit_repeated")).toBe(
      "stopped queuing fresh runs after repeated turn-limit stops",
    );
    expect(isOperatorNoticeAction("heartbeat.turn_limit_repeated")).toBe(true);
    expect(
      formatOperatorNotice("heartbeat.turn_limit_repeated", {
        message: "Backend Engineer hit the limit of 60 turns per run on \"Cut agent context cost\" (DUR-3943) 3 times in a row.",
      }),
    ).toContain("3 times in a row");
    // Polish round 3: the daily check of the shared Claude sign-in.
    expect(formatActivityVerb("instance.claude_auth.check_failed")).toBe("found that the shared Claude sign-in stopped working");
    expect(formatActivityVerb("instance.claude_auth.expiring")).toBe("warned that the shared Claude sign-in expires soon");
    expect(formatIssueActivityAction("instance.claude_auth.saved")).toBe("saved the shared Claude sign-in");
    expect(isOperatorNoticeAction("instance.claude_auth.check_failed")).toBe(true);
    expect(isOperatorNoticeAction("instance.claude_auth.expiring")).toBe(true);
    expect(isOperatorNoticeAction("instance.claude_auth.saved")).toBe(false);
    expect(
      formatOperatorNotice("instance.claude_auth.expiring", { message: "The shared Claude sign-in expires in about 2 days." }),
    ).toBe("The shared Claude sign-in expires in about 2 days.");
  });

  // Admin auth hardening: security notices about operator accounts render
  // their server-written sentence, and never fall back to a raw action key.
  it("treats admin-account security entries as operator notices with plain verbs", () => {
    expect(isOperatorNoticeAction("security.admin_added_outside_app")).toBe(true);
    expect(isOperatorNoticeAction("security.admin_signed_in_new_device")).toBe(true);
    expect(isOperatorNoticeAction("security.signed_out_everywhere")).toBe(true);
    expect(
      formatOperatorNotice("security.admin_password_changed_outside_app", {
        message: "The password for instance admin Filip was changed without going through the app.",
      }),
    ).toBe("The password for instance admin Filip was changed without going through the app.");
    expect(formatActivityVerb("security.admin_added_outside_app")).toBe("noticed a new instance admin added outside the app:");
    expect(formatActivityVerb("security.admin_promoted")).toBe("made an instance admin of");
    expect(formatActivityVerb("security.admin_record_tampered")).not.toContain("security.");
    expect(isOperatorNoticeAction("security.admin_record_baseline")).toBe(true);
    expect(formatActivityVerb("security.admin_record_baseline")).toBe("took a fresh record of the admin list");
  });

  it("surfaces the server-written message for operator notices only", () => {
    expect(isOperatorNoticeAction("heartbeat.run_reaped")).toBe(true);
    expect(isOperatorNoticeAction("issue.updated")).toBe(false);
    expect(
      formatOperatorNotice("heartbeat.run_reaped", { message: "  CodexCoder's run stopped. Paperclip ended it.  " }),
    ).toBe("CodexCoder's run stopped. Paperclip ended it.");
    expect(formatOperatorNotice("issue.updated", { message: "not a notice" })).toBeNull();
    expect(formatOperatorNotice("heartbeat.run_reaped", { message: "" })).toBeNull();
    expect(formatOperatorNotice("heartbeat.run_reaped", null)).toBeNull();
  });

  it("treats a failed persona post as an operator notice (DUR-134 item 10)", () => {
    expect(isOperatorNoticeAction("persona_post.publish_failed")).toBe(true);
    expect(isOperatorNoticeAction("persona_post.published")).toBe(false);
    expect(
      formatOperatorNotice("persona_post.publish_failed", {
        message: "A post to Maja — Fanvue could not be published and will not be retried on its own. Reason: token expired.",
      }),
    ).toBe("A post to Maja — Fanvue could not be published and will not be retried on its own. Reason: token expired.");
    expect(
      formatOperatorNotice("persona_post.publish_failed", { accountLabel: "Maja — Fanvue", failureReason: "token expired" }),
    ).toBe("A post to Maja — Fanvue could not be published and will not be retried on its own. Reason: token expired");
    expect(formatActivityVerb("persona_post.published")).toBe("published a post for");
  });

  it("builds a sentence for legacy stall alerts that carry no message", () => {
    expect(
      formatOperatorNotice("agent.error_stalled", { agentName: "Reviewer Bot", errorReason: "Adapter crashed" }),
    ).toBe(
      "Reviewer Bot has been stopped with an error for a while and nobody has cleared it yet. Its tasks are waiting. Last error: Adapter crashed",
    );
    expect(formatOperatorNotice("agent.error_stalled", {})).toBe(
      "This agent has been stopped with an error for a while and nobody has cleared it yet. Its tasks are waiting.",
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
