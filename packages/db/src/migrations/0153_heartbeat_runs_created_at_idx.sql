-- DUR-319 (DUR-292 item 4): the retention sweep in
-- server/src/services/heartbeat-run-retention.ts deletes batches ordered by
-- `WHERE created_at < cutoff ORDER BY created_at LIMIT N`, scoped across all
-- companies (it is a global age-based cleanup, not a per-company query). The
-- existing "heartbeat_runs_company_created_idx" (migration 0148) is
-- (company_id, created_at) -- useless for a cross-company range scan on
-- created_at alone, which would otherwise force a sequential scan of the
-- whole (273 MB and growing) table on every sweep. Follows migration 0148's
-- precedent of a plain (non-concurrent) CREATE INDEX.

CREATE INDEX "heartbeat_runs_created_at_idx" ON "heartbeat_runs"("created_at");
