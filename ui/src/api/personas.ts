import { api } from "./client";

// DUR-4000: a persona is a PERSON -- name, pronouns, traits, backstory, voice,
// picture, handle -- with its own row. An agent is a JOB; the same persona can
// hold several jobs (agents.persona_id). Nothing here renames an agent.
// Board-only routes, same posture as mcp-tool-library.ts: an agent can never
// grant or edit its own persona.
export type PersonaStatus = "draft" | "active" | "paused";

export interface Persona {
  id: string;
  companyId: string;
  displayName: string;
  /** Free text -- "she/her", "he/him", "they/them", "hen". Never assumed. */
  pronouns: string | null;
  traits: string | null;
  backstory: string | null;
  voice: string | null;
  avatarAssetId: string | null;
  handle: string | null;
  status: PersonaStatus;
  // DUR-134: the per-persona half of the publishing kill switch.
  publishingPaused: boolean;
  /** The jobs this persona holds (agents.persona_id). */
  agentIds: string[];
  /** Pre-DUR-4000 shape: the first attached job, or null. Prefer `agentIds`. */
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonaInput {
  displayName: string;
  pronouns?: string;
  traits?: string;
  backstory?: string;
  voice?: string;
  handle?: string;
  avatarAssetId?: string;
  status?: PersonaStatus;
}

export interface UpdatePersonaInput {
  displayName?: string;
  pronouns?: string | null;
  traits?: string | null;
  backstory?: string | null;
  voice?: string | null;
  handle?: string | null;
  avatarAssetId?: string | null;
  status?: PersonaStatus;
  publishingPaused?: boolean;
}

export const personasApi = {
  list: (companyId: string) => api.get<Persona[]>(`/companies/${companyId}/personas`),
  /** Create a person. Attaches to nothing; attach jobs from the persona page or the agent's settings. */
  create: (companyId: string, data: CreatePersonaInput) =>
    api.post<Persona>(`/companies/${companyId}/personas`, data),
  get: (personaId: string) => api.get<Persona>(`/personas/${personaId}`),
  update: (personaId: string, data: UpdatePersonaInput) =>
    api.patch<Persona>(`/personas/${personaId}`, data),
  remove: (personaId: string) => api.delete<void>(`/personas/${personaId}`),
  /**
   * Attach a persona to a job, or detach with null. Returns the persona
   * (with its updated `agentIds`) on attach; the server answers 204 on detach.
   */
  attachToAgent: (agentId: string, personaId: string | null) =>
    api.put<Persona | undefined>(`/agents/${agentId}/persona`, { personaId }),
};
