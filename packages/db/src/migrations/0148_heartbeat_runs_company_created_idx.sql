-- DUR-271: GET /companies/:id/heartbeat-runs previously had no bound on
-- `limit` and ordered by created_at with no index covering that order per
-- company, so a single call forced a full sequential scan + external sort
-- of the whole table (16.7s observed live on ~8.6k rows for one company).
-- That single slow query held a DB pool connection long enough for a
-- handful of concurrent callers to exhaust the pool and make every other
-- endpoint (including /api/health) appear to hang.

CREATE INDEX "heartbeat_runs_company_created_idx" ON "heartbeat_runs"("company_id", "created_at");
