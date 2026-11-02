-- DUR-5017: vigilance alerts (market-weather flips, unusually big moves,
-- breaker trips, strategies left paused after a restart, daily summary).
--
-- Two additive changes, nothing existing is rewritten:
--   1. trading_alerts.dedupe_key (nullable) plus a partial unique index on
--      (company_id, dedupe_key): one vigilance event occurrence can be queued
--      once, however often the check that finds it runs. Existing rows keep a
--      NULL key and are outside the index, so they cannot collide.
--   2. trading_alert_settings: one row per company with a switch per event and
--      the two numbers the events use. A company without a row has everything
--      on (the application default), so no backfill is needed.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "trading_alert_settings"; DROP INDEX
-- "trading_alerts_dedupe_uq"; ALTER TABLE "trading_alerts" DROP COLUMN
-- "dedupe_key". Safe: the column and table are read only by the vigilance
-- code; after the rollback every event is simply on and un-deduplicated, and
-- no existing alert row is touched.
ALTER TABLE "trading_alerts" ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_alerts_dedupe_uq" ON "trading_alerts" USING btree ("company_id","dedupe_key") WHERE "trading_alerts"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_alert_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"weather_flips_on" boolean DEFAULT true NOT NULL,
	"big_moves_on" boolean DEFAULT true NOT NULL,
	"breaker_trips_on" boolean DEFAULT true NOT NULL,
	"paused_after_restart_on" boolean DEFAULT true NOT NULL,
	"daily_summary_on" boolean DEFAULT true NOT NULL,
	"big_move_atr_k" double precision DEFAULT 3 NOT NULL,
	"paused_after_restart_hours" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_alert_settings_big_move_check" CHECK ("trading_alert_settings"."big_move_atr_k" >= 1 AND "trading_alert_settings"."big_move_atr_k" <= 10),
	CONSTRAINT "trading_alert_settings_paused_hours_check" CHECK ("trading_alert_settings"."paused_after_restart_hours" >= 1 AND "trading_alert_settings"."paused_after_restart_hours" <= 72)
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_alert_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_alert_settings" ADD CONSTRAINT "trading_alert_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0263 used for trading_alerts.
DO $$
DECLARE
  t text := 'trading_alert_settings';
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
