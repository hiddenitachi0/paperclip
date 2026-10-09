-- DUR-4558: model setup reviewer history (see schema/model_setup_reviews.ts).
-- One row per reviewer run: report + applied/proposed changes with before/after
-- for undo. Strictly additive; every statement guarded so a re-run is a no-op.
-- No migrations/meta snapshot is added: the snapshot chain is already missing
-- several tables (see 0229), so `db:generate` output is unusable here.
--
-- Rollback: DROP TABLE "model_setup_reviews". Safe -- nothing references it; it
-- only loses report/undo history, not any entry or converter.
-- Also listed in the two arrays in 0164_rls_login_roles.sql (same documented
-- exception as 0229) so rls-login-roles.test.ts stays in sync.
CREATE TABLE IF NOT EXISTS "model_setup_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"report" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_setup_reviews_company_id_companies_id_fk') THEN
    ALTER TABLE "model_setup_reviews" ADD CONSTRAINT "model_setup_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_setup_reviews_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "model_setup_reviews" ADD CONSTRAINT "model_setup_reviews_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_setup_reviews_entry_idx" ON "model_setup_reviews" USING btree ("entry_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_setup_reviews_company_idx" ON "model_setup_reviews" USING btree ("company_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0203_mail_accounts /
-- 0216_model_directory_entries used. Safe where the 0149/0164 roles are absent.
-- Company isolation also rests on every query filtering by the caller's
-- company in the service layer.
DO $$
DECLARE
  t text := 'model_setup_reviews';
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
