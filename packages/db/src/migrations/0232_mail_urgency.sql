-- DUR-4573: urgency classification + Telegram alert outbox for a per-person
-- mail account. Idempotent DDL. Rollback: DROP TABLE "mail_urgency_alerts";
-- DROP TABLE "mail_message_classifications"; (nothing else references them).
CREATE TABLE IF NOT EXISTS "mail_message_classifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "urgent" boolean NOT NULL,
  "category" text NOT NULL,
  "reason" text NOT NULL,
  "summary" text NOT NULL,
  "fallback" boolean DEFAULT false NOT NULL,
  "operator_feedback" text,
  "classified_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_urgency_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "status" text DEFAULT 'composing' NOT NULL,
  "text" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ready_at" timestamp with time zone,
  "delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_message_classifications_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_message_classifications" ADD CONSTRAINT "mail_message_classifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_message_classifications_message_id_mail_messages_id_fk') THEN
    ALTER TABLE "mail_message_classifications" ADD CONSTRAINT "mail_message_classifications_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_message_classifications_feedback_check') THEN
    ALTER TABLE "mail_message_classifications" ADD CONSTRAINT "mail_message_classifications_feedback_check" CHECK ("operator_feedback" IS NULL OR "operator_feedback" IN ('correct', 'incorrect'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_urgency_alerts_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_urgency_alerts" ADD CONSTRAINT "mail_urgency_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_urgency_alerts_message_id_mail_messages_id_fk') THEN
    ALTER TABLE "mail_urgency_alerts" ADD CONSTRAINT "mail_urgency_alerts_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_urgency_alerts_status_check') THEN
    ALTER TABLE "mail_urgency_alerts" ADD CONSTRAINT "mail_urgency_alerts_status_check" CHECK ("status" IN ('composing', 'ready', 'delivered', 'failed', 'expired'));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_message_classifications_message_uq" ON "mail_message_classifications" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_message_classifications_company_urgent_idx" ON "mail_message_classifications" USING btree ("company_id","urgent","classified_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_urgency_alerts_message_uq" ON "mail_urgency_alerts" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_urgency_alerts_company_status_idx" ON "mail_urgency_alerts" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- Row-level security and grants: the same guarded shape 0203_mail_accounts
-- used. Company isolation does NOT rest on this; every query filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['mail_message_classifications', 'mail_urgency_alerts'] LOOP
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
    FOREACH t IN ARRAY ARRAY['mail_message_classifications', 'mail_urgency_alerts'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
