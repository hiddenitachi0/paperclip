CREATE TABLE "video_storylines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider_id" text DEFAULT 'fal' NOT NULL,
	"model" text,
	"budget_cap_cents" integer,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"estimated_total_cents" integer,
	"estimated_total_seconds" integer,
	"character_reference_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_provider" text,
	"final_object_key" text,
	"final_content_type" text,
	"final_byte_size" integer,
	"final_sha256" text,
	"final_duration_seconds" integer,
	"stitch_blocked_reason" text,
	"error_message" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_storylines_status_check" CHECK ("video_storylines"."status" IN ('draft', 'estimated', 'rendering', 'paused', 'ready_to_stitch', 'stitching', 'done', 'failed', 'cancelled')),
	CONSTRAINT "video_storylines_provider_check" CHECK ("video_storylines"."provider_id" IN ('fal', 'sogni')),
	CONSTRAINT "video_storylines_budget_cap_check" CHECK ("video_storylines"."budget_cap_cents" IS NULL OR "video_storylines"."budget_cap_cents" >= 0),
	CONSTRAINT "video_storylines_spent_cents_check" CHECK ("video_storylines"."spent_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_scenes_order_index_check" CHECK ("video_scenes"."order_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"prompt" text NOT NULL,
	"camera_notes" text,
	"duration_seconds" integer DEFAULT 5 NOT NULL,
	"look_reference_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider_id" text,
	"model" text,
	"result_provider" text,
	"result_object_key" text,
	"result_content_type" text,
	"result_byte_size" integer,
	"result_sha256" text,
	"estimated_cost_cents" integer,
	"actual_cost_cents" integer,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_shots_order_index_check" CHECK ("video_shots"."order_index" >= 0),
	CONSTRAINT "video_shots_duration_seconds_check" CHECK ("video_shots"."duration_seconds" > 0 AND "video_shots"."duration_seconds" <= 60),
	CONSTRAINT "video_shots_attempt_check" CHECK ("video_shots"."attempt" >= 0),
	CONSTRAINT "video_shots_status_check" CHECK ("video_shots"."status" IN ('draft', 'queued', 'rendering', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "video_shot_render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"shot_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "video_shot_render_jobs_status_check" CHECK ("video_shot_render_jobs"."status" IN ('running', 'done', 'failed')),
	CONSTRAINT "video_shot_render_jobs_provider_check" CHECK ("video_shot_render_jobs"."provider" IN ('fal', 'sogni'))
);
--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_scene_id_video_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."video_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shot_render_jobs" ADD CONSTRAINT "video_shot_render_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shot_render_jobs" ADD CONSTRAINT "video_shot_render_jobs_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_shot_render_jobs" ADD CONSTRAINT "video_shot_render_jobs_shot_id_video_shots_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."video_shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_storylines_company_idx" ON "video_storylines" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "video_storylines_company_status_idx" ON "video_storylines" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "video_storylines_stitch_queue_idx" ON "video_storylines" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_scenes_storyline_order_uq" ON "video_scenes" USING btree ("storyline_id","order_index");--> statement-breakpoint
CREATE INDEX "video_scenes_company_idx" ON "video_scenes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_shots_storyline_order_uq" ON "video_shots" USING btree ("storyline_id","order_index");--> statement-breakpoint
CREATE INDEX "video_shots_storyline_status_idx" ON "video_shots" USING btree ("storyline_id","status");--> statement-breakpoint
CREATE INDEX "video_shots_scene_idx" ON "video_shots" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "video_shot_render_jobs_shot_idx" ON "video_shot_render_jobs" USING btree ("shot_id","attempt");--> statement-breakpoint
CREATE INDEX "video_shot_render_jobs_poll_queue_idx" ON "video_shot_render_jobs" USING btree ("status","started_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0195_mail_secretary
-- used, so these tables stay in line with the rest of the tenant tables on a
-- database where those roles exist (and so re-running 0164 stays a no-op
-- instead of creating their company-scope policy after the fact). Safe where
-- the 0149/0164 roles are absent. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company.
--
-- These four tables are also added to the paperclip_tables and
-- company_scope_tables arrays in 0164_rls_login_roles.sql (an explicit,
-- documented exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['video_storylines', 'video_scenes', 'video_shots', 'video_shot_render_jobs'] LOOP
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
    FOREACH t IN ARRAY ARRAY['video_storylines', 'video_scenes', 'video_shots', 'video_shot_render_jobs'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
