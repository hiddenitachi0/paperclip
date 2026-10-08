-- Settings > Models, catalogue v2: model family and size/variant as their
-- own fields, the owner's own test ratings per entry, and a per-company
-- settings row (graphics memory of the computer that runs local models, and
-- the address of this company's local model server). The graphics memory is
-- informational only; the address is the default for new local model setups.
--
-- Idempotent. model_directory_entries keeps its RLS and grants from 0216;
-- the new model_directory_settings table gets the same guarded block.
--
-- Rollback: DROP TABLE "model_directory_settings";
-- ALTER TABLE "model_directory_entries" DROP COLUMN "family", DROP COLUMN "variant", DROP COLUMN "ratings".
CREATE TABLE IF NOT EXISTS "model_directory_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"local_gpu_vram_gb" real,
	"local_base_url" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "model_directory_settings" ADD COLUMN IF NOT EXISTS "local_base_url" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "family" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "variant" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "ratings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "model_directory_settings" ADD CONSTRAINT "model_directory_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Row-level security and grants, the same guarded shape as 0216.
DO $$
DECLARE
  t text := 'model_directory_settings';
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
