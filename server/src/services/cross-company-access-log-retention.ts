import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Default retention period: 30 days. Overridable via PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS. */
export const DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS = 30;

/** Default rows deleted per batch -- keeps each transaction/lock window bounded. */
const DEFAULT_DELETE_BATCH_SIZE = 5_000;

/** Safety cap on batches per sweep so a huge backlog can't loop forever. */
const MAX_ITERATIONS = 200;

/**
 * DUR-386 (DUR-352 Wave 6 finding 2): `cross_company_access_log` (migration
 * 0149) records every use of the paperclip_app_bypass escape hatch so a
 * genuinely cross-company access surfaces during the RLS transition. Nothing
 * ever pruned it. The scheduler alone wrote ~9 rows every 10-30s -- ~25k rows
 * a day of pure mechanics -- and once audit-row coalescing (see
 * `auditCoalesceMs` in packages/db/src/company-scope.ts) cut that down, the
 * remaining rows still need a bound so the table cannot grow forever.
 *
 * Deliberately bypass-scoped forever, like heartbeat-run-retention.ts: the
 * table has no company_id at all (it is the record OF cross-company access),
 * so there is no per-company boundary to scope a connection against. Takes
 * the plain raw `Db`, never the request-scoped Proxy.
 *
 * Batches via a `WHERE ... ORDER BY occurred_at LIMIT n` subquery rather than
 * one unbounded DELETE, same shape as pruneHeartbeatRuns.
 *
 * @returns The total number of rows deleted.
 */
export async function pruneCrossCompanyAccessLog(
  db: Db,
  retentionDays: number = DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS,
  batchSize: number = DEFAULT_DELETE_BATCH_SIZE,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  // postgres-js can't infer a bind type for a raw `Date` parameter in a
  // db.execute(sql`...`) call -- pass the ISO string and let Postgres cast it
  // against the timestamptz column instead (see pruneHeartbeatRuns).
  const cutoffIso = cutoff.toISOString();

  let totalDeleted = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const rows = await db.execute(sql`
      WITH batch AS (
        SELECT id FROM cross_company_access_log
        WHERE occurred_at < ${cutoffIso}
        ORDER BY occurred_at
        LIMIT ${batchSize}
      )
      DELETE FROM cross_company_access_log
      WHERE id IN (SELECT id FROM batch)
      RETURNING id
    `);
    const deleted = Array.isArray(rows) ? rows.length : 0;

    totalDeleted += deleted;
    iterations++;

    if (deleted < batchSize) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { totalDeleted, iterations, cutoffDate: cutoff },
      "Cross-company access log retention hit iteration limit; more expired rows remain for the next sweep",
    );
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted, retentionDays }, "Pruned expired cross_company_access_log rows");
  }

  return totalDeleted;
}

/**
 * Start a periodic cross_company_access_log cleanup interval.
 *
 * @param db - Raw database connection (never the request-scoped Proxy)
 * @param intervalMs - How often to run (default: 1 hour)
 * @param retentionDays - How many days of audit rows to keep (default: 30)
 * @returns A cleanup function that stops the interval
 */
export function startCrossCompanyAccessLogRetention(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
  retentionDays: number = DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS,
): () => void {
  const timer = setInterval(() => {
    pruneCrossCompanyAccessLog(db, retentionDays).catch((err) => {
      logger.warn({ err }, "Cross-company access log retention sweep failed");
    });
  }, intervalMs);

  pruneCrossCompanyAccessLog(db, retentionDays).catch((err) => {
    logger.warn({ err }, "Initial cross-company access log retention sweep failed");
  });

  return () => clearInterval(timer);
}
