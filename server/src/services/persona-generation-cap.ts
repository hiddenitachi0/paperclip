/**
 * DUR-177: enforce `personas.dailyGenerationCap` in code, at the moment an
 * agent invokes the media-studio `generate-image` tool.
 *
 * The parent ticket's standing rule: limits must be enforced in code at the
 * moment of the action, never as prompt guidance. This is the one generation
 * count Paperclip can actually enforce, because the tool call in
 * `packages/plugins/media-studio/src/worker.ts` is the single code path
 * every image generation goes through.
 *
 * Counting: a dedicated `persona_generation_counters` row per
 * (persona, UTC calendar day), incremented atomically and conditionally (via
 * `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE count < cap`) so concurrent
 * calls for the same persona can never push the day's count past the cap.
 * "Per day" uses the UTC calendar day — there is no existing per-company
 * timezone concept in this codebase for daily-reset logic to reuse (checked
 * `plugin_jobs`/routines/rate-limit-like code first; none exists).
 *
 * Deliberately not inferred from `issue_attachments`/`assets`: those rows
 * can be written by unrelated paths (manual attachment upload, agent avatar
 * upload), which would make the cap count things that are not "an image
 * generation". This table is written to from exactly one call site.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personaGenerationCounters, personas } from "@paperclipai/db";

export interface GenerationCapReservation {
  /** Whether this generation is allowed to proceed. */
  allowed: boolean;
  /** The persona's configured cap, or null if unlimited (no persona, or cap not set). */
  cap: number | null;
  /** Generations already recorded today for this persona, before this call. */
  usedToday: number;
}

function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function personaGenerationCapService(db: Db) {
  /**
   * Atomically check-and-reserve one generation against the calling agent's
   * persona daily cap, if it has one. Call this BEFORE running the actual
   * generation so a capped-out persona never reaches the provider.
   *
   * - No persona row for this agent (not a persona) -> unlimited, allowed.
   * - Persona exists but `dailyGenerationCap` is null -> unlimited, allowed.
   * - Persona exists with a cap -> atomically increments today's counter
   *   only if the count is currently below the cap; returns `allowed: false`
   *   (without writing) once the cap is reached.
   */
  async function reserveGeneration(agentId: string): Promise<GenerationCapReservation> {
    const [persona] = await db.select().from(personas).where(eq(personas.agentId, agentId));
    if (!persona || persona.dailyGenerationCap == null) {
      return { allowed: true, cap: null, usedToday: 0 };
    }

    const cap = persona.dailyGenerationCap;
    // Defense in depth: the API validator requires a positive cap, but never
    // trust a value that crossed a layer boundary. A non-positive cap means
    // no generations are allowed today, full stop -- don't even touch the
    // counter row (the ON CONFLICT INSERT branch below would otherwise let
    // the very first generation of the day through regardless of `cap`).
    if (cap <= 0) {
      const usedToday = await currentCount(persona.id);
      return { allowed: false, cap, usedToday };
    }

    const day = utcDayString();
    const [row] = await db
      .insert(personaGenerationCounters)
      .values({ companyId: persona.companyId, personaId: persona.id, day, count: 1 })
      .onConflictDoUpdate({
        target: [personaGenerationCounters.personaId, personaGenerationCounters.day],
        set: {
          count: sql`${personaGenerationCounters.count} + 1`,
          updatedAt: new Date(),
        },
        setWhere: sql`${personaGenerationCounters.count} < ${cap}`,
      })
      .returning({ count: personaGenerationCounters.count });

    if (row) {
      return { allowed: true, cap, usedToday: row.count - 1 };
    }
    // Conflict existed but the WHERE guard excluded it from the update ->
    // cap already reached today.
    const usedToday = await currentCount(persona.id, day);
    return { allowed: false, cap, usedToday };
  }

  async function currentCount(personaId: string, day: string = utcDayString()): Promise<number> {
    const [row] = await db
      .select({ count: personaGenerationCounters.count })
      .from(personaGenerationCounters)
      .where(and(eq(personaGenerationCounters.personaId, personaId), eq(personaGenerationCounters.day, day)));
    return row?.count ?? 0;
  }

  return { reserveGeneration };
}
