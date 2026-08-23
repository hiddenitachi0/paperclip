import type { PermissionKey } from "@paperclipai/shared";

type McpServerConfig = { name: string; command?: string; args?: string[]; url?: string; transport?: string; env?: Record<string, string>; headers?: Record<string, string> };
import { api } from "./client";

/**
 * PENDING BACKEND WIRING (DUR-114 / DUR-65 child).
 *
 * DUR-114 (the sibling backend ticket) had not opened a PR or shared final
 * route/field names as of this writing. Every path and field name below is
 * a best-guess built from DUR-114's own ticket description (which names the
 * `mcpServerConfigSchema` tool shape and the `{permissionKey, scope}[]`
 * grant shape it plans to mirror from `grantsForHumanRole`). Update this
 * file's paths/fields once DUR-114 lands — nothing else in the UI should
 * need to change, since every page/component below only talks to `jobsApi`.
 */

export interface RightGrant {
  permissionKey: PermissionKey;
  scope: Record<string, unknown> | null;
}

export interface Job {
  id: string;
  companyId: string;
  name: string;
  description: string;
  instructions: string;
  defaultTools: McpServerConfig[];
  defaultRights: RightGrant[];
  createdAt: string;
  updatedAt: string;
}

export interface JobDraft {
  name: string;
  description: string;
  instructions: string;
  defaultTools: McpServerConfig[];
  defaultRights: RightGrant[];
}

/** What a specific agent currently holds vs. what its assigned job would have given it. */
export interface AgentRoleState {
  job: { id: string; name: string; description: string } | null;
  assignedAt: string | null;
  tools: {
    fromJob: string[];
    added: string[];
    removed: string[];
  };
  rights: {
    fromJob: RightGrant[];
    added: RightGrant[];
    removed: RightGrant[];
  };
}

function jobPath(id: string, suffix = "") {
  return `/jobs/${encodeURIComponent(id)}${suffix}`;
}

export const jobsApi = {
  list: (companyId: string) => api.get<Job[]>(`/companies/${encodeURIComponent(companyId)}/jobs`),
  get: (id: string) => api.get<Job>(jobPath(id)),
  create: (companyId: string, data: JobDraft) =>
    api.post<Job>(`/companies/${encodeURIComponent(companyId)}/jobs`, data),
  update: (id: string, data: Partial<JobDraft>) => api.patch<Job>(jobPath(id), data),
  remove: (id: string) => api.delete<{ ok: true }>(jobPath(id)),
  duplicateToCompany: (id: string, targetCompanyId: string) =>
    api.post<Job>(jobPath(id, "/duplicate"), { targetCompanyId }),

  // Board-only. The backend must 403 this for agent-authenticated callers
  // regardless of what the UI shows — see DUR-114's hard rules.
  assignToAgent: (agentId: string, jobId: string) =>
    api.post<AgentRoleState>(`/agents/${encodeURIComponent(agentId)}/role`, { jobId }),

  getAgentRoleState: (agentId: string) =>
    api.get<AgentRoleState>(`/agents/${encodeURIComponent(agentId)}/role`),

  addAgentToolOverride: (agentId: string, tool: McpServerConfig) =>
    api.post<AgentRoleState>(`/agents/${encodeURIComponent(agentId)}/role/tools`, { tool }),
  removeAgentToolOverride: (agentId: string, toolName: string) =>
    api.delete<AgentRoleState>(
      `/agents/${encodeURIComponent(agentId)}/role/tools/${encodeURIComponent(toolName)}`,
    ),
  addAgentRightOverride: (agentId: string, grant: RightGrant) =>
    api.post<AgentRoleState>(`/agents/${encodeURIComponent(agentId)}/role/rights`, grant),
  removeAgentRightOverride: (agentId: string, permissionKey: PermissionKey) =>
    api.delete<AgentRoleState>(
      `/agents/${encodeURIComponent(agentId)}/role/rights/${encodeURIComponent(permissionKey)}`,
    ),
};
