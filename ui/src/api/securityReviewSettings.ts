import type { SecurityReviewSettings } from "@paperclipai/shared";
import { api } from "./client";

/** DUR-4566: which agent is "the company's security reviewer" for the merge-card gate. */
export const securityReviewSettingsApi = {
  get: (companyId: string) => api.get<SecurityReviewSettings>(`/companies/${companyId}/security-review/settings`),
  setReviewerAgentId: (companyId: string, securityReviewerAgentId: string | null) =>
    api.patch<SecurityReviewSettings>(`/companies/${companyId}/security-review/settings`, {
      securityReviewerAgentId,
    }),
};
