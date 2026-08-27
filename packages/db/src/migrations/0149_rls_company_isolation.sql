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
-- Every tenant table gets a Postgres Row-Level Security policy keyed on:
--   - app.current_company_id  -- a session-local claim naming the single
--     company this connection/request is scoped to (see
--     packages/db/src/company-scope.ts, withCompanyScope).
--   - membership in the paperclip_app_bypass role -- an explicit escape
--     hatch for trusted first-party code that is legitimately
--     instance-wide (migrations, backups, background schedulers that fan
--     out across every company, board/admin views spanning multiple
--     company memberships) -- see withCompanyScopeBypass() in
--     company-scope.ts, which logs every use to the cross_company_access_log
--     table for transition visibility.
--
-- The bypass is deliberately NOT a session GUC (e.g. `SET app.rls_bypass`):
-- a plain custom GUC is PGC_USERSET, so any SQL statement executed on a
-- connection -- including one reached via an unrelated SQL-injection-shaped
-- bug -- could set it on itself with no privilege check at all, silently
-- defeating this entire boundary. Role membership is a real Postgres
-- privilege check instead: `pg_has_role(current_user, 'paperclip_app_bypass',
-- 'member')` can only be true if some administrator has already run
-- `GRANT paperclip_app_bypass TO <role>` ahead of time. A connection cannot
-- grant this to itself no matter what SQL it runs.
--
-- SECURITY-CRITICAL INVARIANT: paperclip_app_scoped (created below, the
-- role Phase 2 plans to make the app's live, request-serving credential)
-- must NEVER be granted membership in paperclip_app_bypass. If it ever is,
-- every connection using that credential -- including one driving a
-- tainted/injected query -- regains the same self-service bypass this
-- migration removes. Any trusted, instance-wide code path (migrations,
-- backups, cross-company fan-out schedulers) that legitimately needs the
-- bypass must run under a distinct, separately-provisioned role that holds
-- paperclip_app_bypass membership -- never under paperclip_app_scoped.
--
-- A connection with NEITHER claim set (the exact shape of a stray script or
-- a raw `psql "$DATABASE_URL"` session) resolves current_setting(...) to
-- NULL and has no paperclip_app_bypass membership, so the policy denies
-- every row -- default-deny, not default-allow.
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
--
-- Deliberately excluded from the table lists below (flagged in Security
-- Reviewer 2's review of PR #166 -- tracked to be closed by name in DUR-250,
-- Phase 2's ticket, not silently dropped):
--   - pipeline_stages, pipeline_transitions: tenanted only indirectly via
--     pipeline_id -> pipelines.company_id. A correct policy here needs a
--     subquery against pipelines, not a plain column check like every table
--     above -- left for Phase 2 to design and test alongside the other
--     indirect-tenancy cases below rather than rushed into this migration.
--   - plugin_jobs, plugin_job_runs (the latter IS in the nullable-company_id
--     list above via its own column, but plugin_jobs itself is not): the
--     parent plugin_jobs table has no company scope at all today.
--   - company_secret_versions: holds the actual secret material
--     (`material` jsonb, `value_sha256`, `fingerprint_sha256`) and is
--     tenanted only indirectly via secret_id -> company_secrets.company_id.
--     Not granted to paperclip_app_scoped at all, so it fails closed
--     (permission denied) rather than open under this role today -- no
--     active leak from this migration -- but it is exactly the table a
--     repeat of DUR-244 would want to reach, so Phase 2 must not forget it.
--   - cli_auth_challenges: holds requested_company_id (nullable) plus
--     secret_hash/pending_key_hash for in-flight CLI device auth. Lower
--     severity than company_secret_versions since this is pre-auth
--     bootstrap data rather than steady-state tenant data, but the same
--     shape of gap (indirect/nullable tenancy, not yet covered).

DO $$
DECLARE
  tbl text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    CREATE ROLE paperclip_app_scoped NOLOGIN NOBYPASSRLS;
  END IF;

  -- Pure membership marker for the bypass escape hatch -- see the header
  -- comment above. Nothing is ever granted table access through this role
  -- directly; policies check membership in it via pg_has_role(). It is
  -- intentionally never granted to paperclip_app_scoped.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass') THEN
    CREATE ROLE paperclip_app_bypass NOLOGIN NOBYPASSRLS;
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
      'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
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
      'CREATE POLICY paperclip_company_scope ON %I USING (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id IS NULL OR company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
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
  USING (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'))
  WITH CHECK (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
--> statement-breakpoint
-- Transition visibility (scope item 4): every use of the paperclip_app_bypass
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
