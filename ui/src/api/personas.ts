import { api } from "./client";

// DUR-133/DUR-184: a persona is who an agent IS -- a name, a face, a voice --
// layered on top of the agents row (the worker: adapter, budget, MCP tools).
// Board-only routes, same posture as mcp-tool-library.ts: an agent can never
// grant or edit its own persona.
export interface Persona {
  id: string;
  companyId: string;
  agentId: string;
  displayName: string;
  handle: string | null;
  bio: string | null;
  voice: string | null;
  avatarAssetId: string | null;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonaInput {
  agentId: string;
  displayName: string;
  handle?: string;
  bio?: string;
  voice?: string;
  avatarAssetId?: string;
}

export interface UpdatePersonaInput {
  displayName?: string;
  handle?: string | null;
  bio?: string | null;
  voice?: string | null;
  avatarAssetId?: string | null;
  status?: "active" | "paused";
}

export const personasApi = {
  list: (companyId: string) => api.get<Persona[]>(`/companies/${companyId}/personas`),
  create: (companyId: string, data: CreatePersonaInput) =>
    api.post<Persona>(`/companies/${companyId}/personas`, data),
  get: (personaId: string) => api.get<Persona>(`/personas/${personaId}`),
  update: (personaId: string, data: UpdatePersonaInput) =>
    api.patch<Persona>(`/personas/${personaId}`, data),
  remove: (personaId: string) => api.delete<void>(`/personas/${personaId}`),
};
