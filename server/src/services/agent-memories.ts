import { and, count, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories, agents, authUsers, companyMemberships, personas } from "@paperclipai/db";
import {
  AGENT_MEMORY_MAX_LENGTH,
  AGENT_MEMORY_MAX_NOTES,
  normalizeAgentMemoryText,
  type AgentMemoryList,
  type AgentMemoryNote,
  type AgentMemorySource,
} from "@paperclipai/shared/validators/agent-memory";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

/**
 * Quick-agent memory notebook: short notes a quick agent was asked to
 * remember (its `remember` tool) or that the operator typed on the agent's
 * page. Stored in agent_memories (migration 0180).
 *
 * Ownership is decided here and nowhere else:
 *   - the agent has a persona  -> the note belongs to the PERSON
 *     (persona_id = the persona), and every job that person holds reads it;
 *   - otherwise                -> the note belongs to the JOB
 *     (agent_id = the agent, persona_id null).
 * Every read and write goes through the owner of the agent named by the
 * caller, in the caller's company, so a note of another agent, person or
 * company answers exactly like a missing one.
 *
 * Every add, edit and delete is written to activity_log: who, which agent,
 * and the first 120 characters of the note.
 */

/** How much of a note the activity log keeps. */
export const AGENT_MEMORY_LOG_PREVIEW_CHARS = 120;

export interface AgentMemoryOwner {
  companyId: string;
  agentId: string;
  agentName: string;
  personaId: string | null;
  personaName: string | null;
}

/** Who is changing the notebook, for the activity log. */
export interface AgentMemoryActor {
  actorType: "user" | "agent";
  actorId: string;
  /** The person, when there is one (a board user, or the person a quick agent is talking to). */
  userId: string | null;
  /** Where the change came from: the agent's page, or a quick-agent chat. */
  via: "page" | "chat";
  conversationId?: string | null;
}

type NoteRow = typeof agentMemories.$inferSelect;

function preview(text: string): string {
  return text.length <= AGENT_MEMORY_LOG_PREVIEW_CHARS ? text : text.slice(0, AGENT_MEMORY_LOG_PREVIEW_CHARS);
}

/** Checks and normalises a note; throws a 422 with a plain sentence when it cannot be saved. */
export function checkAgentMemoryText(input: unknown): string {
  const text = typeof input === "string" ? normalizeAgentMemoryText(input) : "";
  if (!text) throw unprocessable("Write something to remember.");
  if (text.length > AGENT_MEMORY_MAX_LENGTH) {
    throw unprocessable(`A note can be at most ${AGENT_MEMORY_MAX_LENGTH} characters; this one is ${text.length}.`);
  }
  return text;
}

