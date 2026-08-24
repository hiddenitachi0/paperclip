// DUR-133 (persona-mcp Ticket B, items 10-11): a persona is an identity —
// name, face, bio, voice — layered on top of an existing agent. This
// service owns the `personas` row and keeps her instructions bundle's
// PERSONA.md in sync with it. It intentionally never writes to AGENTS.md's
// body: AGENTS.md is the bundle's directly-editable entry file
// (agent-instructions.ts), and a database-is-source-of-truth rewrite of it
// would clobber operator and agent edits on every save. Instead it ensures
// AGENTS.md carries a one-line pointer to PERSONA.md, added once.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, personas } from "@paperclipai/db";
import type { CreatePersona, UpdatePersona } from "@paperclipai/shared/validators/persona";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";

const PERSONA_FILE = "PERSONA.md";
const AGENTS_FILE = "AGENTS.md";
const PERSONA_REFERENCE_LINE = `See \`${PERSONA_FILE}\` for who you are — your identity, backstory and voice as a persona.`;

function renderPersonaMarkdown(persona: {
  displayName: string;
  handle: string | null;
  bio: string | null;
  voice: string | null;
}): string {
  const lines: string[] = [`# ${persona.displayName}`];
  if (persona.handle) lines.push("", `Known as: ${persona.handle}`);
  lines.push("", "## Who she is", "", persona.bio?.trim() || "_Not written yet._");
  lines.push("", "## Her voice", "", persona.voice?.trim() || "_Not written yet._");
  return `${lines.join("\n")}\n`;
}

async function ensureAgentsFileReferencesPersona(agent: { id: string; companyId: string; name: string; adapterConfig: unknown }) {
  const instructions = agentInstructionsService();
  const existing = await instructions.readFile(agent, AGENTS_FILE).catch(() => null);
  const currentContent = existing?.content ?? "";
  if (currentContent.includes(PERSONA_FILE)) return;
  const nextContent = currentContent.trim().length > 0
    ? `${currentContent.replace(/\s*$/, "")}\n\n${PERSONA_REFERENCE_LINE}\n`
    : `${PERSONA_REFERENCE_LINE}\n`;
  await instructions.writeFile(agent, AGENTS_FILE, nextContent);
}

async function writePersonaFile(
  agent: { id: string; companyId: string; name: string; adapterConfig: unknown },
  persona: { displayName: string; handle: string | null; bio: string | null; voice: string | null },
) {
  const instructions = agentInstructionsService();
  await instructions.writeFile(agent, PERSONA_FILE, renderPersonaMarkdown(persona));
  await ensureAgentsFileReferencesPersona(agent);
}

async function requireAgentInCompany(db: Db, agentId: string, companyId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
  return agent;
}

export async function createPersona(db: Db, companyId: string, input: CreatePersona) {
  const agent = await requireAgentInCompany(db, input.agentId, companyId);

  const [existing] = await db.select({ id: personas.id }).from(personas).where(eq(personas.agentId, agent.id));
  if (existing) throw conflict("This agent already has a persona");

  const [created] = await db
    .insert(personas)
    .values({
      companyId,
      agentId: agent.id,
      displayName: input.displayName,
      handle: input.handle ?? null,
      bio: input.bio ?? null,
      voice: input.voice ?? null,
      avatarAssetId: input.avatarAssetId ?? null,
    })
    .returning();
  if (!created) throw unprocessable("Failed to create persona");

  await writePersonaFile(agent, created);
  return created;
}

export async function getPersona(db: Db, personaId: string) {
  const [row] = await db.select().from(personas).where(eq(personas.id, personaId));
  return row ?? null;
}

export async function getPersonaByAgentId(db: Db, agentId: string) {
  const [row] = await db.select().from(personas).where(eq(personas.agentId, agentId));
  return row ?? null;
}

export async function listPersonas(db: Db, companyId: string) {
  return db.select().from(personas).where(eq(personas.companyId, companyId)).orderBy(personas.displayName);
}

export async function updatePersona(db: Db, personaId: string, input: UpdatePersona) {
  const existing = await getPersona(db, personaId);
  if (!existing) throw notFound("Persona not found");

  const updates: Partial<typeof personas.$inferInsert> = { updatedAt: new Date() };
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.handle !== undefined) updates.handle = input.handle;
  if (input.bio !== undefined) updates.bio = input.bio;
  if (input.voice !== undefined) updates.voice = input.voice;
  if (input.avatarAssetId !== undefined) updates.avatarAssetId = input.avatarAssetId;
  if (input.status !== undefined) updates.status = input.status;

  const [updated] = await db.update(personas).set(updates).where(eq(personas.id, personaId)).returning();
  if (!updated) throw notFound("Persona not found");

  const identityChanged = ["displayName", "handle", "bio", "voice"].some((key) => key in input);
  if (identityChanged) {
    const agent = await requireAgentInCompany(db, updated.agentId, updated.companyId);
    await writePersonaFile(agent, updated);
  }
  return updated;
}

export async function deletePersona(db: Db, personaId: string) {
  const existing = await getPersona(db, personaId);
  if (!existing) throw notFound("Persona not found");
  await db.delete(personas).where(eq(personas.id, personaId));
  const agent = await db.select().from(agents).where(eq(agents.id, existing.agentId)).then((rows) => rows[0] ?? null);
  if (agent) {
    await agentInstructionsService().deleteFile(agent, PERSONA_FILE).catch(() => {});
  }
  return existing;
}
