-- DUR-4182: Positions/Jobs backend. A Job is a one-press task definition
-- attached to one or more Positions (company_agent_roles) -- every agent
-- hired into a linked position sees it as a one-click action. See
-- packages/db/src/schema/jobs.ts for the full design rationale (why this is
-- its own table rather than an extension of routines).
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"title" text NOT NULL,
	"instructions" text,
	"status" text DEFAULT 'active' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_mode" text DEFAULT 'full_agent' NOT NULL,
	"model_profile" text,
	"effort" text,
	"output_format" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"public_id" text,
	"secret_id" uuid,
	"signing_mode" text,
	"replay_window_sec" integer,
	"email_match_address" text,
	"last_result" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"trigger_id" uuid,
	"run_agent_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"form_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_issue_id" uuid,
	"idempotency_key" text,
	"failure_reason" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_position_id_company_agent_roles_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."company_agent_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_trigger_id_job_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."job_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_run_agent_id_agents_id_fk" FOREIGN KEY ("run_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_company_status_idx" ON "jobs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "jobs_company_project_idx" ON "jobs" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_positions_job_position_uq" ON "job_positions" USING btree ("job_id","position_id");--> statement-breakpoint
CREATE INDEX "job_positions_company_position_idx" ON "job_positions" USING btree ("company_id","position_id");--> statement-breakpoint
CREATE INDEX "job_triggers_company_job_idx" ON "job_triggers" USING btree ("company_id","job_id");--> statement-breakpoint
CREATE INDEX "job_triggers_company_kind_idx" ON "job_triggers" USING btree ("company_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "job_triggers_public_id_uq" ON "job_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "job_runs_company_job_idx" ON "job_runs" USING btree ("company_id","job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_run_agent_idx" ON "job_runs" USING btree ("run_agent_id");--> statement-breakpoint
CREATE INDEX "job_runs_linked_issue_idx" ON "job_runs" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "job_runs_idempotency_idx" ON "job_runs" USING btree ("job_id","idempotency_key");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0195_mail_secretary /
-- 0196_video_storylines used, so these tables stay in line with the rest of
-- the tenant tables on a database where those roles exist (and so re-running
-- 0164 stays a no-op instead of creating their company-scope policy after the
-- fact). Safe where the 0149/0164 roles are absent. Company isolation does
-- NOT rest on this: every query in the code filters on the caller's company.
--
-- These four tables are also added to the paperclip_tables and
-- company_scope_tables arrays in 0164_rls_login_roles.sql (an explicit,
-- documented exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['jobs', 'job_positions', 'job_triggers', 'job_runs'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format(
          'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
          t
        );
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['jobs', 'job_positions', 'job_triggers', 'job_runs'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
