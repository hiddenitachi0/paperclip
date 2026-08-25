import type { PermissionKey } from "@paperclipai/shared";

type McpServerConfig = { name: string; command?: string; args?: string[]; url?: string; transport?: string; env?: Record<string, string>; headers?: Record<string, string> };
import { api } from "./client";

/**
 * DUR-142: this file's routes/fields were a pre-DUR-114 best guess that never
 * matched what DUR-114 actually shipped (server/src/routes/agent-roles.ts,
 * `/agent-roles` not `/jobs`, `defaultInstructions`/`defaultMcpServers`/
 * `defaultGrants` not `instructions`/`defaultTools`/`defaultRights`). Every
 * page/component keeps using the nicer `Job`/`JobDraft` names below — this
 * file alone knows the server's real route paths and field names, and
 * translates between the two via `fromDto`/`toDto`.
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
  skillKeys: string[];
  connectorKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JobDraft {
  name: string;
  description: string;
  instructions: string;
  defaultTools: McpServerConfig[];
  defaultRights: RightGrant[];
  skillKeys: string[];
  connectorKeys: string[];
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

// Server-side shape (company_agent_roles table / server/src/routes/agent-roles.ts).
interface AgentRoleDto {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  defaultInstructions: string | null;
  defaultMcpServers: McpServerConfig[];
  defaultGrants: RightGrant[];
  skillKeys: string[] | null;
  connectorKeys: string[] | null;
  createdAt: string;
  updatedAt: string;
}

function fromDto(dto: AgentRoleDto): Job {
  return {
    id: dto.id,
    companyId: dto.companyId,
    name: dto.name,
    description: dto.description ?? "",
    instructions: dto.defaultInstructions ?? "",
    defaultTools: dto.defaultMcpServers,
    defaultRights: dto.defaultGrants,
    skillKeys: dto.skillKeys ?? [],
    connectorKeys: dto.connectorKeys ?? [],
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function toDto(draft: Partial<JobDraft>): Record<string, unknown> {
  const dto: Record<string, unknown> = {};
  if (draft.name !== undefined) dto.name = draft.name;
  if (draft.description !== undefined) dto.description = draft.description;
  if (draft.instructions !== undefined) dto.defaultInstructions = draft.instructions;
  if (draft.defaultTools !== undefined) dto.defaultMcpServers = draft.defaultTools;
  if (draft.defaultRights !== undefined) dto.defaultGrants = draft.defaultRights;
  if (draft.skillKeys !== undefined) dto.skillKeys = draft.skillKeys;
  if (draft.connectorKeys !== undefined) dto.connectorKeys = draft.connectorKeys;
  return dto;
}

function rolePath(id: string, suffix = "") {
  return `/agent-roles/${encodeURIComponent(id)}${suffix}`;
}

export const jobsApi = {
  list: async (companyId: string) =>
    (await api.get<AgentRoleDto[]>(`/companies/${encodeURIComponent(companyId)}/agent-roles`)).map(fromDto),
  get: async (id: string) => fromDto(await api.get<AgentRoleDto>(rolePath(id))),
  create: async (companyId: string, data: JobDraft) =>
    fromDto(
      await api.post<AgentRoleDto>(`/companies/${encodeURIComponent(companyId)}/agent-roles`, toDto(data)),
    ),
  update: async (id: string, data: Partial<JobDraft>) => fromDto(await api.patch<AgentRoleDto>(rolePath(id), toDto(data))),
  remove: (id: string) => api.delete<void>(rolePath(id)),
  duplicateToCompany: async (id: string, targetCompanyId: string) =>
    fromDto(await api.post<AgentRoleDto>(rolePath(id, "/copy"), { targetCompanyId })),

  // Board-only. The backend must 403 this for agent-authenticated callers
  // regardless of what the UI shows — see DUR-114's hard rules.
  assignToAgent: (agentId: string, jobId: string) =>
    api.post<AgentRoleState>(`/agents/${encodeURIComponent(agentId)}/role`, { roleId: jobId }),

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

  // DUR-149: per-agent skill_key override on top of the assigned job. Unlike
  // tools/rights, this endpoint returns the raw agent row (not an
  // AgentRoleState DTO) — the caller re-reads the skills bucket from the
  // agent's roleOverrides/roleProvisionedSkillKeys fields instead.
  addAgentSkillOverride: (agentId: string, key: string) =>
    api.post<void>(`/agents/${encodeURIComponent(agentId)}/role/skills`, { key }),
  removeAgentSkillOverride: (agentId: string, key: string) =>
    api.delete<void>(`/agents/${encodeURIComponent(agentId)}/role/skills/${encodeURIComponent(key)}`),
};
