-- DUR-3945 (redo of the reverted migration 0164_rls_login_roles.sql, which
-- crash-looped production on 2026-09-09): provision the two LOGIN roles the
-- app will connect as once it is rotated off the table-owning credential,
-- give them exactly the privileges they need, and finish the row-level
-- security policy set for Paperclip's own tenant tables.
--
-- WHY THE FIRST ATTEMPT BROKE PRODUCTION
-- --------------------------------------
-- The reverted version discovered tables to police by scanning
-- information_schema for ANY table in `public` with a column named
-- `company_id`. This database does not hold only Paperclip's tables: it also
-- holds a client's Django application tables (core_task,
-- core_companyledgerbinding, integrations_connection, module_governance_*,
-- module_financial_kpis_*, stock_history_*), and their `company_id` is a
-- bigint, not a uuid. The generated policy compared that bigint to a uuid,
-- Postgres refused with `operator does not exist: bigint = uuid`, the
-- migration aborted, and the server could not boot until the deploy was
-- rolled back.
--
-- The lesson is not "add a type cast". It is that a migration must never
-- decide what to touch by pattern-matching the live database. This version
-- therefore names every table explicitly. The lists below are generated from
-- the tables this codebase actually defines in packages/db/src/schema/*.ts
-- and are kept honest by packages/db/src/rls-login-roles.test.ts, which fails
-- if the schema and these lists ever disagree. Nothing outside those lists is
-- read, altered, granted on, or policed by this migration.
--
-- Every named table is additionally checked before it is touched:
--   * table missing        -> RAISE NOTICE and skip (a fresh install or a
--                             partially-migrated database must still boot).
--   * company_id not uuid  -> RAISE EXCEPTION. A table carrying one of
--                             Paperclip's own names but a foreign column type
--                             means the assumption behind every policy here is
--                             wrong, and guessing would reproduce exactly the
--                             outage above. Stop loudly instead, in rehearsal
--                             (scripts/rehearse-migrations.sh) rather than in
--                             production.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Login roles. Migration 0149 created `paperclip_app_scoped` and
--    `paperclip_app_bypass` as NOLOGIN group roles: the first carries the
--    tenant-table GRANTs and is bound by the RLS policies, the second is a
--    pure membership marker the policies check via pg_has_role(). Neither can
--    be connected to. This migration adds:
--
--      paperclip_app_scoped_login  LOGIN, member of paperclip_app_scoped only.
--                                  Bound by RLS on every tenant table. This is
--                                  what DATABASE_URL points at after the final
--                                  cutover step.
--      paperclip_app_bypass_login  LOGIN, member of paperclip_app_bypass only.
--                                  Sees every company (the policies admit it by
--                                  membership) but is NOT superuser, does NOT
--                                  own any table, cannot run DDL, cannot create
--                                  roles. This is what DATABASE_BYPASS_URL
--                                  points at -- and, as an intermediate step,
--                                  what DATABASE_URL can point at to get the
--                                  app off the superuser/owner credential
--                                  before every request path is scope-wired.
--
--    Both are created WITHOUT a password (`PASSWORD NULL`), so this migration
--    is inert on its own: a role with no password cannot authenticate under
--    the password-based pg_hba rules every supported deployment uses. The
--    operator sets passwords by hand as the runbook's first manual step
--    (`ALTER ROLE ... PASSWORD '...'`) -- a migration can never carry a
--    secret, and it must replay cleanly on every fresh bootstrap.
--
--    SECURITY-CRITICAL INVARIANT (migration 0149): nothing that holds
--    paperclip_app_scoped membership may ever hold paperclip_app_bypass
--    membership. The bypass login role therefore does NOT join
--    paperclip_app_scoped to get its table privileges; it is granted them
--    directly, keeping the two memberships disjoint by construction.
--
-- 2. Privilege catch-up. 0149/0150 granted paperclip_app_scoped only the
--    tenant tables they listed. The app also reads/writes the instance-wide
--    tables (auth users/sessions/accounts, instance_settings,
--    cross_company_access_log, untracked_write_incidents, the plugin
--    registry, ...) and every tenant table added by a later migration -- none
--    of which a scoped connection could touch today ("permission denied").
--    This migration grants SELECT/INSERT/UPDATE/DELETE on each of Paperclip's
--    own tables, USAGE/SELECT on the sequences those tables own, and sets
--    default privileges so tables and sequences created by future migrations
--    (run by the owner) are covered automatically. It grants NO DDL: neither
--    role can CREATE/ALTER/DROP anything -- migrations keep running as the
--    owner via DATABASE_MIGRATION_URL.
--
--    DELIBERATE NARROWING vs the reverted version: that one ran
--    `GRANT ... ON ALL TABLES IN SCHEMA public`, which would have handed the
--    Paperclip roles read/write on the client's Django tables as well. Those
--    tables are not ours and Paperclip never reads them, so they are left
--    alone here. For every table Paperclip does define, the resulting
--    privileges are identical to the reverted version's.
--
--    Plugin schemas are still granted wholesale, but only the namespaces
--    registered in plugin_database_namespaces (created by
--    server/src/services/plugin-database.ts) -- those are Paperclip's own, and
--    their table names are not known to this file.
--
-- 3. Policy catch-up. Every Paperclip table with a company_id column that has
--    no paperclip_company_scope policy yet (the tables migrations 0154-0163
--    added after 0149) gets the same policy 0149 applies, nullable-aware.
--    Without this the scoped role would see every company's rows in those
--    tables the moment it could read them at all. Whether a policy admits
--    NULL company_id is decided from the column's real nullability, so a row
--    that is visible today does not disappear.
--
-- 4. pipeline_stages / pipeline_transitions are tenanted indirectly via
--    pipeline_id -> pipelines.company_id (left out of 0149 by name) and get
--    the subquery-shaped policy 0150 used for company_secret_versions.
--    plugin_jobs has no company scope at all and stays instance-wide.
--
-- Everything here is additive and idempotent: no DROP, no REVOKE, every
-- CREATE guarded by an existence check, every GRANT/POLICY re-runnable. The
-- whole migration is a single DO block, and packages/db/src/client.ts runs
-- each migration file inside one transaction, so a failure anywhere leaves
-- the database exactly as it was -- never half a policy set.

DO $$
DECLARE
  owner_role text := current_user;
  db_name text := current_database();

  -- Every table this codebase defines (packages/db/src/schema/*.ts). Only
  -- these are granted on. Regenerate with the check in
  -- packages/db/src/rls-login-roles.test.ts, which fails if this list and the
  -- Drizzle schema ever drift apart.
  paperclip_tables text[] := ARRAY[
    'account',
    'activity_log',
    'agent_api_keys',
    'agent_config_revisions',
    'agent_instructions_revisions',
    'agent_memberships',
    'agent_runtime_state',
    'agent_task_sessions',
    'agent_wakeup_requests',
    'agents',
    'approval_comments',
    'approvals',
    'assets',
    'board_api_keys',
    'board_delegate_tokens',
    'budget_incidents',
    'budget_policies',
    'cli_auth_challenges',
    'cloud_upstream_connections',
    'cloud_upstream_runs',
    'companies',
    'company_agent_roles',
    'company_logos',
    'company_mcp_oauth_connections',
    'company_mcp_tools',
    'company_memberships',
    'company_secret_bindings',
    'company_secret_provider_configs',
    'company_secret_versions',
    'company_secrets',
    -- DUR-3977. The real DDL, grant and policy for this table live in
    -- 0165_lane_a_transform.sql; the name is listed here because
    -- packages/db/src/rls-login-roles.test.ts holds these arrays to the
    -- Drizzle schema exactly, so a table added later must appear here too or
    -- the list silently rots.
    'company_service_tokens',
    'company_skill_comments',
    'company_skill_stars',
    'company_skill_versions',
    'company_skills',
    'company_user_sidebar_preferences',
    'cost_events',
    'cross_company_access_log',
    'cross_company_instructions',
    'customer_inbox_conversations',
    'customer_inbox_deliveries',
    'document_annotation_anchor_snapshots',
    'document_annotation_comments',
    'document_annotation_threads',
    'document_revisions',
    'documents',
    'environment_custom_image_setup_sessions',
    'environment_custom_image_templates',
    'environment_leases',
    'environments',
    'escalation_grants',
    'execution_workspaces',
    'external_object_mentions',
    'external_objects',
    'feedback_exports',
    'feedback_votes',
    'finance_events',
    'goals',
    'heartbeat_run_events',
    'heartbeat_run_watchdog_decisions',
    'heartbeat_runs',
    'inbox_dismissals',
    'instance_claude_auth',
    'instance_settings',
    'instance_user_roles',
    'invites',
    'issue_approvals',
    'issue_attachments',
    'issue_comments',
    'issue_documents',
    'issue_execution_decisions',
    'issue_inbox_archives',
    'issue_labels',
    'issue_plan_decompositions',
    'issue_read_states',
    'issue_recovery_actions',
    'issue_reference_mentions',
    'issue_relations',
    'issue_thread_interactions',
    'issue_tree_hold_members',
    'issue_tree_holds',
    'issue_watchdogs',
    'issue_work_products',
    'issues',
    'join_requests',
    'labels',
    'lane_a_conversations',
    'lane_a_messages',
    'persona_account_publish_counters',
    'persona_accounts',
    'persona_generation_counters',
    'persona_posts',
    'persona_publishing_company_settings',
    'personas',
    'pipeline_automation_executions',
    'pipeline_case_blockers',
    'pipeline_case_documents',
    'pipeline_case_events',
    'pipeline_case_issue_links',
    'pipeline_cases',
    'pipeline_documents',
    'pipeline_stages',
    'pipeline_transitions',
    'pipelines',
    'plugin_company_settings',
    'plugin_config',
    'plugin_database_namespaces',
    'plugin_entities',
    'plugin_job_runs',
    'plugin_jobs',
    'plugin_logs',
    'plugin_managed_resources',
    'plugin_migrations',
    'plugin_state',
    'plugin_webhook_deliveries',
    'plugins',
    'principal_permission_grants',
    'project_goals',
    'project_memberships',
    'project_workspaces',
    'projects',
    'routine_documents',
    'routine_revisions',
    'routine_runs',
    'routine_triggers',
    'routines',
    'secret_access_events',
    'session',
    'untracked_write_incidents',
    'user',
    'user_sidebar_preferences',
    'verification',
    'workspace_operations',
    'workspace_runtime_services'
  ];

  -- The subset of the above that carries a company_id column and is therefore
  -- policed by paperclip_company_scope. Tables policed indirectly (through a
  -- parent row) are handled separately below.
  company_scope_tables text[] := ARRAY[
    'activity_log',
    'agent_api_keys',
    'agent_config_revisions',
    'agent_instructions_revisions',
    'agent_memberships',
    'agent_runtime_state',
    'agent_task_sessions',
    'agent_wakeup_requests',
    'agents',
    'approval_comments',
    'approvals',
    'assets',
    'budget_incidents',
    'budget_policies',
    'cloud_upstream_connections',
    'cloud_upstream_runs',
    'company_agent_roles',
    'company_logos',
    'company_mcp_oauth_connections',
    'company_mcp_tools',
    'company_memberships',
    'company_secret_bindings',
    'company_secret_provider_configs',
    'company_secrets',
    'company_service_tokens',
    'company_skill_comments',
    'company_skill_stars',
    'company_skill_versions',
    'company_skills',
    'company_user_sidebar_preferences',
    'cost_events',
    'customer_inbox_conversations',
    'customer_inbox_deliveries',
    'document_annotation_anchor_snapshots',
    'document_annotation_comments',
    'document_annotation_threads',
    'document_revisions',
    'documents',
    'environment_leases',
    'escalation_grants',
    'execution_workspaces',
    'external_object_mentions',
    'external_objects',
    'feedback_exports',
    'feedback_votes',
    'finance_events',
    'goals',
    'heartbeat_run_events',
    'heartbeat_run_watchdog_decisions',
    'heartbeat_runs',
    'inbox_dismissals',
    'invites',
    'issue_approvals',
    'issue_attachments',
    'issue_comments',
    'issue_documents',
    'issue_execution_decisions',
    'issue_inbox_archives',
    'issue_labels',
    'issue_plan_decompositions',
    'issue_read_states',
    'issue_recovery_actions',
    'issue_reference_mentions',
    'issue_relations',
    'issue_thread_interactions',
    'issue_tree_hold_members',
    'issue_tree_holds',
    'issue_watchdogs',
    'issue_work_products',
    'issues',
    'join_requests',
    'labels',
    'lane_a_conversations',
    'lane_a_messages',
    'persona_account_publish_counters',
    'persona_accounts',
    'persona_generation_counters',
    'persona_posts',
    'persona_publishing_company_settings',
    'personas',
    'pipeline_automation_executions',
    'pipeline_case_blockers',
    'pipeline_case_documents',
    'pipeline_case_events',
    'pipeline_case_issue_links',
    'pipeline_cases',
    'pipeline_documents',
    'pipelines',
    'plugin_company_settings',
    'plugin_entities',
    'plugin_job_runs',
    'plugin_logs',
    'plugin_managed_resources',
    'plugin_webhook_deliveries',
    'principal_permission_grants',
    'project_goals',
    'project_memberships',
    'project_workspaces',
    'projects',
    'routine_documents',
    'routine_revisions',
    'routine_runs',
    'routine_triggers',
    'routines',
    'secret_access_events',
    'untracked_write_incidents',
    'workspace_operations',
    'workspace_runtime_services'
  ];

  -- Tenanted through pipeline_id -> pipelines.company_id rather than a column
  -- of their own.
  indirect_scope_tables text[] := ARRAY['pipeline_stages', 'pipeline_transitions'];

  tbl text;
  seq_name text;
  schema_name text;
  company_id_type text;
  company_id_nullable boolean;
  null_clause text;
  missing_count integer := 0;
  policy_count integer := 0;
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
    RAISE EXCEPTION 'paperclip_app_bypass_login must not hold paperclip_app_scoped membership -- the two memberships are kept disjoint by design';
  END IF;

  -- 2. Database / schema access ----------------------------------------------
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO paperclip_app_scoped, paperclip_app_bypass_login', db_name);
  EXECUTE 'GRANT USAGE ON SCHEMA public TO paperclip_app_scoped, paperclip_app_bypass_login';

  -- 3. Table privileges on Paperclip's own tables only ------------------------
  FOREACH tbl IN ARRAY paperclip_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl AND table_type = 'BASE TABLE'
    ) THEN
      missing_count := missing_count + 1;
      RAISE NOTICE 'Skipping grants for %: table not present in this database', tbl;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO paperclip_app_scoped, paperclip_app_bypass_login', tbl);
  END LOOP;

  -- Sequences owned by those tables (identity/serial columns). Scoped through
  -- pg_depend so no sequence belonging to another application is touched.
  FOR seq_name IN
    SELECT DISTINCT s.relname
    FROM pg_class s
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE s.relkind = 'S'
      AND sn.nspname = 'public'
      AND tn.nspname = 'public'
      AND t.relname = ANY(paperclip_tables)
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO paperclip_app_scoped, paperclip_app_bypass_login', seq_name);
  END LOOP;

  -- Plugin namespaces are Paperclip's own but their table names live in the
  -- plugin, not in this file, so they are granted wholesale -- restricted to
  -- the namespaces the plugin registry actually created.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'plugin_database_namespaces'
  ) THEN
    FOR schema_name IN
      SELECT DISTINCT n.nspname
      FROM plugin_database_namespaces pdn
      JOIN pg_namespace n ON n.nspname = pdn.namespace_name
      WHERE n.nspname NOT IN ('public', 'information_schema', 'drizzle')
        AND n.nspname NOT LIKE 'pg\_%'
    LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO paperclip_app_scoped, paperclip_app_bypass_login', schema_name);
    END LOOP;
  END IF;

  -- Future tables/sequences/schemas created by the owner (every core and
  -- plugin migration runs as the owner via DATABASE_MIGRATION_URL) are
  -- reachable without a follow-up GRANT. Global (no IN SCHEMA) on purpose:
  -- plugin migrations create their own namespaces. This only ever applies to
  -- objects THIS role creates from now on, so another application's tables
  -- are unaffected.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE, SELECT ON SEQUENCES TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO paperclip_app_scoped, paperclip_app_bypass_login', owner_role);

  -- 4. Policy catch-up: Paperclip tables with their own company_id -----------
  FOREACH tbl IN ARRAY company_scope_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl AND table_type = 'BASE TABLE'
    ) THEN
      RAISE NOTICE 'Skipping company scope policy for %: table not present in this database', tbl;
      CONTINUE;
    END IF;

    SELECT c.data_type, c.is_nullable = 'YES'
      INTO company_id_type, company_id_nullable
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = tbl AND c.column_name = 'company_id';

    IF company_id_type IS NULL THEN
      RAISE EXCEPTION 'Table public.% has no company_id column, but this codebase defines one. Refusing to guess -- reconcile the schema before deploying.', tbl;
    END IF;
    IF company_id_type <> 'uuid' THEN
      RAISE EXCEPTION 'Table public.%.company_id is %, not uuid. This is not the table this codebase defines (another application owns a table of the same name). Refusing to add a row-level security policy to it.', tbl, company_id_type;
    END IF;

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'paperclip_company_scope'
    );

    null_clause := CASE WHEN company_id_nullable THEN 'company_id IS NULL OR ' ELSE '' END;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY paperclip_company_scope ON public.%1$I USING (%2$scompany_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (%2$scompany_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
      tbl,
      null_clause
    );
    policy_count := policy_count + 1;
  END LOOP;

  -- 5. Policy catch-up: pipeline_stages / pipeline_transitions ---------------
  -- (indirect tenancy via pipeline_id -> pipelines.company_id; pipelines
  -- itself already carries the 0149 policy, so the subquery is correctly
  -- scoped when the scoped role runs it.)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pipelines' AND column_name = 'company_id' AND data_type = 'uuid'
  ) THEN
    FOREACH tbl IN ARRAY indirect_scope_tables LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = tbl AND table_type = 'BASE TABLE'
      ) THEN
        RAISE NOTICE 'Skipping company scope policy for %: table not present in this database', tbl;
        CONTINUE;
      END IF;

      CONTINUE WHEN EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'paperclip_company_scope'
      );

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format(
        'CREATE POLICY paperclip_company_scope ON public.%1$I USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = %1$I.pipeline_id AND p.company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = %1$I.pipeline_id AND p.company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
        tbl
      );
      policy_count := policy_count + 1;
    END LOOP;
  ELSE
    RAISE NOTICE 'Skipping pipeline_stages/pipeline_transitions policies: pipelines.company_id is missing or is not a uuid';
  END IF;

  RAISE NOTICE 'Row-level security catch-up complete: % new polic(ies), % table(s) not present in this database', policy_count, missing_count;
END $$;
