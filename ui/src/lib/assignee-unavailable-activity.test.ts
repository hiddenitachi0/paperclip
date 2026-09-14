import type { ActivityEvent } from "@paperclipai/shared";
import { ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, ASSIGNEE_UNAVAILABLE_RECORDED_ACTION } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { getEventTier } from "../components/ActivityFeed";
import { formatActivityVerb, formatIssueActivityAction, formatOperatorNotice, isOperatorNoticeAction } from "./activity-format";

// DUR-3973: the server writes these two actions (names shared with it through
// @paperclipai/shared, so neither side can be renamed alone). The recurring
// failure this guards is a notice the server writes and the feed never shows.
function event(action: string, details: Record<string, unknown>): ActivityEvent {
  return {
    id: `evt-${action}`,
    action,
    companyId: "company-1",
    entityType: "issue",
    entityId: "issue-1",
    createdAt: new Date("2026-09-14T09:00:00.000Z").toISOString(),
    details,
  } as unknown as ActivityEvent;
}

describe("waiting-on-unavailable-agent activity (DUR-3973)", () => {
  const sentence =
    'NOR-1289 "Add a supplier filter" is assigned to Automations, but Automations is switched off ' +
    '("Heartbeat on interval" and "Wake on demand" are both off in its settings), so nobody will start it. ' +
    'Switch Automations back on (turn on "Wake on demand" in its settings), or give the task to another agent.';

  it("shows the notice with its full sentence, without ticking 'show all activity'", () => {
    expect(isOperatorNoticeAction(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION)).toBe(true);
    expect(formatOperatorNotice(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, { message: sentence, taskCount: 1 })).toBe(sentence);
    expect(getEventTier(event(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, { message: sentence, taskCount: 1 }))).toBe(1);
  });

  it("reads as a sentence for one task and for a batch, never as the raw action key", () => {
    expect(formatActivityVerb(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, { taskCount: 1 })).toBe("flagged that nobody will start");
    expect(formatActivityVerb(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, { taskCount: 5 })).toBe("flagged tasks that nobody will start");
    expect(formatIssueActivityAction(ASSIGNEE_UNAVAILABLE_NOTICE_ACTION, { taskCount: 1 })).toBe(
      "flagged that nobody will start this task",
    );
  });

  it("keeps the per-task record quiet, so a backlog is one line in the feed, but readable on the task", () => {
    expect(isOperatorNoticeAction(ASSIGNEE_UNAVAILABLE_RECORDED_ACTION)).toBe(false);
    expect(getEventTier(event(ASSIGNEE_UNAVAILABLE_RECORDED_ACTION, { message: sentence }))).toBe(3);
    expect(formatActivityVerb(ASSIGNEE_UNAVAILABLE_RECORDED_ACTION)).toBe("recorded that the assigned agent cannot pick up");
    expect(formatIssueActivityAction(ASSIGNEE_UNAVAILABLE_RECORDED_ACTION)).toBe(
      "recorded that the assigned agent cannot pick this task up",
    );
  });
});