export function agentMemoryService(db: Db) {
  async function resolveOwner(companyId: string, agentId: string): Promise<AgentMemoryOwner> {
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, personaId: agents.personaId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw notFound("Agent not found");
    let personaId: string | null = null;
    let personaName: string | null = null;
    if (agent.personaId) {
      const [persona] = await db
        .select({ id: personas.id, displayName: personas.displayName })
        .from(personas)
        .where(and(eq(personas.id, agent.personaId), eq(personas.companyId, companyId)));
      // A persona of another company is never followed; the job keeps its own notes.
      if (persona) {
        personaId = persona.id;
        personaName = persona.displayName ?? null;
      }
    }
    return { companyId, agentId: agent.id, agentName: agent.name, personaId, personaName };
  }

  function ownerFilter(owner: AgentMemoryOwner): SQL {
    return owner.personaId
      ? and(eq(agentMemories.companyId, owner.companyId), eq(agentMemories.personaId, owner.personaId))!
      : and(
          eq(agentMemories.companyId, owner.companyId),
          eq(agentMemories.agentId, owner.agentId),
          isNull(agentMemories.personaId),
        )!;
  }

  async function listRows(owner: AgentMemoryOwner): Promise<NoteRow[]> {
    return db
      .select()
      .from(agentMemories)
      .where(ownerFilter(owner))
      .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id));
  }

  async function namesFor(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    try {
      const rows = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, ids));
      return new Map(rows.filter((row) => row.name).map((row) => [row.id, row.name!]));
    } catch {
      // A name is a nicety on the page; the list must still load without it.
      return new Map();
    }
  }

  function toNote(row: NoteRow, names: Map<string, string>): AgentMemoryNote {
    return {
      id: row.id,
      text: row.text,
      source: row.source as AgentMemorySource,
      agentId: row.agentId,
      personaId: row.personaId ?? null,
      createdByUserId: row.createdByUserId ?? null,
      createdByName: row.createdByUserId ? names.get(row.createdByUserId) ?? null : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function log(
    owner: AgentMemoryOwner,
    actor: AgentMemoryActor,
    action: "agent_memory.added" | "agent_memory.updated" | "agent_memory.deleted" | "agent_memory.cleared",
    details: Record<string, unknown>,
  ) {
    await logActivity(db, {
      companyId: owner.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: owner.agentId,
      action,
      entityType: "agent",
      entityId: owner.agentId,
      details: {
        agentName: owner.agentName,
        personaId: owner.personaId,
        via: actor.via,
        ...(actor.conversationId ? { conversationId: actor.conversationId } : {}),
        ...details,
      },
    });
  }

  async function findOwned(owner: AgentMemoryOwner, memoryId: string): Promise<NoteRow> {
    const [row] = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.id, memoryId), ownerFilter(owner)));
    if (!row) throw notFound("That note was not found. It may already have been deleted.");
    return row;
  }

  /**
   * DUR-4094: which of these notes' authors are an active "Employee (light)"
   * member of the company right now. This route is board-only and a light
   * employee can never reach it (no agents:create grant, and blocked by
   * default besides), so every caller here is, by construction, someone
   * other than the note's author -- exactly the case Filip's privacy rule
   * covers: her PA's memory notes are hers, not the admin page's.
   */
  async function privacyProtectedAuthorIds(companyId: string, authorIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(authorIds)];
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "employee"),
          inArray(companyMemberships.principalId, ids),
        ),
      );
    return new Set(rows.map((row) => row.principalId));
  }

  return {
    resolveOwner,

    /**
     * The notebook for the agent's page: owner, limits and every note, newest
     * first. A note written by an active Employee (light) member is left out
     * -- it is hers, same as her PA chat transcript -- unless
     * `emergencyAccess` is set, which the caller may only do after writing a
     * private_access_events row (see server/src/services/private-access.ts
     * and routes/private-access.ts).
     */
    async list(companyId: string, agentId: string, options?: { emergencyAccess?: boolean }): Promise<AgentMemoryList> {
      const owner = await resolveOwner(companyId, agentId);
      const rows = await listRows(owner);
      const protectedAuthorIds = options?.emergencyAccess
        ? new Set<string>()
        : await privacyProtectedAuthorIds(
            companyId,
            rows.map((row) => row.createdByUserId).filter((id): id is string => !!id),
          );
      const visibleRows = rows.filter((row) => !row.createdByUserId || !protectedAuthorIds.has(row.createdByUserId));
      const names = await namesFor(visibleRows.map((row) => row.createdByUserId).filter((id): id is string => !!id));
      return {
        owner: owner.personaId
          ? { kind: "persona", personaId: owner.personaId, name: owner.personaName }
          : { kind: "agent", agentId: owner.agentId, name: owner.agentName },
        maxNotes: AGENT_MEMORY_MAX_NOTES,
        maxLength: AGENT_MEMORY_MAX_LENGTH,
        notes: visibleRows.map((row) => toNote(row, names)),
      };
    },

    /** The notes a quick agent reads, newest first (ids, text and dates only). */
    async listForAgent(companyId: string, agentId: string): Promise<Array<{ id: string; text: string; createdAt: Date }>> {
      const owner = await resolveOwner(companyId, agentId);
      const rows = await listRows(owner);
      return rows.map((row) => ({ id: row.id, text: row.text, createdAt: row.createdAt }));
    },

    /**
     * Save one note for the agent's owner. 422 when empty or too long, 409
     * with a plain sentence when the notebook already holds the maximum.
     */
    async add(
      companyId: string,
      agentId: string,
      input: { text: unknown; source: AgentMemorySource },
      actor: AgentMemoryActor,
    ): Promise<AgentMemoryNote> {
      const text = checkAgentMemoryText(input.text);
      const owner = await resolveOwner(companyId, agentId);
      const [{ value: existing } = { value: 0 }] = await db
        .select({ value: count() })
        .from(agentMemories)
        .where(ownerFilter(owner));
      if (Number(existing) >= AGENT_MEMORY_MAX_NOTES) {
        throw conflict(
          `The memory is full: it already holds ${AGENT_MEMORY_MAX_NOTES} notes. Delete some old ones first.`,
          { code: "AGENT_MEMORY_FULL", maxNotes: AGENT_MEMORY_MAX_NOTES },
        );
      }
      const now = new Date();
      const [row] = await db
        .insert(agentMemories)
        .values({
          companyId,
          agentId: owner.agentId,
          personaId: owner.personaId,
          text,
          source: input.source,
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await log(owner, actor, "agent_memory.added", { memoryId: row!.id, source: input.source, text: preview(text) });
      const names = await namesFor(row!.createdByUserId ? [row!.createdByUserId] : []);
      return toNote(row!, names);
    },

    /** Replace one note's text. 404 when the note is not this agent's owner's. */
    async update(
      companyId: string,
      agentId: string,
      memoryId: string,
      input: { text: unknown },
      actor: AgentMemoryActor,
    ): Promise<AgentMemoryNote> {
      const text = checkAgentMemoryText(input.text);
      const owner = await resolveOwner(companyId, agentId);
      const existing = await findOwned(owner, memoryId);
      const [row] = await db
        .update(agentMemories)
        .set({ text, updatedAt: new Date() })
        .where(and(eq(agentMemories.id, existing.id), ownerFilter(owner)))
        .returning();
      if (!row) throw notFound("That note was not found. It may already have been deleted.");
      await log(owner, actor, "agent_memory.updated", {
        memoryId: row.id,
        text: preview(text),
        previousText: preview(existing.text),
      });
      const names = await namesFor(row.createdByUserId ? [row.createdByUserId] : []);
      return toNote(row, names);
    },

    /** Delete one note. Returns the deleted note's text; 404 when it is not this agent's owner's. */
    async remove(companyId: string, agentId: string, memoryId: string, actor: AgentMemoryActor): Promise<{ id: string; text: string }> {
      const owner = await resolveOwner(companyId, agentId);
      const existing = await findOwned(owner, memoryId);
      const deleted = await db
        .delete(agentMemories)
        .where(and(eq(agentMemories.id, existing.id), ownerFilter(owner)))
        .returning({ id: agentMemories.id, text: agentMemories.text });
      if (deleted.length === 0) throw notFound("That note was not found. It may already have been deleted.");
      await log(owner, actor, "agent_memory.deleted", { memoryId: existing.id, text: preview(existing.text) });
      return deleted[0]!;
    },

    /**
     * DUR-4345: replace the owner's 'reaction' notes with `texts` (the reaction
     * summariser rewrites them wholesale, so a removed reaction cannot linger).
     * Notes of other sources are never touched. If the notebook would exceed
     * the cap, the extra reaction notes are dropped rather than evicting
     * anything a person wrote. Returns how many were written.
     */
    async replaceReactionNotes(companyId: string, agentId: string, texts: string[], actor: AgentMemoryActor): Promise<number> {
      const owner = await resolveOwner(companyId, agentId);
      const reactionOnly = and(ownerFilter(owner), eq(agentMemories.source, "reaction"))!;
      const [{ value: others } = { value: 0 }] = await db
        .select({ value: count() })
        .from(agentMemories)
        .where(and(ownerFilter(owner), ne(agentMemories.source, "reaction")));
      const room = Math.max(0, AGENT_MEMORY_MAX_NOTES - Number(others));
      const keep = texts.map((t) => checkAgentMemoryText(t)).slice(0, room);
      const now = new Date();
      const removed = await db.delete(agentMemories).where(reactionOnly).returning({ id: agentMemories.id });
      if (keep.length > 0) {
        await db.insert(agentMemories).values(
          keep.map((text) => ({
            companyId,
            agentId: owner.agentId,
            personaId: owner.personaId,
            text,
            source: "reaction" as const,
            createdByUserId: null,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      if (removed.length > 0 || keep.length > 0) {
        await log(owner, actor, "agent_memory.added", {
          source: "reaction",
          replaced: removed.length,
          written: keep.length,
          texts: keep.map(preview),
        });
      }
      return keep.length;
    },

    /** Delete every note of this agent's owner ("Clear all"). */
    async clear(companyId: string, agentId: string, actor: AgentMemoryActor): Promise<{ deleted: number }> {
      const owner = await resolveOwner(companyId, agentId);
      const deleted = await db
        .delete(agentMemories)
        .where(ownerFilter(owner))
        .returning({ id: agentMemories.id, text: agentMemories.text });
      if (deleted.length > 0) {
        await log(owner, actor, "agent_memory.cleared", {
          count: deleted.length,
          texts: deleted.slice(0, 20).map((row) => preview(row.text)),
        });
      }
      return { deleted: deleted.length };
    },
  };
}

export type AgentMemoryService = ReturnType<typeof agentMemoryService>;
