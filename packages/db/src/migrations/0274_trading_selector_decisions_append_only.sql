-- DUR-5171: the selector's decisions are append-only.
--
-- 0273 already refuses UPDATE on trading_selector_decisions. DELETE was still
-- possible, and a decision must be reproducible from the stored trades, so a
-- row may not vanish either (deleting a decision would also cascade away the
-- confirmation windows that name it).
--
-- What this migration does (additive; no row is read or changed):
--   * a BEFORE DELETE row trigger on trading_selector_decisions that refuses the
--     delete, EXCEPT when the decision's company no longer exists, which is the
--     foreign-key cascade of deleting a whole company (the one removal that
--     stays allowed, as with every other tenant table);
--   * DELETE is withdrawn from the two app roles where they exist (the trigger
--     is the real guard; this is a second layer for the roles).
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only removes the guard; no data is touched, so nothing is
-- orphaned or lost; the decisions table behaves as it did after 0273):
--   DROP TRIGGER IF EXISTS trading_selector_decisions_no_delete ON "trading_selector_decisions";
--   DROP FUNCTION IF EXISTS trading_selector_decisions_no_delete();
--   GRANT DELETE ON TABLE "trading_selector_decisions" TO paperclip_app_scoped, paperclip_app_bypass_login;
--     (only for the roles that exist; the grant is optional if neither exists)
CREATE OR REPLACE FUNCTION trading_selector_decisions_no_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
    RAISE EXCEPTION 'trading_selector_decisions: a decision is a record and is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_selector_decisions_no_delete ON "trading_selector_decisions";
--> statement-breakpoint
CREATE TRIGGER trading_selector_decisions_no_delete
  BEFORE DELETE ON "trading_selector_decisions"
  FOR EACH ROW EXECUTE FUNCTION trading_selector_decisions_no_delete();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    REVOKE DELETE ON TABLE "trading_selector_decisions" FROM paperclip_app_scoped;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    REVOKE DELETE ON TABLE "trading_selector_decisions" FROM paperclip_app_bypass_login;
  END IF;
END $$;
