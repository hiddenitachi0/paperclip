import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  formatActivityVerb,
  formatIssueActivityAction,
  formatOperatorNotice,
  isOperatorNoticeAction,
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
});
