import type { ProjectDeployHistoryEntry } from "../api/deployRunner";
import { timeAgo } from "./timeAgo";

/**
 * DUR-3952 follow-up: the one place the "Roll back to previous version"
 * button's approval card is written. It files an ordinary deploy approval
 * (kind "deploy", the only kind scripts/deploy-runner.sh acts on) for the
 * version that was live before the current one, with `allowBackwardDeploy`
 * set so the runner's backward-deploy guard (DUR-137) lets it through.
 * Nothing moves until the board approves the card; the note says exactly
 * what approving does, in plain words, so the card never reads like a
 * normal forward deploy.
 */

export function shortSha(commit: string): string {
  return commit.trim().slice(0, 8);
}

export function rollbackDeployTitle(previous: ProjectDeployHistoryEntry): string {
  return `Roll production back to ${shortSha(previous.commit)}`;
}

export function rollbackDeployNote(previous: ProjectDeployHistoryEntry, current: ProjectDeployHistoryEntry): string {
  return (
    `Approving moves production back to ${shortSha(previous.commit)}, the version that was live before ` +
    `${shortSha(current.commit)}. Everything that shipped with ${shortSha(current.commit)} stops being live ` +
    `until a newer version is deployed again. Rejecting leaves ${shortSha(current.commit)} running.`
  );
}

export function buildRollbackDeployApproval(input: {
  projectId: string;
  workspaceId: string;
  current: ProjectDeployHistoryEntry;
  previous: ProjectDeployHistoryEntry;
}): { type: "request_board_approval"; payload: Record<string, unknown> } {
  return {
    type: "request_board_approval",
    payload: {
      kind: "deploy",
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      commit: input.previous.commit,
      title: rollbackDeployTitle(input.previous),
      note: rollbackDeployNote(input.previous, input.current),
      allowBackwardDeploy: true,
    },
  };
}

/** The question the operator sees before the card is filed. */
export function rollbackConfirmText(previous: ProjectDeployHistoryEntry, current: ProjectDeployHistoryEntry): string {
  return (
    `File a rollback request to ${shortSha(previous.commit)}?\n\n` +
    `Nothing changes yet: this creates an approval card. Approving that card moves production back to ` +
    `${shortSha(previous.commit)}, the version that was live before ${shortSha(current.commit)}.`
  );
}

/**
 * DUR-4232: same mechanics as buildRollbackDeployApproval, for any older retained
 * release (not just the one immediately before `current`). Kept separate so the
 * wording never overclaims "live right before" for a release several versions back.
 */
export function olderReleaseRollbackTitle(target: ProjectDeployHistoryEntry): string {
  return `Roll production back to ${shortSha(target.commit)}`;
}

export function olderReleaseRollbackNote(target: ProjectDeployHistoryEntry, current: ProjectDeployHistoryEntry): string {
  return (
    `Approving moves production back to ${shortSha(target.commit)}, an earlier release deployed ${timeAgo(target.deployedAt)}. ` +
    `Everything that shipped after it, including the version live now (${shortSha(current.commit)}), stops being live until a ` +
    `newer version is deployed again. Rejecting leaves ${shortSha(current.commit)} running.`
  );
}

export function buildOlderReleaseRollbackApproval(input: {
  projectId: string;
  workspaceId: string;
  current: ProjectDeployHistoryEntry;
  target: ProjectDeployHistoryEntry;
}): { type: "request_board_approval"; payload: Record<string, unknown> } {
  return {
    type: "request_board_approval",
    payload: {
      kind: "deploy",
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      commit: input.target.commit,
      title: olderReleaseRollbackTitle(input.target),
      note: olderReleaseRollbackNote(input.target, input.current),
      allowBackwardDeploy: true,
    },
  };
}

export function olderReleaseRollbackConfirmText(target: ProjectDeployHistoryEntry, current: ProjectDeployHistoryEntry): string {
  return (
    `File a rollback request to ${shortSha(target.commit)}?\n\n` +
    `Nothing changes yet: this creates an approval card. Approving that card moves production back to ` +
    `${shortSha(target.commit)}, an earlier release than the version live now (${shortSha(current.commit)}).`
  );
}
