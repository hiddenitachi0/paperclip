import type { GoalAdoptionSnapshot, GoalAdoptionTrendPoint } from "@paperclipai/shared";
import { api } from "./client";

export const goalAdoptionApi = {
  snapshot: (companyId: string) =>
    api.get<GoalAdoptionSnapshot>(`/companies/${companyId}/goal-adoption/snapshot`),
  trend: (companyId: string, days?: number) =>
    api.get<GoalAdoptionTrendPoint[]>(
      `/companies/${companyId}/goal-adoption/trend${days ? `?days=${days}` : ""}`,
    ),
};
