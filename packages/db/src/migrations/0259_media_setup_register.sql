-- Media Studio film studio, Phase 1: the setup register and the LoRA library.
-- (Numbered 0259: 0258 is Phase 0's storyline content rating, PR #667.)
--
-- Four new company-scoped tables, see packages/db/src/schema/media_model_setups.ts
-- and media_model_setup_trials.ts:
--   * media_loras: the company's saved LoRAs (Sogni catalog id, the account's
--     own imported Sogni LoRA, or a link the server never fetches), with notes,
--     trigger words, the LoRA's own strength scale and a content tag
--     (sfw / mature / refused / unreviewed).
--   * media_model_setups: saved recipes ("Action" = MiniMax H3 + Better Motion
--     at 0.8): kind, provider, exact model id, LoRAs with explicit strengths,
--     params, content rating, status (draft / approved / archived).
--   * media_model_setup_trials: the register's scores (1-5 per attribute),
--     cost, time and flags per try of a setup.
--   * media_project_defaults: one row per company with the default picture
--     and video setups, content rating ('sfw') and continuity mode ('stills').
-- New nullable columns:
--   * video_storyline_directors: default_image_setup_id, default_video_setup_id,
--     default_content_rating, default_continuity_mode.
--   * video_storylines: image_setup_id, video_setup_id.
-- Every new foreign key to media_model_setups is ON DELETE SET NULL (cascade
-- for a setup's own trials). No existing row is changed.
--
-- Every statement is guarded so a re-run is a no-op. RLS: the guarded grant +
-- paperclip_company_scope policy block at the end, and all four names are in
-- both arrays of 0164_rls_login_roles.sql.
--
-- Rollback: ALTER TABLE "video_storylines" DROP COLUMN "video_setup_id", DROP
-- COLUMN "image_setup_id"; ALTER TABLE "video_storyline_directors" DROP
-- CONSTRAINT "video_storyline_directors_continuity_mode_check", DROP CONSTRAINT
-- "video_storyline_directors_content_rating_check", DROP COLUMN
-- "default_continuity_mode", DROP COLUMN "default_content_rating", DROP COLUMN
-- "default_video_setup_id", DROP COLUMN "default_image_setup_id"; DROP TABLE
-- "media_model_setup_trials", "media_project_defaults", "media_model_setups",
-- "media_loras"; (that order). The only data lost is the register itself and
-- the setup picks on directors and storylines; their provider/model columns
-- keep the last values copied from a setup.
CREATE TABLE IF NOT EXISTS "media_loras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"trigger_words" text[] DEFAULT '{}' NOT NULL,
	"family" text,
	"compatible_model_ids" text[] DEFAULT '{}' NOT NULL,
	"content_tag" text DEFAULT 'unreviewed' NOT NULL,
	"provider_nsfw" boolean DEFAULT false NOT NULL,
	"provider_sexual" boolean DEFAULT false NOT NULL,
	"strength_min" real,
	"strength_max" real,
	"strength_default" real DEFAULT 0.6 NOT NULL,
	"recommended_min" real,
	"recommended_max" real,
	"builtin_key" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_loras_provider_check" CHECK ("media_loras"."provider" IN ('sogni', 'fal')),
	CONSTRAINT "media_loras_source_check" CHECK ("media_loras"."source" IN ('catalog', 'personal', 'url')),
	CONSTRAINT "media_loras_content_tag_check" CHECK ("media_loras"."content_tag" IN ('sfw', 'mature', 'refused', 'unreviewed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_model_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"provider" text NOT NULL,
	"family" text,
	"mode" text,
	"model_id" text NOT NULL,
	"edit_model_id" text,
	"loras" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_rating" text DEFAULT 'sfw' NOT NULL,
	"mature_enabled_by_user_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"builtin_key" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_model_setups_kind_check" CHECK ("media_model_setups"."kind" IN ('image', 'video')),
	CONSTRAINT "media_model_setups_provider_check" CHECK ("media_model_setups"."provider" IN ('sogni', 'fal', 'higgsfield', 'comfyui') AND ("media_model_setups"."kind" = 'image' OR "media_model_setups"."provider" IN ('sogni', 'fal'))),
	CONSTRAINT "media_model_setups_content_rating_check" CHECK ("media_model_setups"."content_rating" IN ('sfw', 'mature')),
	CONSTRAINT "media_model_setups_status_check" CHECK ("media_model_setups"."status" IN ('draft', 'approved', 'archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_model_setup_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"setup_id" uuid NOT NULL,
	"storyline_id" uuid,
	"persona_id" uuid,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt" text,
	"result_file_id" uuid,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flagged_by_check" boolean DEFAULT false NOT NULL,
	"flagged_by_provider" boolean DEFAULT false NOT NULL,
	"cost_cents" integer,
	"seconds_taken" integer,
	"rater_kind" text DEFAULT 'human' NOT NULL,
	"rater_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_model_setup_trials_rater_kind_check" CHECK ("media_model_setup_trials"."rater_kind" IN ('human', 'ai')),
	CONSTRAINT "media_model_setup_trials_cost_check" CHECK ("media_model_setup_trials"."cost_cents" IS NULL OR "media_model_setup_trials"."cost_cents" >= 0),
	CONSTRAINT "media_model_setup_trials_seconds_check" CHECK ("media_model_setup_trials"."seconds_taken" IS NULL OR "media_model_setup_trials"."seconds_taken" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_project_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"default_image_setup_id" uuid,
	"default_video_setup_id" uuid,
	"default_content_rating" text DEFAULT 'sfw' NOT NULL,
	"default_continuity_mode" text DEFAULT 'stills' NOT NULL,
	"setups_seeded_at" timestamp with time zone,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_project_defaults_content_rating_check" CHECK ("media_project_defaults"."default_content_rating" IN ('sfw', 'mature')),
	CONSTRAINT "media_project_defaults_continuity_mode_check" CHECK ("media_project_defaults"."default_continuity_mode" IN ('stills', 'keyframes'))
);
--> statement-breakpoint
ALTER TABLE "video_storyline_directors" ADD COLUMN IF NOT EXISTS "default_image_setup_id" uuid;
--> statement-breakpoint
ALTER TABLE "video_storyline_directors" ADD COLUMN IF NOT EXISTS "default_video_setup_id" uuid;
--> statement-breakpoint
ALTER TABLE "video_storyline_directors" ADD COLUMN IF NOT EXISTS "default_content_rating" text;
--> statement-breakpoint
ALTER TABLE "video_storyline_directors" ADD COLUMN IF NOT EXISTS "default_continuity_mode" text;
--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "image_setup_id" uuid;
--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "video_setup_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_loras_company_id_companies_id_fk') THEN
    ALTER TABLE "media_loras" ADD CONSTRAINT "media_loras_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_model_setups_company_id_companies_id_fk') THEN
    ALTER TABLE "media_model_setups" ADD CONSTRAINT "media_model_setups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_model_setup_trials_company_id_companies_id_fk') THEN
    ALTER TABLE "media_model_setup_trials" ADD CONSTRAINT "media_model_setup_trials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_model_setup_trials_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "media_model_setup_trials" ADD CONSTRAINT "media_model_setup_trials_setup_id_media_model_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_model_setup_trials_storyline_id_video_storylines_id_fk') THEN
    ALTER TABLE "media_model_setup_trials" ADD CONSTRAINT "media_model_setup_trials_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_model_setup_trials_persona_id_personas_id_fk') THEN
    ALTER TABLE "media_model_setup_trials" ADD CONSTRAINT "media_model_setup_trials_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_project_defaults_company_id_companies_id_fk') THEN
    ALTER TABLE "media_project_defaults" ADD CONSTRAINT "media_project_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_project_defaults_default_image_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "media_project_defaults" ADD CONSTRAINT "media_project_defaults_default_image_setup_id_media_model_setups_id_fk" FOREIGN KEY ("default_image_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_project_defaults_default_video_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "media_project_defaults" ADD CONSTRAINT "media_project_defaults_default_video_setup_id_media_model_setups_id_fk" FOREIGN KEY ("default_video_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_default_image_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_default_image_setup_id_media_model_setups_id_fk" FOREIGN KEY ("default_image_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_default_video_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_default_video_setup_id_media_model_setups_id_fk" FOREIGN KEY ("default_video_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_content_rating_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_content_rating_check" CHECK ("video_storyline_directors"."default_content_rating" IS NULL OR "video_storyline_directors"."default_content_rating" IN ('sfw', 'mature'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_continuity_mode_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_continuity_mode_check" CHECK ("video_storyline_directors"."default_continuity_mode" IS NULL OR "video_storyline_directors"."default_continuity_mode" IN ('stills', 'keyframes'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storylines_image_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_image_setup_id_media_model_setups_id_fk" FOREIGN KEY ("image_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storylines_video_setup_id_media_model_setups_id_fk') THEN
    ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_video_setup_id_media_model_setups_id_fk" FOREIGN KEY ("video_setup_id") REFERENCES "public"."media_model_setups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_loras_company_idx" ON "media_loras" USING btree ("company_id","provider");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_loras_company_ref_uq" ON "media_loras" USING btree ("company_id","provider","ref") WHERE "media_loras"."archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_loras_company_builtin_uq" ON "media_loras" USING btree ("company_id","builtin_key") WHERE "media_loras"."builtin_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_model_setups_company_kind_idx" ON "media_model_setups" USING btree ("company_id","kind","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_model_setups_company_name_uq" ON "media_model_setups" USING btree ("company_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_model_setups_company_builtin_uq" ON "media_model_setups" USING btree ("company_id","builtin_key") WHERE "media_model_setups"."builtin_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_model_setup_trials_setup_idx" ON "media_model_setup_trials" USING btree ("setup_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_model_setup_trials_company_idx" ON "media_model_setup_trials" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_model_setup_trials_storyline_idx" ON "media_model_setup_trials" USING btree ("storyline_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_project_defaults_company_uq" ON "media_project_defaults" USING btree ("company_id");
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['media_loras', 'media_model_setups', 'media_model_setup_trials', 'media_project_defaults'] LOOP
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
    FOREACH t IN ARRAY ARRAY['media_loras', 'media_model_setups', 'media_model_setup_trials', 'media_project_defaults'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
