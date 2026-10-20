import { api } from "./client";

/** One "ask" right on one agent, as GET/PUT /agents/:id/request-rights return it. */
export interface AgentRequestRightState {
  permissionKey: "deploys:request" | "merges:request";
  enabled: boolean;
  /**
   * "position"   came with the agent's position
   * "agent"      switched on for this agent directly
   * "turned_off" the position gives it, but it was switched off for this agent
   * "none"       not held
   */
  source: "position" | "agent" | "turned_off" | "none";
  positionGivesIt: boolean;
  grantedByUserId: string | null;
  updatedAt: string | null;
}

export interface AgentRequestRights {
  agentId: string;
  companyId: string;
  position: { id: string; name: string } | null;
  deploysRequest: AgentRequestRightState;
  mergesRequest: AgentRequestRightState;
  /** True when the person looking is the company's owner or an admin. */
  canChange: boolean;
}

export type AgentRequestRightsUpdate = { deploysRequest?: boolean; mergesRequest?: boolean };

export const agentRequestRightsApi = {
  get: (agentId: string) => api.get<AgentRequestRights>(`/agents/${encodeURIComponent(agentId)}/request-rights`),
  set: (agentId: string, data: AgentRequestRightsUpdate) =>
    api.put<AgentRequestRights>(`/agents/${encodeURIComponent(agentId)}/request-rights`, data),
};
