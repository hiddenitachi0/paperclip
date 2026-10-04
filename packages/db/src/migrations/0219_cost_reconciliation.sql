-- DUR-4462: daily Fal/Sogni billing reconciliation bookkeeping. Additive:
-- two new tables, no existing row touched.
-- Rollback: DROP TABLE "cost_reconciliation_runs"; DROP TABLE "sogni_balance_snapshots";
-- (nothing references them; the next run re-takes the Sogni baseline).
CREATE TABLE IF NOT EXISTS "cost_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"day" text NOT NULL,
	"status" text NOT NULL,
	"mismatch_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sogni_balance_snapshots" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"spark" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_reconciliation_runs" ADD CONSTRAINT "cost_reconciliation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sogni_balance_snapshots" ADD CONSTRAINT "sogni_balance_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_reconciliation_runs_company_provider_day_uq" ON "cost_reconciliation_runs" USING btree ("company_id","provider","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_reconciliation_runs_company_created_idx" ON "cost_reconciliation_runs" USING btree ("company_id","created_at");--> statement-breakpoint
-- Row-level security and grants, same guarded shape as 0216_model_directory_entries.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_reconciliation_runs', 'sogni_balance_snapshots'] LOOP
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
  END LOOP;
END $$;
