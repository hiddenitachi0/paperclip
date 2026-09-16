import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * DUR-386: retention for `cross_company_access_log`.
 *
 * Migration 0149 created the table so a rare, genuine use of the
 * cross-company escape hatch is visible after the fact, but nothing in the
 * codebase ever deleted from it -- it grew forever. The other half of
 * DUR-386 stops the routine heartbeat-scheduler ticks from writing to it at
 * all (see packages/db/src/cross-company-audit.ts), so what remains is the
 * genuine, low-volume traffic this bound is sized for.
 *
 * Default retention: 90 days. Deliberately three times the
 * heartbeat_runs window (30 days) -- these rows are the audit trail for a
 * security boundary, so the default keeps a full quarter, comfortably longer
 * than anyone would take to notice and investigate an unexpected
 * cross-company access. Override per deployment with
 * PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS, or switch the sweep off
 * entirely with PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED=false
 * (see server/src/config.ts).
 *
 * FAIL-SAFE toward keeping rows: the sweep only ever deletes rows strictly
 * older than the cutoff, one bounded batch at a time, and a failed sweep
 * leaves everything in place and simply retries on the next interval. There
 * is no path here that can delete a row inside the retention window.
 */
export const DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS = 90;

/** Rows deleted per batch -- keeps each transaction and its lock window bounded. */
const DEFAULT_DELETE_BATCH_SIZE = 5_000;

/** Safety cap on batches per sweep so a huge backlog cannot loop forever. */
const MAX_ITERATIONS = 200;

/**
 * Delete `cross_company_access_log` rows older than `retentionDays`, in
 * batches.
 *
 * Batching uses a `WHERE ... ORDER BY occurred_at LIMIT n` subquery, the same
 * shape as heartbeat-run-retention.ts (Postgres DELETE has no LIMIT clause),
 * and rides the `cross_company_access_log_occurred_at_idx` index migration
 * 0149 already creates on that column -- so no migration is needed for this.
 *
 * Unlike the heartbeat_runs sweep, this one does NOT lift the pool's DUR-280
 * statement_timeout: nothing references `cross_company_access_log.id`, so
 * there are no ON DELETE cascade/SET NULL triggers to make a batch slow. A
 * batch here is one indexed range delete. If that ever did hit the 30s
 * ceiling the batch fails, nothing is deleted, and the next sweep retries.
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
  // postgres-js cannot infer a bind type for a raw `Date` in db.execute(sql`...`);
  // pass the ISO string and let Postgres cast it against the timestamptz column.
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
    logger.info(
      { totalDeleted, retentionDays, cutoffDate: cutoff },
      "Pruned expired cross_company_access_log rows",
    );
  }

  return totalDeleted;
}

/**
 * Start a periodic cross_company_access_log cleanup interval.
 *
 * @param db - Database connection
 * @param intervalMs - How often to run (default: 1 hour)
 * @param retentionDays - How many days of entries to keep (default: 90)
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
