import type { StalledTasksResult } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Open tasks nobody is moving: the Now page's fifth "Needs you" source. One
 * server call returns the rows ready to render (the page polls every few
 * seconds, so there is deliberately no per-task fan-out from the browser),
 * already stripped of anything the page shows through another source.
 */
export const stalledTasksApi = {
  listForCompany: (companyId: string) =>
    api.get<StalledTasksResult>(`/companies/${companyId}/stalled-tasks`),
};
