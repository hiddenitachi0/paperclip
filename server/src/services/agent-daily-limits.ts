/**
 * DUR-4000: per-agent daily limits, enforced in code at the moment of the
 * action, never as prompt guidance. Replaces persona-generation-cap.ts: a
 * limit belongs to the JOB (agents.limits), not to the PERSON (a persona can
 * now hold several jobs with different limits).
 *
 * Counting: one `agent_daily_counters` row per (agent, kind, UTC calendar
 * day), incremented atomically and conditionally (`INSERT ... ON CONFLICT
 * ... DO UPDATE ... WHERE count < limit`) so concurrent calls for the same
 * agent can never push the day's count past the limit. UTC day: there is no
 * per-company timezone concept in this codebase for daily-reset logic to
 * reuse.
 *
 * Kinds today:
 *   image_generation — agents.limits.dailyImageGenerations, reserved from
 *                      the media-studio generate-image tool (the single code
 *                      path every image generation goes through).
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentDailyCounters, agents } from "@paperclipai/db";
import { parseAgentLimits } from "@paperclipai/shared";

export const AGENT_DAILY_COUNTER_KINDS = ["image_generation"] as const;
export type AgentDailyCounterKind = (typeof AGENT_DAILY_COUNTER_KINDS)[number];

export interface DailyLimitReservation {
  /** Whether this action is allowed to proceed. */
  allowed: boolean;
  /** The agent's configured limit for this kind, or null if none (unlimited). */
  cap: number | null;
  /** Actions of this kind already recorded today for this agent, before this call. */
  usedToday: number;
}

function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function limitForKind(limits: ReturnType<typeof parseAgentLimits>, kind: AgentDailyCounterKind): number | null {
  switch (kind) {
    case "image_generation":
      return limits.dailyImageGenerations ?? null;
    default:
      return null;
  }
}

/** The operator-facing refusal, in plain words. Exported so the plugin worker and tests use the same sentence. */
export function dailyLimitReachedMessage(kind: AgentDailyCounterKind, cap: number | null): string {
  switch (kind) {
    case "image_generation":
      return `Daily image limit (${cap ?? 0}) reached for this agent today.`;
    default:
      return `Daily limit (${cap ?? 0}) reached for this agent today.`;
  }
}

export function agentDailyLimitService(db: Db) {
  /**
   * Atomically check-and-reserve one action of `kind` against the agent's
   * own daily limit, if it has one. Call this BEFORE doing the action so a
   * capped-out agent never reaches the provider.
   *
   * - Agent has no limit for this kind (key absent or null) -> allowed, unlimited.
   * - Limit set -> increments today's counter only while the count is below
   *   the limit; returns `allowed: false` (without writing) once reached.
   * - Limit of 0 -> nothing is allowed today; the counter row is not touched
   *   (the INSERT branch of ON CONFLICT would otherwise let the very first
   *   action of the day through regardless of the limit).
   */
  async function reserve(agentId: string, kind: AgentDailyCounterKind): Promise<DailyLimitReservation> {
    const [agent] = await db
      .select({ id: agents.id, companyId: agents.companyId, limits: agents.limits })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) {
      return { allowed: true, cap: null, usedToday: 0 };
    }
    const cap = limitForKind(parseAgentLimits(agent.limits), kind);
    if (cap == null) {
      return { allowed: true, cap: null, usedToday: 0 };
    }
    if (cap <= 0) {
      return { allowed: false, cap, usedToday: await currentCount(agentId, kind) };
    }

    const day = utcDayString();
    const [row] = await db
      .insert(agentDailyCounters)
      .values({ companyId: agent.companyId, agentId, kind, day, count: 1 })
      .onConflictDoUpdate({
        target: [agentDailyCounters.agentId, agentDailyCounters.kind, agentDailyCounters.day],
        set: {
          count: sql`${agentDailyCounters.count} + 1`,
          updatedAt: new Date(),
        },
        setWhere: sql`${agentDailyCounters.count} < ${cap}`,
      })
      .returning({ count: agentDailyCounters.count });

    if (row) {
      return { allowed: true, cap, usedToday: row.count - 1 };
    }
    // Conflict existed but the WHERE guard excluded it from the update ->
    // limit already reached today.
    return { allowed: false, cap, usedToday: await currentCount(agentId, kind, day) };
  }

  async function currentCount(agentId: string, kind: AgentDailyCounterKind, day: string = utcDayString()): Promise<number> {
    const [row] = await db
      .select({ count: agentDailyCounters.count })
      .from(agentDailyCounters)
      .where(and(eq(agentDailyCounters.agentId, agentId), eq(agentDailyCounters.kind, kind), eq(agentDailyCounters.day, day)));
    return row?.count ?? 0;
  }

  return { reserve, currentCount };
}
