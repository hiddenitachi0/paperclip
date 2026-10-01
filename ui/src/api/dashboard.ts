import type { DashboardSummary, DashboardPulse } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  pulse: (companyId: string) => api.get<DashboardPulse>(`/companies/${companyId}/dashboard/pulse`),
};
