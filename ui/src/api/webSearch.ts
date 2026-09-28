import type { CompanyWebSearchSettings } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Company settings → Connections → Web search. The key is picked by secret id;
 * no call here ever sends or returns its value.
 */
export const webSearchApi = {
  get: (companyId: string) =>
    api.get<CompanyWebSearchSettings>(`/companies/${encodeURIComponent(companyId)}/web-search`),
  setKey: (companyId: string, secretId: string | null) =>
    api.put<CompanyWebSearchSettings>(`/companies/${encodeURIComponent(companyId)}/web-search`, { secretId }),
};
