import type {
  AdminAuthCheckResult,
  InstanceSecurityOverview,
  RevokeSessionResult,
  SignOutEverywhereResult,
  SignOutEverywhereScope,
} from "@paperclipai/shared";
import { api } from "./client";

export const instanceSecurityApi = {
  getOverview: () => api.get<InstanceSecurityOverview>("/instance/security"),
  checkNow: () => api.post<AdminAuthCheckResult>("/instance/security/check", {}),
  signOutEverywhere: (scope: SignOutEverywhereScope) =>
    api.post<SignOutEverywhereResult>("/instance/security/sign-out-everywhere", { scope }),
  revokeSession: (sessionId: string) =>
    api.delete<RevokeSessionResult>(`/instance/security/sessions/${encodeURIComponent(sessionId)}`),
};
