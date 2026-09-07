import type { InstanceClaudeAuthStatus, InstanceClaudeSignInSession } from "@paperclipai/shared";
import { api } from "./client";

/** One-click Claude sign-in (instance-wide Claude subscription token). No call here ever returns the token. */
export const instanceClaudeAuthApi = {
  get: () => api.get<InstanceClaudeAuthStatus>("/instance/claude-auth"),
  saveToken: (token: string) => api.post<InstanceClaudeAuthStatus>("/instance/claude-auth/token", { token }),
  check: () => api.post<InstanceClaudeAuthStatus>("/instance/claude-auth/check", undefined),
  remove: () => api.delete<InstanceClaudeAuthStatus>("/instance/claude-auth"),
  startSignIn: () => api.post<InstanceClaudeSignInSession>("/instance/claude-auth/sign-in", undefined),
  getSignIn: (id: string) => api.get<InstanceClaudeSignInSession>(`/instance/claude-auth/sign-in/${id}`),
  submitSignInCode: (id: string, code: string) =>
    api.post<InstanceClaudeSignInSession>(`/instance/claude-auth/sign-in/${id}/code`, { code }),
  cancelSignIn: (id: string) =>
    api.post<InstanceClaudeSignInSession>(`/instance/claude-auth/sign-in/${id}/cancel`, undefined),
};
