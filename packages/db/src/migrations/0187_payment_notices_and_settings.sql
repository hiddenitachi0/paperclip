-- DUR-4037 (Maja browser step 4: the booking gate). Two new tables, both
-- strictly additive, no row written, no existing column touched.
--
-- After this migration:
--   * company_payment_settings holds the company-wide booking kill switch
--     ("agents.browser_access = book_and_buy AND the company kill switch"
--     from the design). One row per company, created lazily the first time a
--     board owner/admin turns bookings on
--     (server/src/services/company-payment-settings.ts) -- absence reads as
--     "off", same as every other company that never touches this feature.
--   * payment_notices is the outbox for the booking flow's plain-language
--     notifications that are not an approval card -- a receipt once a
--     booking went through, or a hand-over. Modelled on morning_report_outbox
--     (0185) and watcher_alerts (0181): the Telegram bridge polls the
--     'ready' rows and acks them 'delivered'/'failed'; a row nobody acks
--     becomes 'expired' by the same daily sweep. image_file_id points at the
--     existing issue_attachments/assets "Files" mechanism (issue_id null),
--     not a new storage path.
--
-- Every statement is guarded so a re-run is a no-op. No table is discovered
-- by column shape anywhere in this file; the only tables named are ones this
-- codebase owns and declares in packages/db/src/schema.
CREATE TABLE IF NOT EXISTS "company_payment_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"booking_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_payment_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "company_payment_settings" ADD CONSTRAINT "company_payment_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"text" text NOT NULL,
	"image_file_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_company_id_companies_id_fk') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_agent_id_agents_id_fk') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_image_file_id_issue_attachments_id_fk') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_image_file_id_issue_attachments_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_kind_check') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_kind_check" CHECK ("kind" IN ('booking_receipt', 'hand_over'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_notices_status_check') THEN
    ALTER TABLE "payment_notices" ADD CONSTRAINT "payment_notices_status_check" CHECK ("status" IN ('ready', 'delivered', 'failed', 'expired'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_notices_company_status_idx" ON "payment_notices" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_notices_agent_created_idx" ON "payment_notices" USING btree ("agent_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0181/0185 used, so
-- these tables stay in line with the rest of the tenant tables on a database
-- where those roles exist. Safe where the 0149/0164 roles are absent.
-- Company isolation does NOT rest on this: every query in the code filters
-- on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_payment_settings', 'payment_notices'] LOOP
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
