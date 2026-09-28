-- Watchers: cheap scheduled checks of a market price (crypto, US stocks) that
-- alert the operator on Telegram, in a quick agent's voice, only when a rule
-- fires.
--
-- After this migration:
--   * watchers holds one watcher per row: which quick agent speaks for it,
--     what it watches (source + symbol), the rule (jsonb), how often it checks
--     (at least every 5 minutes), how long it stays quiet after an alert, and
--     the scheduler's state (next check, the lease that stops one watcher
--     being checked twice at once, the last price, the counters shown on the
--     page). A source key is never stored here: key_secret_id names a company
--     secret, bound to the row through company_secret_bindings.
--   * watcher_price_points is the small price history the rules measure
--     windows against; old rows are deleted as new ones arrive.
--   * watcher_alerts is one alert per row and doubles as the outbox the
--     Telegram bridge polls: composing -> ready -> delivered (or failed, or
--     expired when nobody picked it up within a day).
--
-- Strictly additive: three new tables, no row written, no existing row
-- touched. Every statement is guarded so a re-run is a no-op. No table is
-- discovered by column shape anywhere in this file; the only tables named are
-- ones this codebase owns and declares in packages/db/src/schema.
CREATE TABLE IF NOT EXISTS "watchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"rule" jsonb NOT NULL,
	"check_every_minutes" integer DEFAULT 15 NOT NULL,
	"cooldown_minutes" integer DEFAULT 360 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"with_picture" boolean DEFAULT false NOT NULL,
	"key_secret_id" uuid,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_lease_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_price" double precision,
	"last_price_at" timestamp with time zone,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_message" text,
	"last_alert_at" timestamp with time zone,
	"last_alert_price" double precision,
	"condition_met" boolean DEFAULT false NOT NULL,
	"counters_day" text,
	"checks_today" integer DEFAULT 0 NOT NULL,
	"alerts_today" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_company_id_companies_id_fk') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_agent_id_agents_id_fk') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_key_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_source_check') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_source_check" CHECK ("source" IN ('crypto', 'us_stock', 'oslo_stock'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_check_every_minutes_check') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_check_every_minutes_check" CHECK ("check_every_minutes" >= 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watchers_cooldown_minutes_check') THEN
    ALTER TABLE "watchers" ADD CONSTRAINT "watchers_cooldown_minutes_check" CHECK ("cooldown_minutes" >= 0);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watchers_company_idx" ON "watchers" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watchers_due_idx" ON "watchers" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watcher_price_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watcher_id" uuid NOT NULL,
	"price" double precision NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_price_points_company_id_companies_id_fk') THEN
    ALTER TABLE "watcher_price_points" ADD CONSTRAINT "watcher_price_points_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_price_points_watcher_id_watchers_id_fk') THEN
    ALTER TABLE "watcher_price_points" ADD CONSTRAINT "watcher_price_points_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watcher_price_points_watcher_observed_idx" ON "watcher_price_points" USING btree ("watcher_id","observed_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watcher_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"watcher_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'composing' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"facts" jsonb NOT NULL,
	"text" text,
	"image_file_id" uuid,
	"note" text,
	"compose_attempts" integer DEFAULT 0 NOT NULL,
	"compose_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_alerts_company_id_companies_id_fk') THEN
    ALTER TABLE "watcher_alerts" ADD CONSTRAINT "watcher_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_alerts_watcher_id_watchers_id_fk') THEN
    ALTER TABLE "watcher_alerts" ADD CONSTRAINT "watcher_alerts_watcher_id_watchers_id_fk" FOREIGN KEY ("watcher_id") REFERENCES "public"."watchers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_alerts_agent_id_agents_id_fk') THEN
    ALTER TABLE "watcher_alerts" ADD CONSTRAINT "watcher_alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watcher_alerts_status_check') THEN
    ALTER TABLE "watcher_alerts" ADD CONSTRAINT "watcher_alerts_status_check" CHECK ("status" IN ('composing', 'ready', 'delivered', 'failed', 'expired'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watcher_alerts_company_status_idx" ON "watcher_alerts" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watcher_alerts_watcher_created_idx" ON "watcher_alerts" USING btree ("watcher_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0177 and 0180 used,
-- so the tables stay in line with the rest of the tenant tables on a database
-- where those roles exist. Safe where the 0149/0164 roles are absent. Company
-- isolation does NOT rest on this: every query in the code filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['watchers', 'watcher_price_points', 'watcher_alerts'] LOOP
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
    FOREACH t IN ARRAY ARRAY['watchers', 'watcher_price_points', 'watcher_alerts'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
