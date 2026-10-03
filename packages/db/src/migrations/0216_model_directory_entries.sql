-- DUR-4379 (foundation for DUR-4378): the company model directory -- saved
-- model setups (provider, model id, address, OpenRouter host routing, default
-- thinking/temperature/answer length, backup chain of other entries, note).
-- No API key is stored here; keys stay in company secrets.
--
-- Strictly additive: one new table, no existing row touched. Every statement
-- is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "model_directory_entries". Safe -- nothing references
-- it, so a rollback loses only the saved directory entries; agents keep the
-- model settings already copied onto them.
-- The table is also added to the paperclip_tables and company_scope_tables
-- arrays in 0164_rls_login_roles.sql (the same documented exception as
-- 0203_mail_accounts.sql) so rls-login-roles.test.ts stays in sync.
CREATE TABLE IF NOT EXISTS "model_directory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"provider_routing" jsonb,
	"default_thinking" text,
	"default_temperature" real,
	"default_max_output_tokens" integer,
	"backup_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_directory_entries_thinking_check" CHECK ("model_directory_entries"."default_thinking" IS NULL OR "model_directory_entries"."default_thinking" IN ('on', 'off'))
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "model_directory_entries" ADD CONSTRAINT "model_directory_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_directory_entries_company_idx" ON "model_directory_entries" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_directory_entries_company_name_uq" ON "model_directory_entries" USING btree ("company_id","name");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0203_mail_accounts
-- used. Safe where the 0149/0164 roles are absent. Company isolation also
-- rests on every query filtering by the caller's company in
-- server/src/services/model-directory.ts.
DO $$
DECLARE
  t text := 'model_directory_entries';
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
