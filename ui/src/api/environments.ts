import type {
  CancelEnvironmentCustomImageSetupSession,
  Environment,
  EnvironmentCapabilities,
  EnvironmentLease,
  EnvironmentProbeResult,
  EnvironmentCustomImageSetupSession,
  EnvironmentCustomImageTemplate,
  EnvironmentCustomImageTerminalSessionToken,
  FinishEnvironmentCustomImageSetupSession,
  StartEnvironmentCustomImageSetupSession,
  CreateEnvironmentCustomImageTerminalSessionToken,
} from "@paperclipai/shared";
import { api } from "./client";

export interface EnvironmentCustomImageOverview {
  activeTemplate: EnvironmentCustomImageTemplate | null;
  activeSession: EnvironmentCustomImageSetupSession | null;
  latestSession: EnvironmentCustomImageSetupSession | null;
}

export interface EnvironmentCustomImageConnectionPayload {
  type: string;
  command?: string | null;
  token?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EnvironmentCustomImageSetupSessionResult {
  session: EnvironmentCustomImageSetupSession;
  connectionPayload: EnvironmentCustomImageConnectionPayload | null;
}

export interface EnvironmentCustomImageFinishResult extends EnvironmentCustomImageSetupSessionResult {
  template: EnvironmentCustomImageTemplate;
}

export interface EnvironmentCustomImageRollbackResult {
  activeTemplate: EnvironmentCustomImageTemplate;
  supersededTemplate: EnvironmentCustomImageTemplate;
}

// Environments are instance-scoped, but their secret bindings (including plain
// env vars, which are synced as bindings) are company-scoped. Mutations made
// from a company page must name that company so the server can resolve the
// secret context instead of rejecting the save.
function companyContextQuery(companyId?: string | null): string {
  return companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
}

export const environmentsApi = {
  list: (companyId: string) => api.get<Environment[]>(`/companies/${companyId}/environments`),
  capabilities: (companyId: string) =>
    api.get<EnvironmentCapabilities>(`/companies/${companyId}/environments/capabilities`),
  lease: (leaseId: string) => api.get<EnvironmentLease>(`/environment-leases/${leaseId}`),
  create: (companyId: string, body: {
    name: string;
    description?: string | null;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<Environment>(`/companies/${companyId}/environments`, body),
  update: (environmentId: string, body: {
    name?: string;
    description?: string | null;
    driver?: "local" | "ssh" | "sandbox" | "plugin";
    status?: "active" | "archived";
    config?: Record<string, unknown>;
    envVars?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }, companyId?: string | null) =>
    api.patch<Environment>(`/environments/${environmentId}${companyContextQuery(companyId)}`, body),
  probe: (environmentId: string, companyId?: string | null) =>
    api.post<EnvironmentProbeResult>(`/environments/${environmentId}/probe${companyContextQuery(companyId)}`, {}),
  probeConfig: (companyId: string, body: {
    name?: string;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    description?: string | null;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<EnvironmentProbeResult>(`/companies/${companyId}/environments/probe-config`, body),
  customImageTemplate: (environmentId: string) =>
    api.get<EnvironmentCustomImageOverview>(`/environments/${environmentId}/custom-image-template`),
  startCustomImageSetupSession: (
    environmentId: string,
    body: StartEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageSetupSessionResult>(
      `/environments/${environmentId}/custom-image-setup-sessions`,
      body,
    ),
  customImageSetupSession: (sessionId: string) =>
    api.get<EnvironmentCustomImageSetupSessionResult>(
      `/environment-custom-image-setup-sessions/${sessionId}`,
    ),
  createCustomImageTerminalSessionToken: (
    sessionId: string,
    body: CreateEnvironmentCustomImageTerminalSessionToken = {},
  ) =>
    api.post<EnvironmentCustomImageTerminalSessionToken>(
      `/environment-custom-image-setup-sessions/${sessionId}/terminal-session-token`,
      body,
    ),
  finishCustomImageSetupSession: (
    sessionId: string,
    body: FinishEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageFinishResult>(
      `/environment-custom-image-setup-sessions/${sessionId}/finish`,
      body,
    ),
  cancelCustomImageSetupSession: (
    sessionId: string,
    body: CancelEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageSetupSession>(
      `/environment-custom-image-setup-sessions/${sessionId}/cancel`,
      body,
    ),
  rollbackCustomImageTemplate: (environmentId: string) =>
    api.post<EnvironmentCustomImageRollbackResult>(
      `/environments/${environmentId}/custom-image-template/rollback`,
      {},
    ),
  disableCustomImageTemplate: (
    environmentId: string,
    options: { deleteProviderTemplate?: boolean } = {},
  ) =>
    api.delete<EnvironmentCustomImageTemplate>(
      `/environments/${environmentId}/custom-image-template?deleteProviderTemplate=${options.deleteProviderTemplate === true ? "true" : "false"}`,
    ),
};
