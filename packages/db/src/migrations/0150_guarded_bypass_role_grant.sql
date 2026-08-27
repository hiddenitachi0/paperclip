-- DUR-269: grant the live app role membership in paperclip_app_bypass so the
-- reserved-connection bypass path (packages/db/src/company-scope.ts,
-- runInCompanyScopeBypass/withCompanyScopeBypass) can be wired into
-- board/board_delegate/none-actor request handling and background
-- schedulers without throwing on every call -- see migration 0148's header
-- for why the bypass is a role-membership check, not a settable session GUC.
--
-- Guarded, not a plain `GRANT paperclip_app_bypass TO CURRENT_USER`: this
-- migration replays in full against every freshly bootstrapped environment
-- (applyPendingMigrations/migratePostgresIfEmpty in packages/db/src/client.ts
-- both run the entire migration set against an empty database). If a future
-- Phase 2 cutover (DUR-250 item 3, not yet decided) ever switches the live
-- DATABASE_URL role to paperclip_app_scoped, replaying this migration
-- unguarded against an environment bootstrapped *after* that cutover would
-- grant paperclip_app_bypass to paperclip_app_scoped -- directly violating
-- migration 0148's SECURITY-CRITICAL INVARIANT ("paperclip_app_scoped must
-- NEVER be granted paperclip_app_bypass membership"), silently, with no code
-- change and no review trigger to catch it.
--
-- The DO block below makes that impossible: it fails the migration (and so
-- the deploy) loudly instead of ever issuing that grant. This is safe to run
-- today regardless of which Phase 2 cutover option is eventually chosen --
-- see the DUR-275 design review decision for the full reasoning.
DO $$
BEGIN
  IF CURRENT_USER = 'paperclip_app_scoped' THEN
    RAISE EXCEPTION 'refusing to grant paperclip_app_bypass to paperclip_app_scoped -- see migration 0148 SECURITY-CRITICAL INVARIANT';
  END IF;

  EXECUTE format('GRANT paperclip_app_bypass TO %I', CURRENT_USER);
END $$;
