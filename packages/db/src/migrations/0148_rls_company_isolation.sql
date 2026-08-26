-- DUR-247: enforce company_id isolation at the database layer, not just in
-- application code. Follow-up to DUR-244 (a company-scoped agent runtime
-- credential was able to read another company's rows by connecting directly
-- to Postgres with DATABASE_URL and skipping every route's
-- eq(table.companyId, companyId) filter -- isolation today exists only in
-- the application layer, so any code path or raw psql session that reaches
-- the database directly sees every company's data).
--
-- Design
-- ------
-- Every tenant table gets a Postgres Row-Level Security policy keyed on two
-- session-local claims that a connection must explicitly set before it can
-- see any row:
--   - app.current_company_id  -- the single company this connection/request
--     is scoped to (see packages/db/src/company-scope.ts, withCompanyScope).
--   - app.rls_bypass          -- an explicit escape hatch for trusted
--     first-party code that is legitimately instance-wide (migrations,
--     backups, background schedulers that fan out across every company,
--     board/admin views spanning multiple company memberships) -- see
--     withCompanyScopeBypass() in the same module, which logs every use to
--     the new cross_company_access_log table for transition visibility.
-- A connection with NEITHER claim set (the exact shape of a stray script or
-- a raw `psql "$DATABASE_URL"` session) resolves both current_setting(...)
-- calls to NULL/false and the policy denies every row -- default-deny, not
-- default-allow.
--
-- Rollout is staged over two phases, because this repo's entire app today
-- runs as ONE shared, long-lived Postgres role that also OWNS every table
-- (see packages/db/src/client.ts createDb()). Table owners bypass RLS
-- entirely unless a table is put under FORCE ROW LEVEL SECURITY -- and
-- forcing it today, before every route and every background scheduler
-- (heartbeat dispatch, routine cron, plugin job scheduler, etc.) sets the
-- session claim, would make the running app see zero rows everywhere the
-- instant this migration applied. That is a self-inflicted outage, not a
-- security fix.
--
-- Phase 1 (this migration): create a new, least-privilege role,
-- `paperclip_app_scoped`, that owns nothing. ENABLE ROW LEVEL SECURITY
-- applies in full to any non-owner role the moment it is granted table
-- access -- no FORCE needed -- so `paperclip_app_scoped` is *fully and
-- immediately* bound by these policies. This is proven directly (bypassing
-- the API and the Postgres owner role both) by
-- packages/db/src/rls-company-isolation.test.ts, which connects as this
-- role and asserts a company-A claim reads zero rows of company B's data.
-- The application's existing DATABASE_URL role is completely unaffected by
-- this migration: it still owns every table and still bypasses RLS exactly
-- as it does today, so there is no behavior change and no outage risk here.
--
-- Phase 2 (tracked as a DUR-247 follow-up, not yet done): wire
-- withCompanyScope/withCompanyScopeBypass into the request middleware and
-- every background scheduler, then either (a) cut the app's live
-- DATABASE_URL over to paperclip_app_scoped, or (b) run
-- `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for every table listed below
-- against the existing owner role. Only after Phase 2 does this boundary
-- bind the credential that was actually implicated in DUR-244.

DO $$
DECLARE
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    CREATE ROLE paperclip_app_scoped NOLOGIN NOBYPASSRLS;
  END IF;

  -- Tables with a NOT NULL company_id: every row belongs to exactly one
  -- company, so the policy is a straight equality check against the claim.
  FOR tbl IN SELECT unnest(ARRAY[
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
    'company_mcp_tools',
    'company_memberships',
    'company_secret_bindings',
    'company_secret_provider_configs',
    'company_secrets',
    'company_skill_comments',
    'company_skill_stars',
    'company_skill_versions',
    'company_skills',
    'company_user_sidebar_preferences',
    'cost_events',
    'customer_inbox_conversations',
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
    'plugin_managed_resources',
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
    'workspace_operations',
    'workspace_runtime_services'
  ])
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR current_setting(''app.rls_bypass'', true) = ''true'') WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR current_setting(''app.rls_bypass'', true) = ''true'')',
      tbl
    );
  END LOOP;

  -- Tables where company_id is nullable (instance-scoped rows can
  -- legitimately have no company): the policy additionally admits NULL rows
  -- so those instance-scoped rows stay visible under a normal company claim,
  -- same as they are today.
  FOR tbl IN SELECT unnest(ARRAY[
    'customer_inbox_deliveries',
    'invites',
    'plugin_entities',
    'plugin_job_runs',
    'plugin_logs',
    'plugin_webhook_deliveries',
    'untracked_write_incidents'
  ])
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY paperclip_company_scope ON %I USING (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR current_setting(''app.rls_bypass'', true) = ''true'') WITH CHECK (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR current_setting(''app.rls_bypass'', true) = ''true'')',
      tbl
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- The tenant "root" table itself: the claim is checked against `id`, not a
-- company_id column.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE companies TO paperclip_app_scoped;
--> statement-breakpoint
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY paperclip_company_scope ON companies
  USING (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR current_setting('app.rls_bypass', true) = 'true')
  WITH CHECK (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR current_setting('app.rls_bypass', true) = 'true');
--> statement-breakpoint
-- Transition visibility (scope item 4): every use of the app.rls_bypass
-- escape hatch is recorded here so a genuinely cross-company legitimate use
-- surfaces before enforcement is flipped on for the app's own role in
-- Phase 2, instead of being discovered after the fact as a silent gap.
CREATE TABLE "cross_company_access_log" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at"         timestamptz NOT NULL DEFAULT now(),
  "reason"              text NOT NULL,
  "actor_type"          text,
  "actor_id"            text,
  "route"               text,
  "company_ids_touched" jsonb
);
--> statement-breakpoint
CREATE INDEX "cross_company_access_log_occurred_at_idx" ON "cross_company_access_log" ("occurred_at");
