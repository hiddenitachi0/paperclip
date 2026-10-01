import { api } from "./client";

// Mirrors server/src/services/deploy-runner-status.ts's DeployRunnerStatusEntry.
export type DeployRunnerStatusEntry = {
  ts: string;
  approvalId: string;
  companyId: string;
  commentDelivered: boolean;
  body: string;
  outcome?: string;
  commit?: string;
};

export type DeployRunnerStatusStreamEvent =
  | { type: "snapshot"; entries: DeployRunnerStatusEntry[] }
  | { type: "entries"; entries: DeployRunnerStatusEntry[] };

export type ProjectDeployHistoryEntry = {
  /** The commit the deploy runner put live, as it logged it (usually a 12-char short sha). */
  commit: string;
  approvalId: string;
  deployedAt: string;
};

export type ProjectDeployHistory = {
  /** What is live right now, per the runner's most recent successful deploy. */
  current: ProjectDeployHistoryEntry | null;
  /** What was live before `current` -- the version the one-click rollback button goes back to. */
  previous: ProjectDeployHistoryEntry | null;
  /**
   * DUR-4232: every retained release, newest first (bounded by the project's
   * releaseRetentionCount). `releases[0]`/`releases[1]` are the same entries as
   * `current`/`previous`. Optional because older cached/mocked responses may not
   * include it yet.
   */
  releases?: ProjectDeployHistoryEntry[];
};

export const deployRunnerApi = {
  projectDeployHistory: (companyId: string, projectId: string) =>
    api.get<ProjectDeployHistory>(`/companies/${companyId}/projects/${projectId}/deploy-history`),
};
