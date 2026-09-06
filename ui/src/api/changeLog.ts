import { api } from "./client";

export interface ChangeLogEntry {
  id: string;
  identifier: string;
  title: string;
  changeLogSummary: string | null;
  completedAt: string;
  priority: string;
  projectId: string | null;
  projectName: string | null;
}

export const changeLogApi = {
  list: (companyId: string, params: { projectId?: string; days?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.projectId) query.set("projectId", params.projectId);
    if (params.days) query.set("days", String(params.days));
    const qs = query.toString();
    return api.get<ChangeLogEntry[]>(
      `/companies/${companyId}/change-log${qs ? `?${qs}` : ""}`,
    );
  },
};
