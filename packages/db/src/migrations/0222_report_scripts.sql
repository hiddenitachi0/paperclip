CREATE TABLE "report_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"script_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected_output" jsonb NOT NULL,
	"tolerance" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_fixtures_tolerance_check" CHECK ("report_fixtures"."tolerance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "report_script_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"script_version_id" uuid NOT NULL,
	"fixture_id" uuid,
	"trigger" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_sha256" text NOT NULL,
	"output" jsonb,
	"output_sha256" text,
	"script_sha256" text NOT NULL,
	"runtime_fingerprint" text,
	"status" text DEFAULT 'running' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"fixture_result" jsonb,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"requested_by_run_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_script_runs_trigger_check" CHECK ("report_script_runs"."trigger" IN ('fixture_test', 'manual', 'report_run')),
	CONSTRAINT "report_script_runs_status_check" CHECK ("report_script_runs"."status" IN ('running', 'succeeded', 'failed', 'timeout', 'fingerprint_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "report_script_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"script_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entrypoint" text DEFAULT 'main.py' NOT NULL,
	"lockfile" text,
	"sha256" text NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_script_versions_status_check" CHECK ("report_script_versions"."status" IN ('draft', 'tested', 'approved', 'retired')),
	CONSTRAINT "report_script_versions_approval_pair_check" CHECK (("report_script_versions"."status" <> 'approved') OR ("report_script_versions"."approved_by_user_id" IS NOT NULL AND "report_script_versions"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "report_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_fixtures" ADD CONSTRAINT "report_fixtures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_fixtures" ADD CONSTRAINT "report_fixtures_script_version_id_report_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."report_script_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_script_version_id_report_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."report_script_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_fixture_id_report_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."report_fixtures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_requested_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("requested_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_script_id_report_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."report_scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_scripts" ADD CONSTRAINT "report_scripts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_scripts" ADD CONSTRAINT "report_scripts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_fixtures_script_version_name_uq" ON "report_fixtures" USING btree ("script_version_id","name");--> statement-breakpoint
CREATE INDEX "report_fixtures_company_idx" ON "report_fixtures" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "report_script_runs_company_created_idx" ON "report_script_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "report_script_runs_script_version_idx" ON "report_script_runs" USING btree ("script_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_script_versions_script_version_uq" ON "report_script_versions" USING btree ("script_id","version_no");--> statement-breakpoint
CREATE INDEX "report_script_versions_company_idx" ON "report_script_versions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "report_script_versions_script_idx" ON "report_script_versions" USING btree ("script_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_scripts_company_key_uq" ON "report_scripts" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "report_scripts_company_idx" ON "report_scripts" USING btree ("company_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0181 (watchers) and
-- 0185 (morning_report_outbox) used, so these tables stay in line with the
-- rest of the tenant tables on a database where those roles exist. Safe
-- where the 0149/0164 roles are absent. Company isolation does NOT rest on
-- this alone: every query in the code also filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_scripts', 'report_script_versions', 'report_fixtures', 'report_script_runs'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format('CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))', t);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END IF;
  END LOOP;
END $$;
