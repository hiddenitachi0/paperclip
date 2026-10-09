CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"status" text DEFAULT 'fetching_data' NOT NULL,
	"fetched_data" jsonb,
	"script_run_id" uuid,
	"numbers" jsonb,
	"commentary_text" text,
	"ungrounded_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_id" uuid,
	"error" text,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"requested_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_runs_status_check" CHECK ("report_runs"."status" IN ('fetching_data', 'calculating', 'drafting_commentary', 'needs_revision', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_connection_id" uuid,
	"script_version_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_script_run_id_report_script_runs_id_fk" FOREIGN KEY ("script_run_id") REFERENCES "public"."report_script_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_requested_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("requested_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_data_connection_id_data_connections_id_fk" FOREIGN KEY ("data_connection_id") REFERENCES "public"."data_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_script_version_id_report_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."report_script_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_runs_company_created_idx" ON "report_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_template_idx" ON "report_runs" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_templates_company_key_uq" ON "report_templates" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "report_templates_company_idx" ON "report_templates" USING btree ("company_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0240's report_*
-- tables use. Safe where the 0149/0164 roles are absent. Company isolation
-- does NOT rest on this alone: every query in the code also filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_templates', 'report_runs'] LOOP
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
