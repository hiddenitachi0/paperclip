-- DUR-316: one open ticket per unique secret-scan finding (surface +
-- location + pattern, hashed into origin_fingerprint by
-- server/src/services/secret-surface-scanner.ts) so a leaked credential that
-- keeps showing up on every sweep files exactly one issue instead of a new
-- duplicate every tick -- same two-layer app-check + DB-constraint pattern
-- as issues_active_task_watchdog_uq / issues_active_liveness_recovery_leaf_uq
-- above it.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_secret_scan_finding_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'secret_scan_finding'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
