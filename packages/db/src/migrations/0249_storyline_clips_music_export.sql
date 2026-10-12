-- Storyline Simple editor, Phase 2: mixed clips, sound and export.
--   video_uploads       the company's own photos/videos for a storyline (raw,
--                       working copy, light preview, poster), their age-check
--                       results per picture hash and the consent ticks.
--   video_media_spend   money held for paid steps other than AI transitions
--                       (today "animate this photo"); the monthly cap sums it.
--   video_shots         clip kind (AI shot / uploaded video / photo), trim,
--                       photo motion, per-clip mute and volume.
--   video_storylines    music lane (trim, offset, fades, mix/replace), the
--                       picture shape (aspect) and export settings.
--   video_transitions   kind CHECK widened for the extra free transitions.
-- Additive: new tables and columns with defaults; existing rows keep today's
-- behaviour (AI shots, 16:9, mix, no trims). Only the transitions kind CHECK is
-- dropped and re-added wider.
--
-- Rollback: DROP TABLE "video_media_spend"; ALTER TABLE "video_shots" DROP
-- COLUMN "source_upload_id" (and the other new columns); DROP TABLE
-- "video_uploads"; re-add the narrower video_transitions_kind_check after
-- switching any extra-kind rows to 'fade'.
CREATE TABLE "video_media_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"shot_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_media_spend_kind_check" CHECK ("video_media_spend"."kind" IN ('animate_photo')),
	CONSTRAINT "video_media_spend_status_check" CHECK ("video_media_spend"."status" IN ('reserved', 'settled', 'released')),
	CONSTRAINT "video_media_spend_reserved_check" CHECK ("video_media_spend"."reserved_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"original_filename" text,
	"source_content_type" text NOT NULL,
	"raw_object_key" text,
	"raw_byte_size" bigint DEFAULT 0 NOT NULL,
	"object_key" text,
	"content_type" text,
	"working_byte_size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"preview_object_key" text,
	"preview_content_type" text,
	"preview_byte_size" bigint DEFAULT 0 NOT NULL,
	"poster_object_key" text,
	"poster_byte_size" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"width" integer,
	"height" integer,
	"source_fps_milli" integer,
	"was_hdr" boolean DEFAULT false NOT NULL,
	"was_variable_frame_rate" boolean DEFAULT false NOT NULL,
	"has_audio" boolean DEFAULT false NOT NULL,
	"shows_people" boolean DEFAULT false NOT NULL,
	"consent_likeness" boolean DEFAULT false NOT NULL,
	"consent_adults" boolean DEFAULT false NOT NULL,
	"consent_by_user_id" text,
	"consent_at" timestamp with time zone,
	"age_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_uploads_kind_check" CHECK ("video_uploads"."kind" IN ('video', 'photo')),
	CONSTRAINT "video_uploads_status_check" CHECK ("video_uploads"."status" IN ('processing', 'ready', 'failed')),
	CONSTRAINT "video_uploads_bytes_check" CHECK ("video_uploads"."raw_byte_size" >= 0 AND "video_uploads"."working_byte_size" >= 0 AND "video_uploads"."preview_byte_size" >= 0 AND "video_uploads"."poster_byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "video_transitions" DROP CONSTRAINT "video_transitions_kind_check";--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "clip_kind" text DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "source_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "source_trim_in_ms" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "source_trim_out_ms" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_motion" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "clip_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "clip_volume_db" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_trim_in_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_trim_out_ms" integer;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_offset_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_fade_in_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_fade_out_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "music_audio_mode" text DEFAULT 'mix' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "aspect" text DEFAULT '16:9' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN "export_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "video_media_spend" ADD CONSTRAINT "video_media_spend_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_media_spend" ADD CONSTRAINT "video_media_spend_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_media_spend" ADD CONSTRAINT "video_media_spend_shot_id_video_shots_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."video_shots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_uploads" ADD CONSTRAINT "video_uploads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_uploads" ADD CONSTRAINT "video_uploads_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_uploads" ADD CONSTRAINT "video_uploads_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_media_spend_company_created_idx" ON "video_media_spend" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "video_media_spend_shot_idx" ON "video_media_spend" USING btree ("shot_id","status");--> statement-breakpoint
CREATE INDEX "video_uploads_storyline_idx" ON "video_uploads" USING btree ("storyline_id","created_at");--> statement-breakpoint
CREATE INDEX "video_uploads_company_idx" ON "video_uploads" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "video_uploads_status_idx" ON "video_uploads" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_source_upload_id_video_uploads_id_fk" FOREIGN KEY ("source_upload_id") REFERENCES "public"."video_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_shots_source_upload_idx" ON "video_shots" USING btree ("source_upload_id");--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_clip_kind_check" CHECK ("video_shots"."clip_kind" IN ('generated', 'uploaded_video', 'still'));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_still_motion_check" CHECK ("video_shots"."still_motion" IS NULL OR "video_shots"."still_motion" IN ('hold', 'slow_zoom'));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_source_trim_check" CHECK (("video_shots"."source_trim_in_ms" IS NULL OR "video_shots"."source_trim_in_ms" >= 0) AND ("video_shots"."source_trim_out_ms" IS NULL OR "video_shots"."source_trim_out_ms" > coalesce("video_shots"."source_trim_in_ms", 0)));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_clip_volume_check" CHECK ("video_shots"."clip_volume_db" >= -60 AND "video_shots"."clip_volume_db" <= 12);--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_music_lane_check" CHECK ("video_storylines"."music_trim_in_ms" >= 0 AND ("video_storylines"."music_trim_out_ms" IS NULL OR "video_storylines"."music_trim_out_ms" > "video_storylines"."music_trim_in_ms") AND "video_storylines"."music_offset_ms" >= 0 AND "video_storylines"."music_fade_in_ms" >= 0 AND "video_storylines"."music_fade_in_ms" <= 30000 AND "video_storylines"."music_fade_out_ms" >= 0 AND "video_storylines"."music_fade_out_ms" <= 30000);--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_music_audio_mode_check" CHECK ("video_storylines"."music_audio_mode" IN ('mix', 'replace'));--> statement-breakpoint
ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_aspect_check" CHECK ("video_storylines"."aspect" IN ('16:9', '9:16', '1:1'));--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_kind_check" CHECK ("video_transitions"."kind" IN ('cut', 'blend', 'dissolve', 'fade', 'ai', 'fade_black', 'fade_white', 'wipe_left', 'wipe_right', 'slide_left', 'slide_right', 'circle_open', 'zoom_in', 'pixelize', 'radial'));--> statement-breakpoint
-- Row-level security and grants for the two new tables, the same guarded
-- shape as 0244. Safe where the 0149/0164 roles are absent. Company isolation
-- does NOT rest on this alone: every query in the code also filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['video_uploads', 'video_media_spend'] LOOP
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
