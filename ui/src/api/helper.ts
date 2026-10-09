import type {
  HelperAskRequest,
  HelperAskResponse,
  HelperInvestigationList,
  HelperInvestigationView,
  HelperSettingsView,
  StartHelperInvestigationRequest,
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
  /** The person's own "Investigate deeper" tasks (newest first) and whether a new one can start. */
  listInvestigations: (companyId: string) =>
    api.get<HelperInvestigationList>(`/companies/${encodeURIComponent(companyId)}/helper/investigations`),
  startInvestigation: (companyId: string, body: StartHelperInvestigationRequest) =>
    api.post<HelperInvestigationView>(`/companies/${encodeURIComponent(companyId)}/helper/investigations`, body),
};
