-- "Ask Paperclip" helper overlay, Phase 1: per-company helper settings (the
-- default saved model, and the full agent reserved for Phase 3 deeper
-- investigations). The helper's model keys are company_secret_bindings rows
-- (target_type 'helper'), so no key is stored here.
--
-- Numbered 0238 on purpose: branch model-catalogue-v2 adds 0236 and
-- openrouter-hosts may add 0237; renumber at merge if needed.
--
-- Strictly additive: one new table, no existing row touched. Every statement
-- is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "company_helper_settings". Safe -- nothing references
-- it; a rollback loses only the helper's default-model pick.
-- The table is also added to the paperclip_tables and company_scope_tables
-- arrays in 0164_rls_login_roles.sql (the same documented exception as
-- 0216_model_directory_entries.sql) so rls-login-roles.test.ts stays in sync.
CREATE TABLE IF NOT EXISTS "company_helper_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"default_directory_entry_id" uuid,
	"investigation_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_helper_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_helper_settings" ADD CONSTRAINT "company_helper_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_helper_settings_default_directory_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "company_helper_settings" ADD CONSTRAINT "company_helper_settings_default_directory_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("default_directory_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_helper_settings_investigation_agent_id_agents_id_fk') THEN
    ALTER TABLE "company_helper_settings" ADD CONSTRAINT "company_helper_settings_investigation_agent_id_agents_id_fk" FOREIGN KEY ("investigation_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0216 used. Safe
-- where the 0149/0164 roles are absent. Company isolation also rests on every
-- query filtering by the caller's company in server/src/services/helper.ts.
DO $$
DECLARE
  t text := 'company_helper_settings';
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
