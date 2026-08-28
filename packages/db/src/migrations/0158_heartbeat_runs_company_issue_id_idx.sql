-- NOR-301: the per-issue heartbeat-history lookup (used on every heartbeat
-- platform-wide) filters on (company_id, context_snapshot ->> 'issueId') and
-- orders by created_at/id, but no index covers the JSONB expression predicate.
-- EXPLAIN ANALYZE confirmed a sequential scan over the whole table (~10,574
-- rows, 271 MB and growing) on every call. Under concurrent load, several of
-- these seq scans land at once and, with a small app-side DB pool, starve
-- every other /api/* request waiting on a free connection (see also
-- DUR-271, migration 0148, for the sibling query-storm incident).
--
-- Plain (non-concurrent) CREATE INDEX, matching the precedent set by
-- migrations 0148 and 0153 for this table.

CREATE INDEX "heartbeat_runs_company_issue_id_idx" ON "heartbeat_runs"("company_id", (("context_snapshot" ->> 'issueId')));
