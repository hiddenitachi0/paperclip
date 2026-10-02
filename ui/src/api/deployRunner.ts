import { api } from "./client";

export type ProjectDeployHistoryStatus = "ok" | "needs_attention";

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
  /** DUR-4233: "needs_attention" when the app deployed fine but a TLS/domain check flagged something. */
  status: ProjectDeployHistoryStatus;
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

export type ProjectDeployHistoryListStatus = "pass" | "fail";

export type ProjectDeployHistoryListEntry = {
  commit: string | null;
  approvalId: string;
  deployedAt: string;
  status: ProjectDeployHistoryListStatus;
};

export type ProjectDeployHistoryListFilters = {
  status?: ProjectDeployHistoryListStatus;
  /** Inclusive, as a bare date ("2026-09-01") or ISO timestamp. */
  from?: string;
  /** Inclusive, as a bare date ("2026-09-01") or ISO timestamp. */
  to?: string;
};

export type ProjectDeployHistoryListPage = {
  entries: ProjectDeployHistoryListEntry[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
};

export const deployRunnerApi = {
  projectDeployHistory: (companyId: string, projectId: string) =>
    api.get<ProjectDeployHistory>(`/companies/${companyId}/projects/${projectId}/deploy-history`),
  projectDeployHistoryList: (
    companyId: string,
    projectId: string,
    filters: ProjectDeployHistoryListFilters = {},
    page: { limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (page.limit !== undefined) params.set("limit", String(page.limit));
    if (page.offset !== undefined) params.set("offset", String(page.offset));
    const qs = params.toString();
    return api.get<ProjectDeployHistoryListPage>(
      `/companies/${companyId}/projects/${projectId}/deploy-history${qs ? `?${qs}` : ""}`,
    );
  },
};
