-- Storyline directors and the AI story writer (approved by Filip, 18 Oct
-- 2026). Design: packages/shared/src/video-storyline-directors.ts.
--
-- Two new company-scoped tables:
--   * video_storyline_directors: per-company named directors (writing model,
--     optional picture-analysis model, optional tool-helper model, each with
--     an optional key secret; creativity/thinking; style instructions;
--     default video and picture settings).
--   * video_storyline_writer_messages: the story writer's chat per storyline
--     (brief, analysis, questions, answers, what was written, change lists).
-- One new nullable column on an existing table:
--   * video_storylines.director_id: which director writes the storyline.
-- No existing row is written or changed. The two starter directors are
-- created by the server the first time a company opens its directors, not
-- here.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: ALTER TABLE "video_storylines" DROP COLUMN IF EXISTS "director_id";
-- DROP TABLE IF EXISTS "video_storyline_writer_messages";
-- DROP TABLE IF EXISTS "video_storyline_directors";
-- DROP FUNCTION IF EXISTS enforce_video_storyline_writer_message_company_id();
CREATE TABLE IF NOT EXISTS "video_storyline_directors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"builtin_key" text,
	"writing_entry_id" uuid,
	"writing_key_secret_id" uuid,
	"analysis_entry_id" uuid,
	"analysis_key_secret_id" uuid,
	"helper_entry_id" uuid,
	"helper_key_secret_id" uuid,
	"temperature" real,
	"thinking" text,
	"style_instructions" text DEFAULT '' NOT NULL,
	"default_video_provider_id" text,
	"default_video_model" text,
	"default_look_id" text,
	"default_shot_seconds" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_storyline_writer_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"director_id" uuid,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"status" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "director_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_company_id_companies_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_writing_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_writing_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("writing_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_analysis_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_analysis_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("analysis_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_helper_entry_id_model_directory_entries_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_helper_entry_id_model_directory_entries_id_fk" FOREIGN KEY ("helper_entry_id") REFERENCES "public"."model_directory_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_writing_key_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_writing_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("writing_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_analysis_key_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_analysis_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("analysis_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_helper_key_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_helper_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("helper_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_thinking_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_thinking_check" CHECK ("thinking" IS NULL OR "thinking" IN ('on', 'off'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_provider_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_provider_check" CHECK ("default_video_provider_id" IS NULL OR "default_video_provider_id" IN ('fal', 'sogni'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_shot_seconds_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_shot_seconds_check" CHECK ("default_shot_seconds" IS NULL OR ("default_shot_seconds" >= 1 AND "default_shot_seconds" <= 60));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_directors_temperature_check') THEN
    ALTER TABLE "video_storyline_directors" ADD CONSTRAINT "video_storyline_directors_temperature_check" CHECK ("temperature" IS NULL OR ("temperature" >= 0 AND "temperature" <= 2));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_company_id_companies_id_fk') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_storyline_id_video_storylines_id_fk') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_director_id_video_storyline_directors_id_fk') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_director_id_video_storyline_directors_id_fk" FOREIGN KEY ("director_id") REFERENCES "public"."video_storyline_directors"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_role_check') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_role_check" CHECK ("role" IN ('writer', 'person', 'system'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_kind_check') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_kind_check" CHECK ("kind" IN ('brief', 'analysis', 'question', 'answer', 'storyboard', 'change_request', 'change_set', 'note'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storyline_writer_messages_status_check') THEN
    ALTER TABLE "video_storyline_writer_messages" ADD CONSTRAINT "video_storyline_writer_messages_status_check" CHECK ("status" IS NULL OR "status" IN ('pending', 'applied', 'partly_applied', 'discarded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'video_storylines_director_id_video_storyline_directors_id_fk') THEN
    ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_director_id_video_storyline_directors_id_fk" FOREIGN KEY ("director_id") REFERENCES "public"."video_storyline_directors"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_storyline_directors_company_idx" ON "video_storyline_directors" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_storyline_directors_company_name_uq" ON "video_storyline_directors" USING btree ("company_id", lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_storyline_writer_messages_storyline_created_idx" ON "video_storyline_writer_messages" USING btree ("storyline_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_storyline_writer_messages_company_idx" ON "video_storyline_writer_messages" USING btree ("company_id");--> statement-breakpoint
-- Defence in depth, same pattern as video_storyline_director_messages (0211):
-- a writer message's company_id is forced to its storyline's company on
-- every insert/update.
CREATE OR REPLACE FUNCTION enforce_video_storyline_writer_message_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM video_storylines WHERE id = NEW.storyline_id;
  IF resolved_company_id IS NULL THEN
    RAISE EXCEPTION '% references storyline % which does not exist', TG_TABLE_NAME, NEW.storyline_id;
  END IF;
  IF NEW.company_id IS DISTINCT FROM resolved_company_id THEN
    RAISE WARNING 'Forcing % company_id to % for storyline % to match its storyline; caller supplied %',
      TG_TABLE_NAME, resolved_company_id, NEW.storyline_id, NEW.company_id;
  END IF;
  NEW.company_id := resolved_company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_storyline_writer_messages_enforce_company_id ON "video_storyline_writer_messages";
--> statement-breakpoint
CREATE TRIGGER video_storyline_writer_messages_enforce_company_id
  BEFORE INSERT OR UPDATE OF storyline_id, company_id ON "video_storyline_writer_messages"
  FOR EACH ROW EXECUTE FUNCTION enforce_video_storyline_writer_message_company_id();
--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0251 used. Safe
-- where the 0149/0164 roles are absent. Company isolation does NOT rest on
-- this: every query in the code filters on the caller's company. Both
-- tables are also listed in both arrays of 0164.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['video_storyline_directors', 'video_storyline_writer_messages'] LOOP
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
    FOREACH t IN ARRAY ARRAY['video_storyline_directors', 'video_storyline_writer_messages'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
