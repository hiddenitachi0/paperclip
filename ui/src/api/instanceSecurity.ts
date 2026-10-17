import type {
  AdminAuthCheckResult,
  InstanceSecurityOverview,
  RevokeSessionResult,
  SignOutEverywhereResult,
  SignOutEverywhereScope,
} from "@paperclipai/shared";
import { api } from "./client";
import { clearHelperSessions } from "../components/helper/helper-session";

export const instanceSecurityApi = {
  getOverview: () => api.get<InstanceSecurityOverview>("/instance/security"),
  checkNow: () => api.post<AdminAuthCheckResult>("/instance/security/check", {}),
  signOutEverywhere: (scope: SignOutEverywhereScope) => {
    // This tab's session ends too: drop the Ask panel's saved conversations like a normal sign-out.
    clearHelperSessions();
    return api.post<SignOutEverywhereResult>("/instance/security/sign-out-everywhere", { scope });
  },
  revokeSession: (sessionId: string) =>
    api.delete<RevokeSessionResult>(`/instance/security/sessions/${encodeURIComponent(sessionId)}`),
};
