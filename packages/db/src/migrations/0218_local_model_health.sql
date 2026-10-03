-- DUR-4419: last known health + outage state of a local model (derived state).
-- Rollback: DROP TABLE "local_model_health" (rebuilt by the next health check).
CREATE TABLE "local_model_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reachable_at" timestamp with time zone,
	"outage_started_at" timestamp with time zone,
	"outage_notified_at" timestamp with time zone,
	"evening_warned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_model_health_status_check" CHECK ("local_model_health"."status" IN ('ready', 'unreachable', 'model_missing'))
);
--> statement-breakpoint
ALTER TABLE "local_model_health" ADD CONSTRAINT "local_model_health_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_model_health_target_uq" ON "local_model_health" USING btree ("company_id","base_url","model");--> statement-breakpoint
CREATE INDEX "local_model_health_company_idx" ON "local_model_health" USING btree ("company_id","status");
--> statement-breakpoint
DO $$
DECLARE
  t text := 'local_model_health';
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
