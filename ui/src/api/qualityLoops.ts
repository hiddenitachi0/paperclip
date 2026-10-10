import type { CompanyQualityLoopSettings, UpdateCompanyQualityLoopSettings } from "@paperclipai/shared";
import { api } from "./client";

/** Agent quality loops: Company settings > Quality checks. */
export const qualityLoopsApi = {
  get: (companyId: string) => api.get<CompanyQualityLoopSettings>(`/companies/${companyId}/quality-loops/settings`),
  update: (companyId: string, body: UpdateCompanyQualityLoopSettings) =>
    api.patch<CompanyQualityLoopSettings>(`/companies/${companyId}/quality-loops/settings`, body),
};
