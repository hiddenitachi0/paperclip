-- DUR-3945 (DUR-244 item 3, DUR-250 Phase 2 cutover, step 1 of the runbook
-- in docs/rls-cutover-runbook.md): provision the two LOGIN roles the app will
-- connect as once it is rotated off the table-owning credential, and give
-- them exactly the privileges they need -- nothing more.
--
-- Migration 0149 created `paperclip_app_scoped` and `paperclip_app_bypass`
-- as NOLOGIN group roles: the first carries the tenant-table GRANTs and is
-- bound by the RLS policies, the second is a pure membership marker the
-- policies check via pg_has_role(). Neither can be connected to. This
-- migration adds:
--
--   paperclip_app_scoped_login  LOGIN, member of paperclip_app_scoped only.
--                               Bound by RLS on every tenant table. This is
--                               what DATABASE_URL points at after the final
--                               cutover step.
--   paperclip_app_bypass_login  LOGIN, member of paperclip_app_bypass only.
--                               Sees every company (the policies admit it by
--                               membership) but is NOT superuser, does NOT
--                               own any table, cannot run DDL, cannot create
--                               roles. This is what DATABASE_BYPASS_URL
--                               points at -- and, as an intermediate step,
--                               what DATABASE_URL can point at to get the app
--                               off the superuser/owner credential before
--                               every request path is scope-wired.
--
-- Both are created WITHOUT a password (`PASSWORD NULL`), so this migration
-- is inert on its own: a role with no password cannot authenticate under
-- the password-based pg_hba rules every supported deployment uses. The
-- operator sets passwords by hand as the runbook's first manual step
-- (`ALTER ROLE ... PASSWORD '...'`) -- a migration can never carry a
-- secret, and it must replay cleanly on every fresh bootstrap.
--
-- SECURITY-CRITICAL INVARIANT (migration 0149): nothing that holds
-- paperclip_app_scoped membership may ever hold paperclip_app_bypass
-- membership. The bypass login role therefore does NOT join
-- paperclip_app_scoped to get its table privileges; it is granted them
-- directly (see below), keeping the two memberships disjoint by
-- construction. packages/db/src/rls-login-roles.test.ts asserts this.
--
-- Privilege catch-up. 0149/0150 granted paperclip_app_scoped only the
-- tenant tables they listed. The app also reads/writes the instance-wide
-- tables (auth users/sessions/accounts, instance_settings,
-- cross_company_access_log, untracked_write_incidents, plugin registry,
-- ...) and every tenant table added by a later migration -- none of which a
-- scoped connection could touch today ("permission denied"). This migration
-- grants SELECT/INSERT/UPDATE/DELETE on every existing table and USAGE on
-- every sequence to both roles, and sets default privileges so tables and
-- sequences created by future migrations (run by the owner) are covered
-- automatically. It grants NO DDL: neither role can CREATE/ALTER/DROP
-- anything -- migrations keep running as the owner via
-- DATABASE_MIGRATION_URL.
--
-- Policy catch-up. Every public table that has a company_id column but no
-- paperclip_company_scope policy yet (the tables migrations 0154-0159 added
-- after 0149) gets the same policy 0149 applies, nullable-aware. Without this
-- the scoped role would see every company's rows in those tables the moment
-- it could read them at all. pipeline_stages/pipeline_transitions (tenanted
-- indirectly via pipeline_id -> pipelines.company_id, left out of 0149 by
-- name) get the subquery-shaped policy 0150 used for
-- company_secret_versions. plugin_jobs has no company scope at all and stays
-- instance-wide. packages/db/src/rls-login-roles.test.ts fails if a future
-- migration adds a company_id table without a policy.
--
-- Everything here is additive and idempotent: no DROP, no REVOKE, every
-- CREATE guarded by an existence check, every GRANT/POLICY re-runnable.

DO $$
DECLARE
  owner_role text := current_user;
  db_name text := current_database();
  schema_name text;
  tbl record;
BEGIN
  -- 1. Login roles -----------------------------------------------------------
  -- INHERIT (the default, spelled out) is what lets membership in the group
  -- role carry its table GRANTs onto the login role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped_login') THEN
    EXECUTE 'CREATE ROLE paperclip_app_scoped_login LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS';
  END IF;
  EXECUTE 'GRANT paperclip_app_scoped TO paperclip_app_scoped_login';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'CREATE ROLE paperclip_app_bypass_login LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS';
  END IF;
  EXECUTE 'GRANT paperclip_app_bypass TO paperclip_app_bypass_login';

  -- Defence in depth against the 0149 invariant being violated by a later
  -- hand-run GRANT: fail this migration loudly rather than proceed.
  IF pg_has_role('paperclip_app_scoped_login', 'paperclip_app_bypass', 'member') THEN
    RAISE EXCEPTION 'paperclip_app_scoped_login must never hold paperclip_app_bypass membership -- see migration 0149 SECURITY-CRITICAL INVARIANT';
  END IF;
  IF pg_has_role('paperclip_app_bypass_login', 'paperclip_app_scoped', 'member') THEN
    RAISE EXCEPTION 'paperclip_app_bypass_login must not hold paperclip_app_scoped membership -- the two memberships are kept disjoint by design (migration 0160)';
  END IF;

  -- 2. Database / schema access ----------------------------------------------
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO paperclip_app_scoped, paperclip_app_bypass_login', db_name);

  FOR schema_name IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'drizzle')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
  END LOOP;

  -- Future tables/sequences/schemas created by the owner (every core and
  -- plugin migration runs as the owner via DATABASE_MIGRATION_URL) are
  -- reachable without a follow-up GRANT. Global (no IN SCHEMA) on purpose:
  -- plugin migrations create their own namespaces.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE, SELECT ON SEQUENCES TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);

  -- 3. Policy catch-up: direct company_id tables added since 0149 ------------
  FOR tbl IN
    SELECT c.table_name, c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'company_id'
      AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.table_name AND p.policyname = 'paperclip_company_scope'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl.table_name);
    IF tbl.is_nullable = 'YES' THEN
      EXECUTE format(
        'CREATE POLICY paperclip_company_scope ON %I USING (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
        tbl.table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
        tbl.table_name
      );
    END IF;
  END LOOP;

  -- 4. Policy catch-up: pipeline_stages / pipeline_transitions ---------------
  -- (indirect tenancy via pipeline_id -> pipelines.company_id; pipelines
  -- itself already carries the 0149 policy, so the subquery is correctly
  -- scoped when the scoped role runs it.)
  FOR tbl IN SELECT unnest(ARRAY['pipeline_stages', 'pipeline_transitions']) AS table_name LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl.table_name)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl.table_name AND policyname = 'paperclip_company_scope') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl.table_name);
      EXECUTE format(
        'CREATE POLICY paperclip_company_scope ON %1$I USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = %1$I.pipeline_id AND p.company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = %1$I.pipeline_id AND p.company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
        tbl.table_name
      );
    END IF;
  END LOOP;
END $$;
