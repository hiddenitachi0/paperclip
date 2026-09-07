import { api } from "./client";

export type ProjectDeployHistoryEntry = {
  /** The commit the deploy runner put live, as it logged it (usually a 12-char short sha). */
  commit: string;
  approvalId: string;
  deployedAt: string;
};

export type ProjectDeployHistory = {
  /** What is live right now, per the runner's most recent successful deploy. */
  current: ProjectDeployHistoryEntry | null;
  /** What was live before `current` -- the version a rollback goes back to. */
  previous: ProjectDeployHistoryEntry | null;
};

export const deployRunnerApi = {
  projectDeployHistory: (companyId: string, projectId: string) =>
    api.get<ProjectDeployHistory>(`/companies/${companyId}/projects/${projectId}/deploy-history`),
};
