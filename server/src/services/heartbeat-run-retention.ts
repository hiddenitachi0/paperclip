import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Default retention period: 30 days. Overridable via config/env. */
export const DEFAULT_HEARTBEAT_RUN_RETENTION_DAYS = 30;

/** Default rows deleted per batch -- keeps each transaction/lock window bounded. */
const DEFAULT_DELETE_BATCH_SIZE = 5_000;

/** Safety cap on batches per sweep so a huge backlog can't loop forever. */
const MAX_ITERATIONS = 200;

/**
 * DUR-280: the app pool applies a request-shaped 30s `statement_timeout` to
 * every connection (see createDb). One retention batch is the single
 * legitimate app-pool statement that can exceed it: three of the five FK
 * columns pointing at heartbeat_runs.id have no leading-column index
 * (`agent_task_sessions.last_run_id` has none at all;
 * `cost_events.heartbeat_run_id` and `finance_events.heartbeat_run_id` only
 * trail `company_id` in a composite), so Postgres's `ON DELETE SET NULL`
 * triggers do an O(N) scan of each of those tables *per deleted row*. On a
 * busy instance a 5,000-row batch can therefore plausibly run past 30s, and
 * if it did the sweep would fail on its first batch every hour and never
 * make progress -- silently defeating the DUR-319 secret-retention bound.
 *
 * So the sweep lifts the ceiling for its own transaction only. 10 minutes is
 * still finite -- a batch truly wedged on a lock wait is released, and the
 * connection goes back to the pool -- but is ample for a full batch even
 * with the per-row scans above.
 */
export const HEARTBEAT_RUN_RETENTION_STATEMENT_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * DUR-352 (DUR-277 Wave 6): this file deliberately stays bypass-scoped
 * forever, not a candidate for a future runInCompanyScope/per-row wave. Both
 * `pruneHeartbeatRuns` and `startHeartbeatRunRetention` take a plain `Db`
 * (never the request-scoped Proxy) -- the batched DELETE below has no
 * `company_id` predicate at all (verified against the query text), by
 * design: it prunes every company's stale heartbeat_runs rows in one sweep,
 * not one company's. See the DUR-277 design doc §2 (one of the four
 * consumers "no per-company boundary at all").
 *
 * Delete `heartbeat_runs` rows older than `retentionDays`, in batches.
 *
 * DUR-319 (DUR-292 item 4): heartbeat_runs carries per-run stdout/stderr
 * excerpts, result/context JSON, and other content that can carry a secret
 * that slipped past write-time defenses (NOR-316: a leaked GitHub PAT sat
 * live across 706 rows). This bounds how long any such row survives.
 *
 * Batches via a `WHERE ... ORDER BY created_at LIMIT n` subquery rather than
 * one unbounded DELETE -- Postgres DELETE has no direct LIMIT clause, so the
 * batch boundary is expressed as an id set selected first. Five FK
 * constraints into heartbeat_runs.id were widened in migration 0152 (four to
 * ON DELETE SET NULL for tables that should outlive the run they reference,
 * one -- heartbeat_run_events -- to ON DELETE CASCADE since it's the same
 * "may contain secrets" class of data as the run row it belongs to) so this
 * delete no longer fails on a foreign-key violation.
 *
 * @returns The total number of heartbeat_runs rows deleted.
 */
export async function pruneHeartbeatRuns(
  db: Db,
  retentionDays: number = DEFAULT_HEARTBEAT_RUN_RETENTION_DAYS,
  batchSize: number = DEFAULT_DELETE_BATCH_SIZE,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  // postgres-js can't infer a bind type for a raw `Date` parameter in a
  // db.execute(sql`...`) call (it needs a string/Buffer/ArrayBuffer) --
  // pass the ISO string and let Postgres cast it against the timestamptz
  // column instead.
  const cutoffIso = cutoff.toISOString();

  let totalDeleted = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const rows = await db.transaction(async (tx) => {
      // `set_config(..., is_local => true)` is SET LOCAL: it lasts until this
      // transaction ends, so the connection returns to the pool with the
      // DUR-280 default restored. (Plain `SET` cannot take a bind parameter.)
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(HEARTBEAT_RUN_RETENTION_STATEMENT_TIMEOUT_MS)}, true)`,
      );
      return tx.execute(sql`
        WITH batch AS (
          SELECT id FROM heartbeat_runs
          WHERE created_at < ${cutoffIso}
          ORDER BY created_at
          LIMIT ${batchSize}
        )
        DELETE FROM heartbeat_runs
        WHERE id IN (SELECT id FROM batch)
        RETURNING id
      `);
    });
    const deleted = Array.isArray(rows) ? rows.length : 0;

    totalDeleted += deleted;
    iterations++;

    if (deleted < batchSize) break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn(
      { totalDeleted, iterations, cutoffDate: cutoff },
      "Heartbeat run retention hit iteration limit; more expired rows remain for the next sweep",
    );
  }

  if (totalDeleted > 0) {
    logger.info({ totalDeleted, retentionDays }, "Pruned expired heartbeat_runs rows");
  }

  return totalDeleted;
}

/**
 * Start a periodic heartbeat_runs cleanup interval.
 *
 * @param db - Database connection
 * @param intervalMs - How often to run (default: 1 hour)
 * @param retentionDays - How many days of runs to keep (default: 30)
 * @returns A cleanup function that stops the interval
 */
export function startHeartbeatRunRetention(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
  retentionDays: number = DEFAULT_HEARTBEAT_RUN_RETENTION_DAYS,
): () => void {
  const timer = setInterval(() => {
    pruneHeartbeatRuns(db, retentionDays).catch((err) => {
      logger.warn({ err }, "Heartbeat run retention sweep failed");
    });
  }, intervalMs);

  pruneHeartbeatRuns(db, retentionDays).catch((err) => {
    logger.warn({ err }, "Initial heartbeat run retention sweep failed");
  });

  return () => clearInterval(timer);
}
