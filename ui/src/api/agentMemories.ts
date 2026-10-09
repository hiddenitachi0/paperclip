import { api } from "./client";

// Quick-agent memory notebook: short notes a quick agent was asked to
// remember, which the operator can read, add, edit and delete on the agent's
// page. The notebook is the agent's persona's when it has one (shared by every
// job that person holds), else the agent's own. Board-only routes; an agent
// can never call them.

export type AgentMemorySource = "agent" | "user" | "reaction";

export interface AgentMemoryNote {
  id: string;
  text: string;
  /** "agent": saved by the quick agent in a chat; "user": typed on this page. */
  source: AgentMemorySource;
  agentId: string;
  personaId: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemoryList {
  owner: { kind: "persona"; personaId: string; name: string | null } | { kind: "agent"; agentId: string; name: string };
  maxNotes: number;
  maxLength: number;
  /** Newest first. */
  notes: AgentMemoryNote[];
}

function memoriesPath(agentId: string, suffix = "") {
  return `/agents/${encodeURIComponent(agentId)}/memories${suffix}`;
}

export const agentMemoriesApi = {
  list: (agentId: string) => api.get<AgentMemoryList>(memoriesPath(agentId)),
  add: (agentId: string, text: string) => api.post<AgentMemoryNote>(memoriesPath(agentId), { text }),
  update: (agentId: string, memoryId: string, text: string) =>
    api.patch<AgentMemoryNote>(memoriesPath(agentId, `/${encodeURIComponent(memoryId)}`), { text }),
  remove: (agentId: string, memoryId: string) =>
    api.delete<void>(memoriesPath(agentId, `/${encodeURIComponent(memoryId)}`)),
  clear: (agentId: string) => api.delete<{ deleted: number }>(memoriesPath(agentId)),
};
