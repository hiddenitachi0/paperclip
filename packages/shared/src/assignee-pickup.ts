// DUR-3973: a task assigned to an agent that can never be woken used to wait
// forever in silence while the recovery sweep re-dispatched it every 30
// seconds (10,178 rejected wake-ups for one task in five days). These are the
// names the server writes and the UI reads, kept in one place so the two can
// never disagree about them.

/**
 * Why an assigned agent cannot pick its task up. Each one has its own plain
 * sentence and its own "what to do" (see server/src/services/operator-notices.ts);
 * a terminated agent, for example, is never told to be "switched back on".
 */
export const ASSIGNEE_UNAVAILABLE_REASONS = [
  /** Both "Heartbeat on interval" and "Wake on demand" are off in its settings. */
  "switched_off",
  "paused",
  /** Paused by the budget hard stop. */
  "paused_for_budget",
  "terminated",
  "pending_approval",
  /** The agent it reports to is terminated or missing, or the reporting line loops. */
  "reporting_line_broken",
  "unknown_status",
] as const;

export type AssigneeUnavailableReason = (typeof ASSIGNEE_UNAVAILABLE_REASONS)[number];

/**
 * The operator notice (Activity feed, always shown): one per company per
 * recovery sweep, covering every task that newly turned out to be waiting on
 * an agent that cannot pick it up. Its sentence is in `details.message`.
 */
export const ASSIGNEE_UNAVAILABLE_NOTICE_ACTION = "issue.assignee_unavailable_notice";

/**
 * The per-task record that the notice above has been given for this task and
 * this assignee, so it is never given twice. Written on the task itself, and
 * deliberately NOT an operator notice: when a notice covers many tasks at once
 * the operator gets one line, not one line per task.
 */
export const ASSIGNEE_UNAVAILABLE_RECORDED_ACTION = "issue.assignee_unavailable_recorded";

/**
 * Task statuses the notice and the fleet-health count cover. `in_review`
 * waits on a reviewer rather than the assignee and keeps its own existing
 * handling; `blocked`/`backlog` are not expected to start on their own.
 */
export const ASSIGNEE_PICKUP_WAITING_ISSUE_STATUSES = ["todo", "in_progress"] as const;
