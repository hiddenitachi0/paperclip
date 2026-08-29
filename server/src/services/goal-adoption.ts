import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type { GoalAdoptionSnapshot, GoalAdoptionTrendPoint } from "@paperclipai/shared";

/**
 * DUR-375 (DUR-315 visibility component): counts/trend of issue goal
 * linkage, for a lightweight board-facing dashboard. `goalId` already exists
 * on `issues` (adopted by DUR-376's create/edit form selector) -- this is
 * reporting-only, no schema change, no new gate on issue creation.
 */

export interface GoalAdoptionTrendOptions {
  /** Number of trailing UTC days to include (inclusive of today). */
  days?: number;
}

export const DEFAULT_GOAL_ADOPTION_TREND_DAYS = 30;
export const MAX_GOAL_ADOPTION_TREND_DAYS = 180;

function clampTrendDays(days: number | undefined): number {
  if (days == null || !Number.isFinite(days)) return DEFAULT_GOAL_ADOPTION_TREND_DAYS;
  return Math.min(MAX_GOAL_ADOPTION_TREND_DAYS, Math.max(1, Math.floor(days)));
}

function adoptionPercent(withGoal: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((withGoal / total) * 100).toFixed(2));
}

export function goalAdoptionService(db: Db) {
  return {
    /** Current point-in-time counts for non-hidden issues in the company. */
    snapshot: async (companyId: string): Promise<GoalAdoptionSnapshot> => {
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          withGoal: sql<number>`count(*) filter (where ${issues.goalId} is not null)::int`,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)));

      const total = Number(row?.total ?? 0);
      const withGoal = Number(row?.withGoal ?? 0);

      return {
        companyId,
        totalIssues: total,
        withGoal,
        withoutGoal: Math.max(0, total - withGoal),
        adoptionPercent: adoptionPercent(withGoal, total),
      };
    },

    /**
     * Daily trend, computed on read rather than from a stored snapshot
     * table -- a new time-series table + periodic job would be overkill for
     * this "lightweight" reporting ticket. Each day's `totalIssues`/`withGoal`
     * is a *cumulative* count of issues created on or before that day,
     * evaluated against each issue's current `goalId`. This is an
     * approximation (an issue whose goal was set after creation is counted
     * as adopted from its creation day, not the day the goal was actually
     * attached) but is correct for the common path DUR-376 optimizes for
     * (goal chosen at creation time), and needs no new schema or cron.
     */
    trend: async (
      companyId: string,
      options: GoalAdoptionTrendOptions = {},
    ): Promise<GoalAdoptionTrendPoint[]> => {
      const days = clampTrendDays(options.days);

      const rows = await db.execute(sql`
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', now() AT TIME ZONE 'utc') - (${days - 1} * interval '1 day'),
            date_trunc('day', now() AT TIME ZONE 'utc'),
            interval '1 day'
          ) AS day
        )
        SELECT
          to_char(days.day, 'YYYY-MM-DD') AS day,
          count(${issues.id}) FILTER (
            WHERE (${issues.createdAt} AT TIME ZONE 'utc') < days.day + interval '1 day'
          )::int AS total,
          count(${issues.id}) FILTER (
            WHERE (${issues.createdAt} AT TIME ZONE 'utc') < days.day + interval '1 day'
              AND ${issues.goalId} IS NOT NULL
          )::int AS with_goal
        FROM days
        LEFT JOIN ${issues}
          ON ${issues.companyId} = ${companyId}
          AND ${issues.hiddenAt} IS NULL
        GROUP BY days.day
        ORDER BY days.day ASC
      `);

      const parsed = (Array.isArray(rows) ? rows : []) as Array<{
        day: string;
        total: number | string;
        with_goal: number | string;
      }>;

      return parsed.map((row) => {
        const total = Number(row.total ?? 0);
        const withGoal = Number(row.with_goal ?? 0);
        return {
          date: row.day,
          totalIssues: total,
          withGoal,
          withoutGoal: Math.max(0, total - withGoal),
          adoptionPercent: adoptionPercent(withGoal, total),
        };
      });
    },
  };
}
