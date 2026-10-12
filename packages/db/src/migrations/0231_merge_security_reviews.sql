CREATE TABLE IF NOT EXISTS "company_security_review_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"security_reviewer_agent_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_security_review_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_security_review_settings" ADD CONSTRAINT "company_security_review_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_security_review_settings_security_reviewer_agent_id_agents_id_fk') THEN
    ALTER TABLE "company_security_review_settings" ADD CONSTRAINT "company_security_review_settings_security_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("security_reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_security_review_settings_company_uq" ON "company_security_review_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merge_security_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"review_issue_id" uuid,
	"head_commit" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"reviewer_agent_id" uuid,
	"reviewer_user_id" text,
	"verdict_note" text,
	"verdict_comment_url" text,
	"decided_at" timestamp with time zone,
	"created_by_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_security_reviews_company_id_companies_id_fk') THEN
    ALTER TABLE "merge_security_reviews" ADD CONSTRAINT "merge_security_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_security_reviews_approval_id_approvals_id_fk') THEN
    ALTER TABLE "merge_security_reviews" ADD CONSTRAINT "merge_security_reviews_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_security_reviews_review_issue_id_issues_id_fk') THEN
    ALTER TABLE "merge_security_reviews" ADD CONSTRAINT "merge_security_reviews_review_issue_id_issues_id_fk" FOREIGN KEY ("review_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_security_reviews_requested_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "merge_security_reviews" ADD CONSTRAINT "merge_security_reviews_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merge_security_reviews_reviewer_agent_id_agents_id_fk') THEN
    ALTER TABLE "merge_security_reviews" ADD CONSTRAINT "merge_security_reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merge_security_reviews_approval_created_idx" ON "merge_security_reviews" USING btree ("approval_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merge_security_reviews_company_idx" ON "merge_security_reviews" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merge_security_reviews_open_request_uq" ON "merge_security_reviews" USING btree ("approval_id","head_commit") WHERE "merge_security_reviews"."status" = 'requested';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_security_review_settings" TO paperclip_app_scoped;
    ALTER TABLE "company_security_review_settings" ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'company_security_review_settings' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "company_security_review_settings" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "merge_security_reviews" TO paperclip_app_scoped;
    ALTER TABLE "merge_security_reviews" ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'merge_security_reviews' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "merge_security_reviews" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_security_review_settings" TO paperclip_app_bypass_login;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "merge_security_reviews" TO paperclip_app_bypass_login;
  END IF;
END $$;
