// DUR-133: personas — give an agent an identity beyond "worker with a name
// and a title". Name, avatar and bio/voice already live on `agents`
// (avatarAssetId/personality shipped in DUR-60/DUR-61, before this table
// existed); this service only manages what's persona-specific (the `personas`
// row: handle + lifecycle status) and renders that identity into a
// PERSONA.md file inside the agent's managed instructions bundle, which
// AGENTS.md references with exactly one line.
import { eq } from "drizzle-orm";
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

export function personaService(db: Db) {
  async function createPersona(agentId: string, input: CreatePersonaInput): Promise<PersonaRow> {
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
      })
      .returning();
    await syncPersonaInstructions(agent, created!);
    return created!;
  }

  async function getPersonaByAgentId(agentId: string): Promise<PersonaRow | null> {
    const [row] = await db.select().from(personas).where(eq(personas.agentId, agentId));
    return row ?? null;
  }

  async function updatePersona(agentId: string, input: UpdatePersonaInput): Promise<PersonaRow> {
    const agent = await loadAgent(db, agentId);
    const existing = await getPersonaByAgentId(agentId);
    if (!existing) throw notFound("This agent has no persona yet.");

    const [updated] = await db
      .update(personas)
      .set({
        handle: input.handle !== undefined ? input.handle : existing.handle,
        status: input.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(personas.id, existing.id))
      .returning();
    await syncPersonaInstructions(agent, updated!);
    return updated!;
  }

  return { createPersona, getPersonaByAgentId, updatePersona };
}
