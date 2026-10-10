-- Agent quality loops (server/src/services/quality-loops.ts): per-company opt-in
-- settings for the self-check pass, the independent finish check (a cheap call to one
-- of the company's own saved models) and the default reviewer for new code tasks.
--
-- Numbered 0244 on purpose: another branch uses 0243 (storyline transitions).
--
-- Strictly additive: one new table, no existing row touched. No row for a company =
-- every quality loop OFF, so every company that exists today keeps its behaviour.
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "company_quality_loop_settings". Safe -- nothing references it;
-- a rollback only loses the companies' quality-loop choices.
-- The table is also added to the paperclip_tables and company_scope_tables arrays in
-- 0164_rls_login_roles.sql (the documented exception, as for 0238) so
-- rls-login-roles.test.ts stays in sync.
CREATE TABLE IF NOT EXISTS "company_quality_loop_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"self_review_passes" integer DEFAULT 0 NOT NULL,
	"done_check_enabled" boolean DEFAULT false NOT NULL,
	"done_check_max_rounds" integer,
	"done_check_directory_entry_id" uuid,
	"default_reviewer_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_quality_loop_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_quality_loop_settings" ADD CONSTRAINT "company_quality_loop_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cqls_done_check_entry_fk') THEN
    ALTER TABLE "company_quality_loop_settings" ADD CONSTRAINT "cqls_done_check_entry_fk" FOREIGN KEY ("done_check_directory_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cqls_default_reviewer_agent_fk') THEN
    ALTER TABLE "company_quality_loop_settings" ADD CONSTRAINT "cqls_default_reviewer_agent_fk" FOREIGN KEY ("default_reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0238 used. Safe where the
-- 0149/0164 roles are absent. Company isolation also rests on every query filtering by
-- the caller's company in server/src/services/quality-loops.ts.
DO $$
DECLARE
  t text := 'company_quality_loop_settings';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
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
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
  END IF;
END $$;
