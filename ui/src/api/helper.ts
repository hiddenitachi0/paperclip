import type {
  HelperAskRequest,
  HelperAskResponse,
  HelperSettingsView,
  UpdateHelperSettings,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * "Ask Paperclip" helper. Keys are picked by secret id; no call here ever
 * sends or returns a key's value.
 */
export const helperApi = {
  ask: (companyId: string, body: HelperAskRequest) =>
    api.post<HelperAskResponse>(`/companies/${encodeURIComponent(companyId)}/helper/ask`, body),
  getSettings: (companyId: string) =>
    api.get<HelperSettingsView>(`/companies/${encodeURIComponent(companyId)}/helper/settings`),
  updateSettings: (companyId: string, patch: UpdateHelperSettings) =>
    api.put<HelperSettingsView>(`/companies/${encodeURIComponent(companyId)}/helper/settings`, patch),
};
