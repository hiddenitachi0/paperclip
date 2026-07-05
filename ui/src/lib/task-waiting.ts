import type { Issue } from "@paperclipai/shared";
import { blockedReasonLabel } from "./blockedInbox";

// Who is a blocked/parked task actually waiting on? Paperclip already computes a
// rich "blocked inbox attention" (owner + reason + action) for tasks it can
// classify; when present we trust its owner attribution. The Now view's
// "Needs you" lane must mean *you are the required next actor* — so we only
// route a task there when Paperclip explicitly attributes it to the user/board.
// Anything unattributed (owner "unknown", or a bare `blocked` with a prose
// reason and no structured blocker) is treated as PARKED, not "needs you": a
// task that genuinely needs Filip reaches him through an approval or an
// owner=user attribution, and over-notifying every parked task buried the real
// asks. Parked tasks still live on the board — they just don't scream here.

export type TaskWaitingOn = "you" | "agent" | "external" | "unknown";

export interface TaskWaiting {
  waitingOn: TaskWaitingOn;
  /** Short label for what's needed, e.g. "Needs decision", "Parked blocker". */
  label: string;
  /** Name of the agent/owner it's waiting on, when known. */
  ownerLabel: string | null;
}

export function classifyTaskWaiting(issue: Issue): TaskWaiting {
  const attention = issue.blockedInboxAttention;
  if (attention) {
    const label = attention.action?.label || blockedReasonLabel(attention.reason);
    const ownerLabel = attention.owner?.label ?? null;
    switch (attention.owner?.type) {
      case "user":
      case "board":
        return { waitingOn: "you", label, ownerLabel };
      case "agent":
        return { waitingOn: "agent", label, ownerLabel };
      case "external":
        return { waitingOn: "external", label, ownerLabel };
      default:
        // Unknown owner: Paperclip couldn't attribute the block to anyone. That
        // is not automatically the human's problem — parked behind another
        // agent's backlog work is theirs; anything else is parked until it
        // raises a concrete ask (an approval or a user-owned block).
        return {
          waitingOn: attention.reason === "blocked_by_assigned_backlog_issue" ? "agent" : "unknown",
          label,
          ownerLabel,
        };
    }
  }

  // No computed attention: the task was set to `blocked` manually.
  if (issue.blockedBy && issue.blockedBy.length > 0) {
    return { waitingOn: "agent", label: "Blocked by another task", ownerLabel: null };
  }
  // Bare block with a prose reason and no structured blocker — ambiguous. It's
  // the owning agent's / recovery system's to progress, not a human action item.
  return { waitingOn: "unknown", label: "Parked", ownerLabel: null };
}

/** A blocked task the user personally needs to act on. */
export function taskNeedsUser(issue: Issue): boolean {
  return classifyTaskWaiting(issue).waitingOn === "you";
}
