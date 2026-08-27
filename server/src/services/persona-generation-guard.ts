/**
 * DUR-177 item 18 — enforce `personas.dailyGenerationCap` (added by DUR-186,
 * migration 0144) in code, at the moment a persona-linked agent actually
 * calls the image-generation tool, rather than relying on prompt guidance.
 *
 * The only place every "generate an image" call passes through, regardless
 * of which routine/run triggered it, is the generic plugin-tool execute
 * gate (POST /plugins/tools/execute in server/src/routes/plugins.ts) --
 * there is no persona-specific "briefing" code path in this codebase today
 * (ticket DUR-177 named packages/db/src/schema/routines.ts as the
 * enforcement point, but that file is schema-only; re-verified against the
 * actual call graph, see grep for TOOL_GENERATE / "generate-image" and
 * media-studio's worker.ts). That route already gates every tool call
 * on plugin-enabled + per-agent tool grants, so this reservation slots in
 * right alongside those checks.
 *
 * Race safety: `reserve` increments and cap-checks the persona's counter in
 * a single conditional UPDATE, so two concurrent requests against the same
 * persona cannot both succeed past the cap -- Postgres serializes
 * concurrent UPDATEs to the same row. A reservation is taken up front
 * (before the possibly-slow generation call); `release` gives it back if
 * the generation attempt itself fails, so a failed call doesn't burn a
 * persona's daily budget.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personas } from "@paperclipai/db";

/** Namespaced tool name for Media Studio's image-generation tool (see packages/plugins/media-studio/src/manifest.ts PLUGIN_ID + TOOL_GENERATE). */
export const GENERATE_IMAGE_TOOL_NAME = "paperclip.media-studio:generate-image";

export interface GenerationReservation {
  /** False when the persona has already hit her daily cap -- caller must block the tool call. */
  allowed: boolean;
  /** Null when `agentId` is not a persona at all -- no cap applies (DUR-63: caps are per-persona, opt-in). */
  personaId: string | null;
  /** Generations already used today (post-reservation when allowed, current count when not). */
  countToday: number;
  /** The persona's configured cap, or null if unlimited. */
  cap: number | null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function personaGenerationGuard(db: Db) {
  return {
    async reserve(agentId: string): Promise<GenerationReservation> {
      const [persona] = await db
        .select({ id: personas.id, dailyGenerationCap: personas.dailyGenerationCap })
        .from(personas)
        .where(eq(personas.agentId, agentId));

      if (!persona) {
        // Not a persona at all -- this guard only applies to persona-linked agents.
        return { allowed: true, personaId: null, countToday: 0, cap: null };
      }
      if (persona.dailyGenerationCap === null) {
        return { allowed: true, personaId: persona.id, countToday: 0, cap: null };
      }

      const today = todayUtc();
      const [reserved] = await db
        .update(personas)
        .set({
          generationCountToday: sql`CASE WHEN ${personas.generationCountDate} = ${today}::date THEN ${personas.generationCountToday} + 1 ELSE 1 END`,
          generationCountDate: sql`${today}::date`,
          updatedAt: new Date(),
        })
        .where(
          sql`${personas.id} = ${persona.id} AND (
            CASE WHEN ${personas.generationCountDate} = ${today}::date THEN ${personas.generationCountToday} ELSE 0 END
          ) < ${persona.dailyGenerationCap}`,
        )
        .returning({ countToday: personas.generationCountToday });

      if (reserved) {
        return { allowed: true, personaId: persona.id, countToday: reserved.countToday, cap: persona.dailyGenerationCap };
      }

      // Cap already reached today -- read back the current count for the error message.
      const [current] = await db
        .select({ countToday: personas.generationCountToday, countDate: personas.generationCountDate })
        .from(personas)
        .where(eq(personas.id, persona.id));
      const countToday = current?.countDate === today ? (current?.countToday ?? persona.dailyGenerationCap) : 0;
      return { allowed: false, personaId: persona.id, countToday, cap: persona.dailyGenerationCap };
    },

    /** Give back a reservation when the generation call itself failed (provider error, worker crash, etc). */
    async release(personaId: string): Promise<void> {
      await db
        .update(personas)
        .set({ generationCountToday: sql`GREATEST(${personas.generationCountToday} - 1, 0)`, updatedAt: new Date() })
        .where(eq(personas.id, personaId));
    },
  };
}

export type PersonaGenerationGuard = ReturnType<typeof personaGenerationGuard>;
