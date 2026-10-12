import { api } from "./client";

export interface CacheSettings {
  companyId: string;
  enabled: boolean;
  schedulingEnabled: boolean;
  handoffEnabled: boolean;
  handoffTokenThreshold: number;
  cacheLifetimeMinutes: number | null;
}

export type CacheSettingsPatch = Partial<Omit<CacheSettings, "companyId">>;

export const cacheSettingsApi = {
  get: (companyId: string) =>
    api.get<{ settings: CacheSettings }>(`/companies/${companyId}/cache-settings`).then((r) => r.settings),
  update: (companyId: string, patch: CacheSettingsPatch) =>
    api.put<{ settings: CacheSettings }>(`/companies/${companyId}/cache-settings`, patch).then((r) => r.settings),
};
