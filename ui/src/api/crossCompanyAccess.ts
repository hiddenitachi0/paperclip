import type { CrossCompanyAccessLogPage } from "@paperclipai/shared";
import { api } from "./client";

export interface CrossCompanyAccessQuery {
  /** Inclusive, ISO date-time. */
  from?: string | null;
  /** Exclusive, ISO date-time. */
  to?: string | null;
  cursor?: string | null;
  limit?: number;
  showRoutine?: boolean;
}

export const crossCompanyAccessApi = {
  list: (query: CrossCompanyAccessQuery) => {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.showRoutine) params.set("routine", "show");
    const qs = params.toString();
    return api.get<CrossCompanyAccessLogPage>(`/instance/cross-company-access${qs ? `?${qs}` : ""}`);
  },
};
