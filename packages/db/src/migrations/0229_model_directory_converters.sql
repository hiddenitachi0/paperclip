-- DUR-4392: the declarative converter list for one model directory entry (see
-- schema/model_directory_converters.ts). One row per entry; ops is a
-- jsonb array of ModelConverterOp, validated by the service against the
-- fixed allow-list in packages/shared/src/model-converter-engine.ts.
--
-- Strictly additive: one new table, no existing row touched. Every statement
-- is guarded so a re-run is a no-op. Written by hand (same shape `pnpm
-- db:generate` would produce for a from-scratch table) rather than taking
-- the raw generator output: the migrations/meta snapshot chain here is
-- missing several tables added between 0223 and 0228 (local_model_health,
-- issue_overlaps, brag_jobs, cost_reconciliation_runs,
-- sogni_balance_snapshots all already exist live but are absent from
-- 0228_snapshot.json), so a plain `db:generate` run re-proposes CREATE TABLE
-- for all of them plus unrelated column drops/alters. That drift predates
-- this change and is out of scope here; flagged separately so the snapshot
-- chain gets repaired without bundling it into this feature.
--
-- Rollback: DROP TABLE "model_directory_converters". Safe -- nothing
-- references it yet (the agent call path does not read it until DUR-4558
-- wires the engine in), so a rollback only loses recorded converters.
-- The table is also added to the paperclip_tables and company_scope_tables
-- arrays in 0164_rls_login_roles.sql (the same documented exception as
-- 0203_mail_accounts.sql / 0216_model_directory_entries.sql) so
-- rls-login-roles.test.ts stays in sync.
CREATE TABLE IF NOT EXISTS "model_directory_converters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"ops" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_converters_company_id_companies_id_fk') THEN
    ALTER TABLE "model_directory_converters" ADD CONSTRAINT "model_directory_converters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_converters_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "model_directory_converters" ADD CONSTRAINT "model_directory_converters_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_directory_converters_entry_uq" ON "model_directory_converters" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_directory_converters_company_idx" ON "model_directory_converters" USING btree ("company_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0203_mail_accounts /
-- 0216_model_directory_entries used. Safe where the 0149/0164 roles are absent.
-- Company isolation also rests on every query filtering by the caller's
-- company in the service layer.
DO $$
DECLARE
  t text := 'model_directory_converters';
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
