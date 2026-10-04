-- DUR-4072 PR1: the calculation-script runner's tables.
--
-- After this migration:
--   * report_scripts: a named calculation script, company-scoped. Just the
--     stable identity (company_id, key) versions attach to.
--   * report_script_versions: an immutable version of a script -- source
--     files (jsonb: relative path -> text), an optional `uv` lockfile, JSON
--     Schemas for input/output, and `sha256`, the script fingerprint the
--     ticket asks for (a digest over the files + lockfile, reusing the
--     trusted-code.ts fingerprinting pattern). status moves
--     draft -> tested -> approved -> retired; approval_pair_check makes "no
--     row can claim status='approved' without an approver and a timestamp"
--     a database rule, not just an application check, so an agent cannot
--     activate its own script version through any code path that forgets
--     the service-layer guard.
--   * report_fixtures: a saved input/expected-output pair a version must
--     reproduce (tolerance '0' = exact, the "to the krone" case).
--   * report_script_runs: the append-only execution ledger -- every
--     sandboxed run's input, output and the fingerprints (script + built
--     runtime) it ran under, whether triggered by a fixture test or (once
--     PR2 lands) a real report run.
--
-- Strictly additive: four new tables, no existing table touched, no row
-- written. Every statement is guarded so a re-run is a no-op. No table is
-- discovered by column shape anywhere in this file; the only tables named
-- are ones this codebase owns and declares in packages/db/src/schema.
CREATE TABLE IF NOT EXISTS "report_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_script_versions" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"script_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected_output" jsonb NOT NULL,
	"tolerance" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_script_runs" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_scripts_company_id_companies_id_fk') THEN
    ALTER TABLE "report_scripts" ADD CONSTRAINT "report_scripts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_scripts_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "report_scripts" ADD CONSTRAINT "report_scripts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_versions_company_id_companies_id_fk') THEN
    ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_versions_script_id_report_scripts_id_fk') THEN
    ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_script_id_report_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."report_scripts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_versions_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_versions_status_check') THEN
    ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_status_check" CHECK ("status" IN ('draft', 'tested', 'approved', 'retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_versions_approval_pair_check') THEN
    ALTER TABLE "report_script_versions" ADD CONSTRAINT "report_script_versions_approval_pair_check" CHECK (("status" <> 'approved') OR ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_fixtures_company_id_companies_id_fk') THEN
    ALTER TABLE "report_fixtures" ADD CONSTRAINT "report_fixtures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_fixtures_script_version_id_report_script_versions_id_fk') THEN
    ALTER TABLE "report_fixtures" ADD CONSTRAINT "report_fixtures_script_version_id_report_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."report_script_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_fixtures_tolerance_check') THEN
    ALTER TABLE "report_fixtures" ADD CONSTRAINT "report_fixtures_tolerance_check" CHECK ("tolerance" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_company_id_companies_id_fk') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_script_version_id_report_script_versions_id_fk') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_script_version_id_report_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."report_script_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_fixture_id_report_fixtures_id_fk') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_fixture_id_report_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."report_fixtures"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_requested_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_requested_by_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_requested_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("requested_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_trigger_check') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_trigger_check" CHECK ("trigger" IN ('fixture_test', 'manual', 'report_run'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_script_runs_status_check') THEN
    ALTER TABLE "report_script_runs" ADD CONSTRAINT "report_script_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'timeout', 'fingerprint_mismatch'));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_scripts_company_key_uq" ON "report_scripts" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_scripts_company_idx" ON "report_scripts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_script_versions_script_version_uq" ON "report_script_versions" USING btree ("script_id","version_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_script_versions_company_idx" ON "report_script_versions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_script_versions_script_idx" ON "report_script_versions" USING btree ("script_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_fixtures_script_version_name_uq" ON "report_fixtures" USING btree ("script_version_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_fixtures_company_idx" ON "report_fixtures" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_script_runs_company_created_idx" ON "report_script_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_script_runs_script_version_idx" ON "report_script_runs" USING btree ("script_version_id");--> statement-breakpoint
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
