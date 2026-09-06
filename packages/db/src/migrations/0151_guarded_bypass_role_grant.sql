-- DUR-269: grant the live app role membership in paperclip_app_bypass so the
-- reserved-connection bypass path (packages/db/src/company-scope.ts,
-- runInCompanyScopeBypass/withCompanyScopeBypass) can be wired into
-- board/board_delegate/none-actor request handling and background
-- schedulers without throwing on every call -- see migration 0149's header
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
-- migration 0149's SECURITY-CRITICAL INVARIANT ("paperclip_app_scoped must
-- NEVER be granted paperclip_app_bypass membership"), silently, with no code
-- change and no review trigger to catch it.
--
-- The DO block below makes that impossible: it fails the migration (and so
-- the deploy) loudly instead of ever issuing that grant. This is safe to run
-- today regardless of which Phase 2 cutover option is eventually chosen --
-- see the DUR-275 design review decision for the full reasoning.
--
-- Deliberate deviation, acknowledged: DUR-269's own issue description said
-- this grant "needs to land in the same change as the first real bypass
-- call-site, not before." This migration ships ahead of DUR-277 (which adds
-- the actual withCompanyScopeBypass call-sites), not with it. That's a
-- conscious tradeoff, not an oversight -- flagged non-blocking by security
-- review because table ownership (Phase 1, migration 0149) bypasses RLS
-- unconditionally today, so this grant is inert until Phase 2 changes table
-- ownership. If DUR-277 is delayed after a Phase 2 ownership cutover lands,
-- re-review this grant before relying on the "currently inert" reasoning.
--
-- Membership check, not name equality -- with a superuser carve-out: DUR-275's
-- design review flagged that a bare `CURRENT_USER = 'paperclip_app_scoped'`
-- check misses indirect membership (e.g. a future login role joining
-- paperclip_app_scoped as a group role without being named that literally),
-- so the guard below checks real Postgres role membership via pg_has_role()
-- instead. That alone is not sufficient, though: pg_has_role() unconditionally
-- returns true for a superuser regardless of actual membership (verified
-- against this exact migration -- the table-owning role that replays every
-- migration on a fresh bootstrap is a superuser in this repo's deployment
-- shape), which would make the guard misfire and block this grant for the
-- ordinary, intended case. A superuser already bypasses RLS entirely with or
-- without paperclip_app_bypass membership (same as the table-owner bypass
-- migration 0149's header describes), so exempting a superuser from this
-- check does not reopen the invariant it protects.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER)
     AND pg_has_role(CURRENT_USER, 'paperclip_app_scoped', 'member') THEN
    RAISE EXCEPTION 'refusing to grant paperclip_app_bypass to a role that holds paperclip_app_scoped membership -- see migration 0149 SECURITY-CRITICAL INVARIANT';
  END IF;

  EXECUTE format('GRANT paperclip_app_bypass TO %I', CURRENT_USER);
END $$;
