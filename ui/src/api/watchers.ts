import type {
  CreateWatcherInput,
  UpdateWatcherInput,
  WatcherAlertSummary,
  WatcherSummary,
} from "@paperclipai/shared";
import { api } from "./client";

// Watchers: scheduled market-price checks that alert on Telegram, in a quick
// agent's voice, only when a rule fires. A source key never travels through
// this client: `keySecretId` names the company secret that holds it.

export const watchersApi = {
  list: (companyId: string) => api.get<WatcherSummary[]>(`/companies/${companyId}/watchers`),
  create: (companyId: string, input: Partial<CreateWatcherInput>) =>
    api.post<WatcherSummary>(`/companies/${companyId}/watchers`, input),
  update: (companyId: string, watcherId: string, patch: UpdateWatcherInput) =>
    api.patch<WatcherSummary>(`/companies/${companyId}/watchers/${watcherId}`, patch),
  remove: (companyId: string, watcherId: string) => api.delete<void>(`/companies/${companyId}/watchers/${watcherId}`),
  testAlert: (companyId: string, watcherId: string) =>
    api.post<WatcherAlertSummary>(`/companies/${companyId}/watchers/${watcherId}/test`, {}),
};
