-- Voice messages in the Telegram quick-agent chat (and the in-app chat).
--
-- The operator can hold the mic in Telegram, speak to a quick agent, and get
-- the answer as text and read aloud. Speech-to-text and text-to-speech go
-- through OpenAI with a company secret (an OpenAI API key) the operator picks;
-- that choice is a company_secret_bindings row (target_type 'speech'), not a
-- column here.
--
-- After this migration:
--   * telegram_bots.voice_reply_mode (text, NOT NULL, default 'when_voice',
--     one of 'never' / 'when_voice' / 'always') says when a bot reads its
--     answer aloud; telegram_bots.voice (text, nullable) is the voice it reads
--     with, null meaning the default voice.
--   * company_speech_settings holds at most one row per company with the
--     daily allowances (seconds of speech-to-text, characters of
--     text-to-speech). No row means the defaults (60 minutes, 50,000
--     characters).
--   * speech_usage_events records one row per successful speech call (kind
--     'transcribe' with seconds, or 'speak' with characters), which is what
--     the daily allowance is checked against. Deleting the company deletes
--     them; deleting a bot keeps the rows with telegram_bot_id set to null.
--
-- Strictly additive: two defaulted columns, two new tables, no row written.
-- Every existing bot gets 'when_voice', which does nothing until the operator
-- picks a key, since no speech call can be made without one. Every statement
-- is guarded so a re-run is a no-op. No table is discovered by column shape
-- anywhere in this file; the only tables named are ones this codebase owns and
-- declares in packages/db/src/schema.
ALTER TABLE "telegram_bots" ADD COLUMN IF NOT EXISTS "voice_reply_mode" text DEFAULT 'when_voice' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD COLUMN IF NOT EXISTS "voice" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_bots_voice_reply_mode_check') THEN
    ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_voice_reply_mode_check" CHECK ("voice_reply_mode" IN ('never', 'when_voice', 'always'));
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_speech_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"daily_transcribe_seconds_cap" integer DEFAULT 3600 NOT NULL,
	"daily_speak_characters_cap" integer DEFAULT 50000 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "speech_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"telegram_bot_id" uuid,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_speech_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_speech_settings" ADD CONSTRAINT "company_speech_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_speech_settings_caps_check') THEN
    ALTER TABLE "company_speech_settings" ADD CONSTRAINT "company_speech_settings_caps_check" CHECK ("daily_transcribe_seconds_cap" >= 0 AND "daily_speak_characters_cap" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'speech_usage_events_company_id_companies_id_fk') THEN
    ALTER TABLE "speech_usage_events" ADD CONSTRAINT "speech_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'speech_usage_events_telegram_bot_id_telegram_bots_id_fk') THEN
    ALTER TABLE "speech_usage_events" ADD CONSTRAINT "speech_usage_events_telegram_bot_id_telegram_bots_id_fk" FOREIGN KEY ("telegram_bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'speech_usage_events_kind_check') THEN
    ALTER TABLE "speech_usage_events" ADD CONSTRAINT "speech_usage_events_kind_check" CHECK ("kind" IN ('transcribe', 'speak'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'speech_usage_events_amount_check') THEN
    ALTER TABLE "speech_usage_events" ADD CONSTRAINT "speech_usage_events_amount_check" CHECK ("amount" >= 0);
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_speech_settings_company_uq" ON "company_speech_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "speech_usage_events_company_kind_created_idx" ON "speech_usage_events" USING btree ("company_id","kind","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0177 and 0180 used,
-- so the tables stay in line with the rest of the tenant tables on a database
-- where those roles exist. Safe where the 0149/0164 roles are absent. Company
-- isolation does NOT rest on this: every query in the code filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_speech_settings', 'speech_usage_events'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format('CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))', t);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END IF;
  END LOOP;
END $$;
