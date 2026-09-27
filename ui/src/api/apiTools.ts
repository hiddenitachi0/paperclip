import { api } from "./client";

// DUR-4004: "API with a key" -- the third kind of tool on the Tools page. The
// key itself never travels through this client: `auth.secretId` names the
// saved secret that holds it, and the server attaches the value at call time.

export type ApiToolAuthKind = "bearer" | "header" | "query";
export type ApiToolMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiToolInputType = "string" | "number" | "integer" | "boolean" | "json";

export interface ApiToolAuth {
  kind: ApiToolAuthKind;
  /** Header or query parameter name (header and query kinds). */
  name?: string;
  /** Text put in front of the key for the header kind, e.g. "Key " for Fal.ai. */
  prefix?: string;
  secretId: string;
}

export interface ApiToolActionInput {
  name: string;
  type: ApiToolInputType;
  required: boolean;
  description?: string;
}

export interface ApiToolAction {
  name: string;
  method: ApiToolMethod;
  path: string;
  description: string;
  inputs: ApiToolActionInput[];
}

export interface ApiTool {
  id: string;
  companyId: string;
  name: string;
  key: string;
  description: string;
  baseUrl: string;
  auth: ApiToolAuth | null;
  actions: ApiToolAction[];
  openapiUrl: string | null;
  dailyCap: number;
  status: "active" | "disabled";
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentApiToolListItem extends ApiTool {
  enabled: boolean;
}

export interface ApiToolInput {
  name: string;
  description: string;
  baseUrl: string;
  auth: ApiToolAuth;
  actions: ApiToolAction[];
  openapiUrl?: string | null;
  dailyCap?: number;
  status?: "active" | "disabled";
}

export interface ApiToolTestResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface OpenApiImportResult {
  title: string | null;
  baseUrl: string | null;
  actions: ApiToolAction[];
  skipped: number;
}

export interface ApiToolRunResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  urls: string[];
  error: string | null;
  durationMs: number;
}

export const apiToolsApi = {
  list: (companyId: string) => api.get<ApiTool[]>(`/companies/${companyId}/api-tools`),
  create: (companyId: string, data: ApiToolInput) => api.post<ApiTool>(`/companies/${companyId}/api-tools`, data),
  update: (companyId: string, toolId: string, data: Partial<ApiToolInput>) =>
    api.patch<ApiTool>(`/companies/${companyId}/api-tools/${toolId}`, data),
  remove: (companyId: string, toolId: string) => api.delete<void>(`/companies/${companyId}/api-tools/${toolId}`),
  test: (companyId: string, toolId: string) => api.post<ApiToolTestResult>(`/companies/${companyId}/api-tools/${toolId}/test`, {}),
  importOpenApi: (companyId: string, url: string) =>
    api.post<OpenApiImportResult>(`/companies/${companyId}/api-tools/import-openapi`, { url }),
  run: (companyId: string, toolId: string, action: string, input: Record<string, unknown>) =>
    api.post<ApiToolRunResult>(`/companies/${companyId}/api-tools/${toolId}/actions/${action}/run`, { input }),
  listForAgent: (agentId: string) => api.get<AgentApiToolListItem[]>(`/agents/${agentId}/api-tools`),
  syncAgentSelection: (agentId: string, desiredToolIds: string[]) =>
    api.post<{ id: string; apiToolIds: string[] }>(`/agents/${agentId}/api-tools/sync`, { desiredToolIds }),
};
