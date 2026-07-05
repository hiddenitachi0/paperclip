import type { Issue } from "@paperclipai/shared";
import { blockedReasonLabel } from "./blockedInbox";

// Who is a blocked/parked task actually waiting on? Paperclip already computes a
// rich "blocked inbox attention" (owner + reason + action) for tasks it can
// classify; when present we trust it. For tasks an agent simply set to
// `blocked` with a prose reason (no structured blocker), we fall back: a
// blocked task with a blocker is waiting on that blocker's owner (another
// agent); otherwise the agent stopped and needs a human decision.

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
        // Unknown owner: a stuck task with no clear next actor surfaces to the
        // human — better to over-notify than to hide a stalled task — unless it
        // is specifically parked behind another agent's backlog work.
        return {
          waitingOn: attention.reason === "blocked_by_assigned_backlog_issue" ? "agent" : "you",
          label,
          ownerLabel,
        };
    }
  }

  // No computed attention: the task was set to `blocked` manually.
  if (issue.blockedBy && issue.blockedBy.length > 0) {
    return { waitingOn: "agent", label: "Blocked by another task", ownerLabel: null };
  }
  return { waitingOn: "you", label: "Needs your input", ownerLabel: null };
}

/** A blocked task the user personally needs to act on. */
export function taskNeedsUser(issue: Issue): boolean {
  return classifyTaskWaiting(issue).waitingOn === "you";
}
