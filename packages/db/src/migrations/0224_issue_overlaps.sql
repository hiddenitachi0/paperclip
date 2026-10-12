-- DUR-4468: derived overlap detections between open issues (see schema/issue_overlaps.ts).
-- Rollback: DROP TABLE "issue_overlaps" (pure derived data, rebuilt by the next detection run).
CREATE TABLE "issue_overlaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_a_id" uuid NOT NULL,
	"issue_b_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail_key" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"warned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_issue_a_id_issues_id_fk" FOREIGN KEY ("issue_a_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_overlaps" ADD CONSTRAINT "issue_overlaps_issue_b_id_issues_id_fk" FOREIGN KEY ("issue_b_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_overlaps_pair_kind_detail_uq" ON "issue_overlaps" USING btree ("company_id","issue_a_id","issue_b_id","kind","detail_key");--> statement-breakpoint
CREATE INDEX "issue_overlaps_company_status_idx" ON "issue_overlaps" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "issue_overlaps_issue_a_idx" ON "issue_overlaps" USING btree ("issue_a_id");--> statement-breakpoint
CREATE INDEX "issue_overlaps_issue_b_idx" ON "issue_overlaps" USING btree ("issue_b_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0216_model_directory_entries.sql
-- used. Also listed in the paperclip_tables / company_scope_tables arrays in
-- 0164_rls_login_roles.sql so rls-login-roles.test.ts stays in sync.
DO $$
DECLARE
  t text := 'issue_overlaps';
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