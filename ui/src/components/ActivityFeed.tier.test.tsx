import type { ActivityEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { getEventTier } from "./ActivityFeed";
import { isOperatorNoticeAction } from "../lib/activity-format";

/**
 * DUR-3965. The activity feed hides tier-3 events behind the "show all
 * activity" tick. Operator notices -- an expiring sign-in, an instance left
 * paused after a failed deploy -- are exactly the events the operator has to
 * see without going looking, so they must never land in tier 3.
 *
 * The first review of DUR-3965 shipped a notice the operator could not see:
 * the action was written by the server but registered in none of the UI maps.
 * These tests guard the same gap in the feed, and they are written against
 * isOperatorNoticeAction rather than a hardcoded list so a notice added later
 * is covered the day it is added.
 */
function event(action: string): ActivityEvent {
  return {
    id: `evt-${action}`,
    action,
    companyId: "company-1",
    entityType: "instance_settings",
    entityId: "instance",
    createdAt: new Date("2026-09-10T13:20:00.000Z").toISOString(),
    details: { message: "Everything is paused." },
  } as unknown as ActivityEvent;
}

describe("activity feed tiers", () => {
  const NOTICES = ["instance.quiet_mode_stuck", "instance.claude_auth.expiring"];

  it.each(NOTICES)("shows %s without the operator ticking 'show all activity'", (action) => {
    // Guards the premise: if these stop being operator notices the assertion
    // below would pass vacuously.
    expect(isOperatorNoticeAction(action)).toBe(true);
    expect(getEventTier(event(action))).not.toBe(3);
  });

  it("keeps ordinary chatter out of the way", () => {
    expect(getEventTier(event("cost.reported"))).toBe(3);
  });

  it("still treats an unknown action as hidden-by-default chatter", () => {
    expect(isOperatorNoticeAction("some.future.debug.event")).toBe(false);
    expect(getEventTier(event("some.future.debug.event"))).toBe(3);
  });
});
