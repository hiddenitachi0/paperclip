-- Media Studio code-rendered videos (D14; plan card "Code-rendered video
-- worker for infographics and explainers"). (Numbered 0260: 0258 is
-- storyline-content-rating and 0259 is media-setup-register.)
--
-- One new company-scoped table, see packages/db/src/schema/code_render_jobs.ts:
--   * code_render_jobs: one row per check / snapshot / render job sent to the
--     locked-down render worker (docker/render-worker). Holds who asked, the
--     video seconds it counts against the daily caps, the worker's job id and
--     the saved result (an issue_attachments row = a Files entry).
-- No existing table or row is changed. Every statement is guarded so a re-run
-- is a no-op. RLS: the guarded grant + paperclip_company_scope policy block at
-- the end, and the name is in both arrays of 0164_rls_login_roles.sql.
--
-- Rollback: DROP TABLE "code_render_jobs"; nothing references it, so the only
-- data lost is the job history (the saved videos stay in Files).
CREATE TABLE IF NOT EXISTS "code_render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"issue_id" uuid,
	"worker_job_id" text,
	"requested_seconds" integer DEFAULT 0 NOT NULL,
	"video_ms" integer,
	"progress_pct" integer,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_file_id" uuid,
	"result_content_type" text,
	"result_bytes" bigint,
	"passed" boolean,
	"report" jsonb,
	"error" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_render_jobs_company_id_companies_id_fk') THEN
    ALTER TABLE "code_render_jobs" ADD CONSTRAINT "code_render_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_render_jobs_issue_id_issues_id_fk') THEN
    ALTER TABLE "code_render_jobs" ADD CONSTRAINT "code_render_jobs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_render_jobs_result_file_id_issue_attachments_id_fk') THEN
    ALTER TABLE "code_render_jobs" ADD CONSTRAINT "code_render_jobs_result_file_id_issue_attachments_id_fk" FOREIGN KEY ("result_file_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_render_jobs_created_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "code_render_jobs" ADD CONSTRAINT "code_render_jobs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_render_jobs_company_created_idx" ON "code_render_jobs" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_render_jobs_company_status_idx" ON "code_render_jobs" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_render_jobs_agent_created_idx" ON "code_render_jobs" USING btree ("created_by_agent_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_render_jobs_status_idx" ON "code_render_jobs" USING btree ("status");
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['code_render_jobs'] LOOP
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
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['code_render_jobs'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
