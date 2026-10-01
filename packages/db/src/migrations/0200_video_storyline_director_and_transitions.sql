-- DUR-4196 (video storylines round 2): director AI drafts, still-frame
-- previews, and per-shot transitions + a music bed for stitching. Hand
-- written rather than `drizzle-kit generate`'d: this sandbox has no TTY, and
-- `drizzle-kit generate` against the full schema needs one here because of
-- pre-existing column-rename ambiguity on unrelated tables (e.g.
-- `environments`) that predates this change -- see packages/db/src/migrations/meta,
-- which already has no snapshot file for any migration past 0099 for the
-- same reason. This migration only touches the tables this ticket's scope
-- covers.
ALTER TABLE "video_storylines" ADD COLUMN "default_transition" text DEFAULT 'cut' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "default_transition_duration_ms" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_source_key" text;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_volume_db" integer DEFAULT -18 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_music_asset_id_assets_id_fk" FOREIGN KEY ("music_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_default_transition_check" CHECK ("video_storylines"."default_transition" IN ('cut', 'fade', 'dissolve'));--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_default_transition_duration_check" CHECK ("video_storylines"."default_transition_duration_ms" >= 0 AND "video_storylines"."default_transition_duration_ms" <= 5000);--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_music_volume_check" CHECK ("video_storylines"."music_volume_db" >= -60 AND "video_storylines"."music_volume_db" <= 0);--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_music_source_exclusive_check" CHECK ("video_storylines"."music_asset_id" IS NULL OR "video_storylines"."music_source_key" IS NULL);--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "transition_in" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_provider" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_object_key" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_content_type" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_byte_size" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_sha256" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "preview_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_transition_in_check" CHECK ("video_shots"."transition_in" IS NULL OR "video_shots"."transition_in" IN ('cut', 'fade', 'dissolve'));--> statement-breakpoint
CREATE TABLE "video_storyline_director_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"idea" text NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"drafted_shots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"decided_by_agent_id" uuid,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_storyline_director_runs_status_check" CHECK ("video_storyline_director_runs"."status" IN ('drafting', 'ready_for_review', 'approved', 'rejected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "video_storyline_director_runs" ADD CONSTRAINT "video_storyline_director_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_runs" ADD CONSTRAINT "video_storyline_director_runs_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_runs" ADD CONSTRAINT "video_storyline_director_runs_scene_id_video_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."video_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_runs" ADD CONSTRAINT "video_storyline_director_runs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_runs" ADD CONSTRAINT "video_storyline_director_runs_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_storyline_director_runs_storyline_idx" ON "video_storyline_director_runs" USING btree ("storyline_id","created_at");--> statement-breakpoint
-- Row-level security and grants for the one new table, the same guarded
-- shape 0196_video_storylines used -- see this repo's convention comment
-- there. video_storylines/video_shots already have RLS enabled from 0196;
-- new columns on an already-policed table need nothing further here.
-- video_storyline_director_runs is also added to migration 0164's
-- paperclip_tables/company_scope_tables arrays (an explicit, documented
-- exception to "never edit an applied migration", same as every other table
-- added after 0164 -- see packages/db/src/rls-login-roles.test.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_runs" TO paperclip_app_scoped;
    ALTER TABLE "video_storyline_director_runs" ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'video_storyline_director_runs' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "video_storyline_director_runs" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_runs" TO paperclip_app_bypass_login;
  END IF;
END $$;
