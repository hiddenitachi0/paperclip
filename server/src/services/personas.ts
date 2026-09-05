// DUR-133: personas — give an agent an identity beyond "worker with a name
// and a title". Name, avatar and bio/voice already live on `agents`
// (avatarAssetId/personality shipped in DUR-60/DUR-61, before this table
// existed); this service only manages what's persona-specific (the `personas`
// row: handle + lifecycle status) and renders that identity into a
// PERSONA.md file inside the agent's managed instructions bundle, which
// AGENTS.md references with exactly one line.
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, personas } from "@paperclipai/db";
import type { CreatePersonaInput, UpdatePersonaInput } from "@paperclipai/shared/validators/persona";
import { conflict, notFound } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";

const PERSONA_MARKDOWN_FILE = "PERSONA.md";
// Matched verbatim on every sync to decide whether AGENTS.md already
// references PERSONA.md — never inserted twice, never used to reformat a
// hand-edited AGENTS.md.
const PERSONA_REFERENCE_LINE = "_Persona identity: see [PERSONA.md](./PERSONA.md) for who this agent is._";

type AgentRow = typeof agents.$inferSelect;
type PersonaRow = typeof personas.$inferSelect;

// The API/UI shape: a persona's name, face and voice are agent fields
// (agents.name/avatarAssetId/personality/tone -- DUR-60/DUR-61) rendered
// alongside the persona-specific columns (handle/status/dailyGenerationCap).
// Nothing duplicates that data in the personas table itself.
export interface PersonaWithAgent {
  id: string;
  companyId: string;
  agentId: string;
  displayName: string;
  handle: string | null;
  bio: string | null;
  voice: string | null;
  avatarAssetId: string | null;
  status: string;
  dailyGenerationCap: number | null;
  publishingPaused: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toPersonaWithAgent(persona: PersonaRow, agent: Pick<AgentRow, "name" | "personality" | "tone" | "avatarAssetId">): PersonaWithAgent {
  return {
    id: persona.id,
    companyId: persona.companyId,
    agentId: persona.agentId,
    displayName: agent.name,
    handle: persona.handle,
    bio: agent.personality,
    voice: agent.tone,
    avatarAssetId: agent.avatarAssetId,
    status: persona.status,
    dailyGenerationCap: persona.dailyGenerationCap,
    publishingPaused: persona.publishingPaused,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}

function renderPersonaMarkdown(agent: Pick<AgentRow, "name" | "personality">, persona: Pick<PersonaRow, "handle" | "status">): string {
  const lines = [`# ${agent.name}`, ""];
  if (persona.handle) lines.push(`Handle: ${persona.handle}`, "");
  lines.push(`Status: ${persona.status}`, "");
  lines.push(agent.personality?.trim() ? agent.personality.trim() : "_No bio set yet._");
  return `${lines.join("\n")}\n`;
}

// Exported for direct unit testing against a real filesystem-backed
// agentInstructionsService, without needing a database (see
// __tests__/personas-instructions-sync.test.ts).
export async function syncPersonaInstructions(agent: AgentRow, persona: PersonaRow): Promise<void> {
  const instructions = agentInstructionsService();

  // The entry file (AGENTS.md by default) must exist on disk *before*
  // PERSONA.md is written. If PERSONA.md were written first into a bundle
  // with no AGENTS.md yet, agent-instructions.ts's recovery heuristic — "if
  // the configured entry file is missing from disk, adopt whatever file IS
  // there as the entry" — would hijack PERSONA.md itself as the entry file.
  let entryFile = "AGENTS.md";
  let entryContent = "";
  try {
    const bundle = await instructions.getBundle(agent);
    entryFile = bundle.entryFile;
    if (bundle.resolvedEntryPath) {
      entryContent = (await instructions.readFile(agent, entryFile)).content;
    }
  } catch {
    entryContent = "";
  }

  let adapterConfig = agent.adapterConfig as Record<string, unknown>;
  if (!entryContent.includes(PERSONA_REFERENCE_LINE)) {
    const nextEntryContent = entryContent.replace(/\s+$/, "").length > 0
      ? `${entryContent.replace(/\s+$/, "")}\n\n${PERSONA_REFERENCE_LINE}\n`
      : `${PERSONA_REFERENCE_LINE}\n`;
    const written = await instructions.writeFile({ ...agent, adapterConfig }, entryFile, nextEntryContent);
    adapterConfig = written.adapterConfig;
  }

  const personaMarkdown = renderPersonaMarkdown(agent, persona);
  await instructions.writeFile({ ...agent, adapterConfig }, PERSONA_MARKDOWN_FILE, personaMarkdown);
}

async function loadAgent(db: Db, agentId: string): Promise<AgentRow> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found");
  return agent;
}

async function applyAgentIdentityFields(db: Db, agent: AgentRow, input: CreatePersonaInput | UpdatePersonaInput): Promise<AgentRow> {
  const agentUpdates: Partial<Pick<AgentRow, "name" | "personality" | "tone" | "avatarAssetId">> = {};
  if (input.displayName !== undefined) agentUpdates.name = input.displayName;
  if (input.bio !== undefined) agentUpdates.personality = input.bio;
  if (input.voice !== undefined) agentUpdates.tone = input.voice;
  if (input.avatarAssetId !== undefined) agentUpdates.avatarAssetId = input.avatarAssetId;
  if (Object.keys(agentUpdates).length === 0) return agent;

  const [updated] = await db.update(agents).set(agentUpdates).where(eq(agents.id, agent.id)).returning();
  return updated!;
}

export function personaService(db: Db) {
  async function createPersona(agentId: string, input: CreatePersonaInput): Promise<PersonaWithAgent> {
    const agent = await loadAgent(db, agentId);
    const [existing] = await db.select({ id: personas.id }).from(personas).where(eq(personas.agentId, agentId));
    if (existing) throw conflict("This agent already has a persona.");

    const [created] = await db
      .insert(personas)
      .values({
        companyId: agent.companyId,
        agentId,
        handle: input.handle ?? null,
        status: input.status ?? "draft",
        dailyGenerationCap: input.dailyGenerationCap ?? null,
        publishingPaused: input.publishingPaused ?? false,
      })
      .returning();
    const finalAgent = await applyAgentIdentityFields(db, agent, input);
    await syncPersonaInstructions(finalAgent, created!);
    return toPersonaWithAgent(created!, finalAgent);
  }

  async function getPersonaByAgentId(agentId: string): Promise<PersonaRow | null> {
    const [row] = await db.select().from(personas).where(eq(personas.agentId, agentId));
    return row ?? null;
  }

  async function getPersonaWithAgentById(personaId: string): Promise<PersonaWithAgent | null> {
    const [row] = await db
      .select({ persona: personas, agent: agents })
      .from(personas)
      .innerJoin(agents, eq(agents.id, personas.agentId))
      .where(eq(personas.id, personaId));
    if (!row) return null;
    return toPersonaWithAgent(row.persona, row.agent);
  }

  async function listPersonasForCompany(companyId: string): Promise<PersonaWithAgent[]> {
    const rows = await db
      .select({ persona: personas, agent: agents })
      .from(personas)
      .innerJoin(agents, eq(agents.id, personas.agentId))
      .where(eq(personas.companyId, companyId))
      .orderBy(desc(personas.createdAt));
    return rows.map((row) => toPersonaWithAgent(row.persona, row.agent));
  }

  async function updatePersona(agentId: string, input: UpdatePersonaInput): Promise<PersonaWithAgent> {
    const agent = await loadAgent(db, agentId);
    const existing = await getPersonaByAgentId(agentId);
    if (!existing) throw notFound("This agent has no persona yet.");

    const [updated] = await db
      .update(personas)
      .set({
        handle: input.handle !== undefined ? input.handle : existing.handle,
        status: input.status ?? existing.status,
        dailyGenerationCap: input.dailyGenerationCap !== undefined ? input.dailyGenerationCap : existing.dailyGenerationCap,
        publishingPaused: input.publishingPaused !== undefined ? input.publishingPaused : existing.publishingPaused,
        updatedAt: new Date(),
      })
      .where(eq(personas.id, existing.id))
      .returning();
    const finalAgent = await applyAgentIdentityFields(db, agent, input);
    await syncPersonaInstructions(finalAgent, updated!);
    return toPersonaWithAgent(updated!, finalAgent);
  }

  async function updatePersonaById(personaId: string, input: UpdatePersonaInput): Promise<PersonaWithAgent> {
    const [existing] = await db.select().from(personas).where(eq(personas.id, personaId));
    if (!existing) throw notFound("Persona not found");
    return updatePersona(existing.agentId, input);
  }

  async function deletePersonaById(personaId: string): Promise<void> {
    const [existing] = await db.select().from(personas).where(eq(personas.id, personaId));
    if (!existing) throw notFound("Persona not found");
    await db.delete(personas).where(eq(personas.id, personaId));
  }

  return {
    createPersona,
    getPersonaByAgentId,
    getPersonaWithAgentById,
    listPersonasForCompany,
    updatePersona,
    updatePersonaById,
    deletePersonaById,
  };
}
