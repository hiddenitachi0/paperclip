import type { Issue } from "@paperclipai/shared";

// Statuses where a task a person owns is still theirs to do. Backlog is left
// out on purpose: a parked idea is not something that is waiting on them.
export const ASSIGNED_TO_YOU_STATUSES = "todo,in_progress,in_review,blocked";

const OPEN_STATUSES = new Set(ASSIGNED_TO_YOU_STATUSES.split(","));

/**
 * The Now page's sixth "Needs you" source: plain open tasks that were handed
 * to the signed-in person. None of the other five sources catches these -- a
 * task with a person as its assignee has no live run, approval, question or
 * blocker attached -- so without this a task made for Filip sits unseen.
 *
 * The list is requested for "me", so the server has already narrowed it to the
 * signed-in person; `currentUserId` is a second check for when it is known.
 * `alreadyShownIssueIds` holds every task another source already shows, so the
 * same task never appears (or counts) twice.
 */
export function selectAssignedToYou(
  issues: readonly Issue[] | undefined,
  currentUserId: string | null | undefined,
  alreadyShownIssueIds: ReadonlySet<string>,
): Issue[] {
  if (!issues) return [];
  return issues
    .filter(
      (issue) =>
        Boolean(issue.assigneeUserId)
        && (!currentUserId || issue.assigneeUserId === currentUserId)
        && !issue.assigneeAgentId
        && !issue.hiddenAt
        && OPEN_STATUSES.has(issue.status)
        && !alreadyShownIssueIds.has(issue.id),
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
