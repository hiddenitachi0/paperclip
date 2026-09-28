-- Morning report: a daily briefing a quick agent sends to its operator's
-- Telegram chat at a configured local time (weather, headlines, hobby news,
-- sport, prices), written by one model call a day.
--
-- After this migration:
--   * agents.morning_report_settings (jsonb, nullable) holds the operator's
--     choice: enabled, time, timezone, place override, sources/topics to
--     pull, price symbols, headline cap. Shape is morningReportSettingsSchema
--     in packages/shared. Null (every existing agent) means "never
--     configured", read by the UI the same as enabled: false. Board-settable
--     only, same guard as the rest of QUICK_AGENT_FIELDS.
--   * agents.morning_report_lease_until (timestamptz, nullable) and
--     agents.morning_report_last_sent_date (text, nullable) are the
--     scheduler tick's own bookkeeping (single-flight lease, and the
--     agent-local calendar day a report was last sent for) — not settings,
--     never board- or agent-writable, only ever written by
--     server/src/services/morning-report.ts.
--   * morning_report_outbox holds one row per day a report was actually
--     generated ('ready' the moment the one LLM call for that day finishes),
--     picked up and acknowledged by the host-side Telegram bridge the same
--     way watcher_alerts is, then 'delivered' or 'failed'. A 'ready' row
--     nobody picked up within a day becomes 'expired' (see
--     MORNING_REPORT_OUTBOX_MAX_AGE_MS in morning-report.ts), so an old
--     briefing is never sent late.
--
-- Strictly additive: three nullable/defaulted columns, one new table, no row
-- written. Every statement is guarded so a re-run is a no-op. No table is
-- discovered by column shape anywhere in this file; the only tables named are
-- ones this codebase owns and declares in packages/db/src/schema.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "morning_report_settings" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "morning_report_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "morning_report_last_sent_date" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "morning_report_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"text" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'morning_report_outbox_company_id_companies_id_fk') THEN
    ALTER TABLE "morning_report_outbox" ADD CONSTRAINT "morning_report_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'morning_report_outbox_agent_id_agents_id_fk') THEN
    ALTER TABLE "morning_report_outbox" ADD CONSTRAINT "morning_report_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'morning_report_outbox_status_check') THEN
    ALTER TABLE "morning_report_outbox" ADD CONSTRAINT "morning_report_outbox_status_check" CHECK ("status" IN ('ready', 'delivered', 'failed', 'expired'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "morning_report_outbox_company_status_idx" ON "morning_report_outbox" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "morning_report_outbox_agent_created_idx" ON "morning_report_outbox" USING btree ("agent_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0181 (watchers) used,
-- so the table stays in line with the rest of the tenant tables on a database
-- where those roles exist. Safe where the 0149/0164 roles are absent. Company
-- isolation does NOT rest on this: every query in the code filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['morning_report_outbox'] LOOP
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
