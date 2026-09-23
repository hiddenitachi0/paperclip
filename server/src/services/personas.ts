// DUR-133 / DUR-4000: personas. A persona is a PERSON — display name,
// pronouns, traits, backstory, voice, picture, handle — and it lives in one
// place: the personas row. An agent is a JOB that may have one persona
// attached (agents.persona_id); the same persona can hold many jobs, full and
// quick. Nothing in this service ever renames or rewrites an agent: the old
// behaviour where creating a persona overwrote agents.name/personality/tone/
// avatar (and rendered a PERSONA.md into the instructions bundle) is gone.
// The persona reaches the model at prompt time instead — see
// resolveAgentForAdapter in heartbeat.ts (full agents) and buildSystemPrompt
// in lane-a.ts (quick agents).
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, personas } from "@paperclipai/db";
import type { CreatePersonaInput, UpdatePersonaInput } from "@paperclipai/shared/validators/persona";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentRow = typeof agents.$inferSelect;
type PersonaRow = typeof personas.$inferSelect;

/** The API shape of a persona: its own columns, plus the jobs it currently holds. */
export interface PersonaView {
  id: string;
  companyId: string;
  displayName: string;
  pronouns: string | null;
  traits: string | null;
  backstory: string | null;
  /** Pre-DUR-4000 name for `backstory`; kept until the persona screens (step 3) stop reading it. */
  bio: string | null;
  voice: string | null;
  avatarAssetId: string | null;
  handle: string | null;
  status: string;
  publishingPaused: boolean;
  /** Ids of the agents this persona is attached to (agents.persona_id). */
  agentIds: string[];
  /**
   * Pre-DUR-4000 shape: the first attached agent, or null. The persona screens
   * (step 3) still read this; a persona with several jobs reports the first
   * one here and all of them in `agentIds`.
   */
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A job the persona holds, as the persona pages list them. */
export interface PersonaAgentSummary {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  laneAEnabled: boolean;
}

/** What the prompt builders need from a persona (heartbeat and Lane A). */
export type PersonaPromptIdentity = Pick<PersonaRow, "id" | "displayName" | "pronouns" | "traits" | "backstory" | "voice">;

function toPersonaView(persona: PersonaRow, agentIds: string[]): PersonaView {
  return {
    id: persona.id,
    companyId: persona.companyId,
    // display_name is nullable at the column level only so the migration
    // could add it; the API requires it and the backfill filled every old
    // row, so an empty one is a data error we render as "" rather than crash.
    displayName: persona.displayName ?? "",
    pronouns: persona.pronouns,
    traits: persona.traits,
    backstory: persona.backstory,
    bio: persona.backstory,
    voice: persona.voice,
    avatarAssetId: persona.avatarAssetId,
    handle: persona.handle,
    status: persona.status,
    publishingPaused: persona.publishingPaused,
    agentIds,
    agentId: agentIds[0] ?? null,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}

function personaColumnsFromInput(input: CreatePersonaInput | UpdatePersonaInput): Partial<typeof personas.$inferInsert> {
  const patch: Partial<typeof personas.$inferInsert> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.pronouns !== undefined) patch.pronouns = input.pronouns;
  if (input.traits !== undefined) patch.traits = input.traits;
  if (input.backstory !== undefined) patch.backstory = input.backstory;
  if (input.voice !== undefined) patch.voice = input.voice;
  if (input.avatarAssetId !== undefined) patch.avatarAssetId = input.avatarAssetId;
  if (input.handle !== undefined) patch.handle = input.handle;
  if (input.status !== undefined) patch.status = input.status;
  if (input.publishingPaused !== undefined) patch.publishingPaused = input.publishingPaused;
  return patch;
}

export function personaService(db: Db) {
  async function loadAgent(agentId: string): Promise<AgentRow> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function loadPersonaRow(personaId: string): Promise<PersonaRow | null> {
    const [row] = await db.select().from(personas).where(eq(personas.id, personaId));
    return row ?? null;
  }

  /** agents.persona_id -> [agentId, ...], one query for a batch of personas. */
  async function attachedAgentIdsByPersonaId(personaIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (personaIds.length === 0) return result;
    const rows = await db
      .select({ id: agents.id, personaId: agents.personaId, name: agents.name })
      .from(agents)
      .where(inArray(agents.personaId, personaIds))
      .orderBy(asc(agents.name));
    for (const row of rows) {
      if (!row.personaId) continue;
      const list = result.get(row.personaId) ?? [];
      list.push(row.id);
      result.set(row.personaId, list);
    }
    return result;
  }

  async function viewFor(persona: PersonaRow): Promise<PersonaView> {
    const attached = await attachedAgentIdsByPersonaId([persona.id]);
    return toPersonaView(persona, attached.get(persona.id) ?? []);
  }

  /** Create a person in a company. Attaches to nothing. */
  async function createPersonaForCompany(companyId: string, input: CreatePersonaInput): Promise<PersonaView> {
    const [created] = await db
      .insert(personas)
      .values({
        companyId,
        ...personaColumnsFromInput(input),
        displayName: input.displayName,
        status: input.status ?? "draft",
        publishingPaused: input.publishingPaused ?? false,
      })
      .returning();
    return toPersonaView(created!, []);
  }

  /**
   * Create a person and attach it to one job in the same call — the shape
   * the persona screens use today (POST /agents/:agentId/persona). The agent
   * row is NOT renamed or rewritten; only agents.persona_id is set.
   */
  async function createPersona(agentId: string, input: CreatePersonaInput): Promise<PersonaView> {
    const agent = await loadAgent(agentId);
    if (agent.personaId) throw conflict("This agent already has a persona.");
    const created = await createPersonaForCompany(agent.companyId, input);
    await db.update(agents).set({ personaId: created.id, updatedAt: new Date() }).where(eq(agents.id, agentId));
    return { ...created, agentIds: [agentId], agentId };
  }

  /** The persona attached to this agent (agents.persona_id), or null. */
  async function getPersonaByAgentId(agentId: string): Promise<PersonaRow | null> {
    const [row] = await db
      .select({ persona: personas })
      .from(agents)
      .innerJoin(personas, eq(personas.id, agents.personaId))
      .where(eq(agents.id, agentId));
    return row?.persona ?? null;
  }

  /** What a prompt builder needs, or null when the agent has no persona. */
  async function getPromptIdentityByAgentId(agentId: string): Promise<PersonaPromptIdentity | null> {
    const row = await getPersonaByAgentId(agentId);
    if (!row) return null;
    const { id, displayName, pronouns, traits, backstory, voice } = row;
    return { id, displayName, pronouns, traits, backstory, voice };
  }

  async function getPersonaViewByAgentId(agentId: string): Promise<PersonaView | null> {
    const row = await getPersonaByAgentId(agentId);
    return row ? viewFor(row) : null;
  }

  async function getPersonaById(personaId: string): Promise<PersonaView | null> {
    const row = await loadPersonaRow(personaId);
    return row ? viewFor(row) : null;
  }

  async function listPersonasForCompany(companyId: string): Promise<PersonaView[]> {
    const rows = await db
      .select()
      .from(personas)
      .where(eq(personas.companyId, companyId))
      .orderBy(desc(personas.createdAt));
    const attached = await attachedAgentIdsByPersonaId(rows.map((row) => row.id));
    return rows.map((row) => toPersonaView(row, attached.get(row.id) ?? []));
  }

  /** The jobs a persona holds, for the persona pages. */
  async function listAgentsForPersona(personaId: string): Promise<PersonaAgentSummary[]> {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        laneAEnabled: agents.laneAEnabled,
      })
      .from(agents)
      .where(eq(agents.personaId, personaId))
      .orderBy(asc(agents.name));
    return rows;
  }

  async function updatePersonaById(personaId: string, input: UpdatePersonaInput): Promise<PersonaView> {
    const existing = await loadPersonaRow(personaId);
    if (!existing) throw notFound("Persona not found");
    const patch = personaColumnsFromInput(input);
    if (patch.displayName !== undefined && !patch.displayName) {
      throw unprocessable("The persona needs a name.");
    }
    const [updated] = await db
      .update(personas)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(personas.id, personaId))
      .returning();
    return viewFor(updated!);
  }

  /** Update the persona attached to this agent. Never touches the agent row. */
  async function updatePersona(agentId: string, input: UpdatePersonaInput): Promise<PersonaView> {
    await loadAgent(agentId);
    const existing = await getPersonaByAgentId(agentId);
    if (!existing) throw notFound("This agent has no persona yet.");
    return updatePersonaById(existing.id, input);
  }

  /** Delete the person. Its jobs are detached (ON DELETE SET NULL), never deleted. */
  async function deletePersonaById(personaId: string): Promise<void> {
    const existing = await loadPersonaRow(personaId);
    if (!existing) throw notFound("Persona not found");
    await db.delete(personas).where(eq(personas.id, personaId));
  }

  /**
   * Attach a person to a job (or detach with null). The persona must belong
   * to the agent's company. Board-only at the route.
   */
  async function attachPersonaToAgent(agentId: string, personaId: string | null): Promise<PersonaView | null> {
    const agent = await loadAgent(agentId);
    if (personaId) {
      const persona = await loadPersonaRow(personaId);
      if (!persona || persona.companyId !== agent.companyId) {
        throw unprocessable("That persona does not exist in this company.");
      }
    }
    await db.update(agents).set({ personaId, updatedAt: new Date() }).where(eq(agents.id, agentId));
    return personaId ? getPersonaById(personaId) : null;
  }

  /**
   * DUR-177: batched agentId -> persona display name lookup, joined through
   * agents.persona_id. Used by the approvals route to tag a request as
   * persona-related without an N+1 query. Only agents that actually have a
   * persona attached come back; a plain agent is absent from the map, which
   * callers read as "not persona-related".
   */
  async function getPersonaDisplayNamesByAgentIds(agentIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0) return new Map();
    const rows = await db
      .select({ agentId: agents.id, displayName: personas.displayName })
      .from(agents)
      .innerJoin(personas, eq(personas.id, agents.personaId))
      .where(inArray(agents.id, unique));
    return new Map(
      rows.flatMap((row) => (row.displayName ? [[row.agentId, row.displayName] as [string, string]] : [])),
    );
  }

  /**
   * The agents a persona may act through, for the publisher: exactly the
   * jobs attached via agents.persona_id, in this persona's company. The
   * legacy personas.agent_id is deliberately NOT a fallback: an agent whose
   * persona_id no longer points here has been detached and must not be woken
   * or named on a card (migration 0175 backfilled persona_id for every old
   * row, so nothing legitimate is lost).
   */
  async function listActingAgentIdsForPersona(personaId: string): Promise<string[]> {
    const persona = await loadPersonaRow(personaId);
    if (!persona) return [];
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, persona.companyId), eq(agents.personaId, personaId)))
      .orderBy(asc(agents.createdAt));
    return rows.map((row) => row.id);
  }

  return {
    createPersona,
    createPersonaForCompany,
    getPersonaByAgentId,
    getPromptIdentityByAgentId,
    getPersonaViewByAgentId,
    getPersonaById,
    listPersonasForCompany,
    listAgentsForPersona,
    updatePersona,
    updatePersonaById,
    deletePersonaById,
    attachPersonaToAgent,
    getPersonaDisplayNamesByAgentIds,
    listActingAgentIdsForPersona,
  };
}
