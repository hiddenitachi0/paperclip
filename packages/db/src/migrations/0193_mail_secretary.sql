-- DUR-4093: the mail secretary -- a limited-trust duty run (same shape as
-- watchers, migration 0181) that reads an inbox over IMAP read-only, checks
-- per-inbox ignore filters in code, classifies what is left with one cheap
-- model call that has NO tools, and routes in code: ignore, keep for Filip,
-- or delegate a framed copy to Maja. Prerequisite: DUR-4070 (migration 0190),
-- whose lane_a_trust_level column server-side enforcement now also gates
-- (mail_inboxes.agent_id must be "limited" before any tick for that inbox
-- runs at all).
--
-- Three new tables, all company-scoped, no RLS block here (the current
-- convention -- see morning_report_outbox in 0185): this migration's table
-- names are also added to migration 0164's login-role arrays in the same
-- change, which is how a fresh database grants the scoped/bypass roles on
-- them (0164 is otherwise never edited).
--
--   * mail_inboxes: one row per configured inbox. Connection fields (host,
--     port, username, mailbox) are plain config; the IMAP password is never
--     stored here -- credential_secret_id names a company secret, bound to
--     this row through company_secret_bindings (target_type 'mail_inbox',
--     config_path 'imap_password'), entered by a board user only. Starts in
--     practice_mode = true (Filip's decision: a week of "what it would do"
--     before anything real reaches Maja). next_check_at/check_lease_until
--     are the same due/lease pair watchers uses so one inbox is never
--     checked twice at once; last_seen_uid is the fetch cursor so a tick
--     only ever asks for messages newer than the last one it triaged.
--   * mail_inbox_filters: per-inbox ignore rules checked in code before
--     anything reaches the classifier ("everything about Nordstrand"), so a
--     filtered-out message never costs a model call.
--   * mail_secretary_items: one row per fetched message once triaged, plus
--     (when the decision is to delegate) the framed copy handed -- or, in
--     practice mode, that would have been handed -- to Maja. Unique on
--     (inbox_id, message_uid) so a re-fetched message is never triaged
--     twice.
--
-- Strictly additive: three new tables, no row written, no existing row
-- touched. Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "mail_secretary_items", then "mail_inbox_filters",
-- then "mail_inboxes" (that order, children before the parent they
-- reference). Safe -- nothing outside this migration references any of the
-- three tables (no FK from an existing table into them), so a rollback loses
-- only the secretary's own configuration and triage history, not anything
-- else. Undo the 0164 table-name additions in the same change if rolling
-- back before a fresh database is ever created from this state.
CREATE TABLE IF NOT EXISTS "mail_inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"delegate_agent_id" uuid,
	"name" text NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"imap_username" text NOT NULL,
	"imap_mailbox" text DEFAULT 'INBOX' NOT NULL,
	"credential_secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"practice_mode" boolean DEFAULT true NOT NULL,
	"check_every_minutes" integer DEFAULT 10 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_lease_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_message" text,
	"last_seen_uid" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_inbox_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"label" text NOT NULL,
	"field" text NOT NULL,
	"match_type" text NOT NULL,
	"value" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_secretary_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"message_uid" integer NOT NULL,
	"message_id" text,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone,
	"body_excerpt" text,
	"decision" text NOT NULL,
	"filter_label" text,
	"classification" jsonb,
	"practice_mode" boolean NOT NULL,
	"delegate_agent_id" uuid,
	"delegation_status" text DEFAULT 'none' NOT NULL,
	"delegation_category" text,
	"delegated_content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_agent_id_agents_id_fk') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_delegate_agent_id_agents_id_fk') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_delegate_agent_id_agents_id_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_credential_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_check_every_minutes_check') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_check_every_minutes_check" CHECK ("check_every_minutes" >= 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inboxes_imap_port_check') THEN
    ALTER TABLE "mail_inboxes" ADD CONSTRAINT "mail_inboxes_imap_port_check" CHECK ("imap_port" > 0 AND "imap_port" < 65536);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_filters_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_inbox_filters" ADD CONSTRAINT "mail_inbox_filters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_filters_inbox_id_mail_inboxes_id_fk') THEN
    ALTER TABLE "mail_inbox_filters" ADD CONSTRAINT "mail_inbox_filters_inbox_id_mail_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."mail_inboxes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_filters_field_check') THEN
    ALTER TABLE "mail_inbox_filters" ADD CONSTRAINT "mail_inbox_filters_field_check" CHECK ("field" IN ('from', 'subject', 'body', 'any'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_filters_match_type_check') THEN
    ALTER TABLE "mail_inbox_filters" ADD CONSTRAINT "mail_inbox_filters_match_type_check" CHECK ("match_type" IN ('contains', 'domain'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_inbox_id_mail_inboxes_id_fk') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_inbox_id_mail_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."mail_inboxes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_agent_id_agents_id_fk') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_delegate_agent_id_agents_id_fk') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_delegate_agent_id_agents_id_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_decision_check') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_decision_check" CHECK ("decision" IN ('ignored_by_filter', 'ignored_by_classifier', 'kept_for_filip', 'delegated_to_maja', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_secretary_items_delegation_status_check') THEN
    ALTER TABLE "mail_secretary_items" ADD CONSTRAINT "mail_secretary_items_delegation_status_check" CHECK ("delegation_status" IN ('none', 'practice_only', 'ready', 'acknowledged'));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_secretary_items_inbox_uid_uq" ON "mail_secretary_items" USING btree ("inbox_id","message_uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_inboxes_company_idx" ON "mail_inboxes" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_inboxes_due_idx" ON "mail_inboxes" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_inboxes_agent_idx" ON "mail_inboxes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_inbox_filters_inbox_idx" ON "mail_inbox_filters" USING btree ("inbox_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_secretary_items_company_decision_idx" ON "mail_secretary_items" USING btree ("company_id","decision","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_secretary_items_delegate_status_idx" ON "mail_secretary_items" USING btree ("delegate_agent_id","delegation_status","created_at");
