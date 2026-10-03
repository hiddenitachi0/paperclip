import type { EmailSettings } from "../types/mail";
import { ApiError, api } from "./client";

/**
 * DUR-4195 / DUR-4277: the email feature's company-scoped on/off switch,
 * mirroring productGrabberApi (../api/productGrabber.ts). Off by default --
 * until DUR-4277 (backend) ships the route, getSettings() treats a missing
 * endpoint (404) as disabled rather than surfacing an error, so the feature
 * never accidentally shows up before the switch exists.
 */
export const emailSettingsApi = {
  getSettings: async (companyId: string): Promise<EmailSettings> => {
    try {
      return await api.get<EmailSettings>(`/companies/${companyId}/email/settings`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { enabled: false };
      }
      throw error;
    }
  },
  setEnabled: (companyId: string, enabled: boolean) =>
    api.patch<EmailSettings>(`/companies/${companyId}/email/settings`, { enabled }),
};
