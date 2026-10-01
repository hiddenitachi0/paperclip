-- DUR-4194: per-person mail accounts, step 1 of "work platform: email inside
-- Paperclip" (DUR-4149). Distinct from mail_secretary (migration 0195,
-- DUR-4093): that feature is a read-only duty run that triages one agent's
-- inbox. This is the real client -- inbox, read, search, reply/compose with
-- an AI draft, move, archive, and (human only) send.
--
-- Two new tables, both company-scoped, same guarded RLS/grant shape
-- 0195_mail_secretary.sql used (see the block at the end of this file):
--
--   * mail_accounts: one row per mailbox. owner_user_id is the human it
--     belongs to (a company_memberships.principal_id, same shape as
--     private_access_events.target_user_id -- not a foreign key, for the
--     same reason that table's isn't). Not company-owned: reading this
--     account's messages outside the owner's own session goes through the
--     emergency-access route (server/src/services/private-access.ts,
--     targetKind "mail_account"), which always writes a reasoned audit row
--     first. pa_agent_id is the one agent (if any) allowed to read this
--     inbox and prepare drafts for the owner -- never to send; sendDraft is
--     board-actor-and-owner only, enforced in code regardless of this
--     column. IMAP and SMTP passwords are never stored here:
--     imap_credential_secret_id / smtp_credential_secret_id name company
--     secrets, bound through company_secret_bindings (target_type
--     'mail_account', config_path 'imap_password' / 'smtp_password'),
--     entered by the owner or a board owner/admin. Sync cursor fields
--     (next_check_at/check_lease_until/last_seen_uid) are the same
--     due/lease/cursor shape mail_inboxes uses, so one account is never
--     polled twice at once.
--   * mail_messages: one row per message, synced inbound mail and composed
--     outbound mail (drafts and sent) alike. folder tracks which view it
--     currently belongs to (inbox/archive/sent/drafts/trash). Unique on
--     (account_id, message_uid) -- Postgres treats each NULL as distinct, so
--     this only dedupes a re-fetched IMAP message against itself and never
--     blocks two drafts (both null) on the same account. Move/archive are
--     LOCAL ONLY for v1: they relabel folder on our own row, they do not
--     call IMAP MOVE/COPY against the origin mailbox (see "Questions for
--     Filip" in the DUR-4194 PR).
--
-- Strictly additive: two new tables, no row written, no existing row
-- touched. Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "mail_messages", then "mail_accounts" (children
-- before the parent they reference). Safe -- nothing outside this migration
-- references either table, so a rollback loses only this feature's mailbox
-- configuration and synced/composed message history, never anything else.
-- These two tables are also added to the paperclip_tables and
-- company_scope_tables arrays in 0164_rls_login_roles.sql (an explicit,
-- documented exception to "never edit an applied migration"), so
-- packages/db/src/rls-login-roles.test.ts stays in sync with the schema.
CREATE TABLE IF NOT EXISTS "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"pa_agent_id" uuid,
	"display_name" text NOT NULL,
	"email_address" text NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"imap_username" text NOT NULL,
	"imap_mailbox" text DEFAULT 'INBOX' NOT NULL,
	"imap_credential_secret_id" uuid,
	"smtp_host" text NOT NULL,
	"smtp_port" integer DEFAULT 587 NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"smtp_username" text NOT NULL,
	"smtp_credential_secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"check_every_minutes" integer DEFAULT 5 NOT NULL,
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
CREATE TABLE IF NOT EXISTS "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text DEFAULT 'inbox' NOT NULL,
	"direction" text NOT NULL,
	"message_uid" integer,
	"message_id" text,
	"in_reply_to_message_id" text,
	"from_address" text NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"ai_drafted" boolean DEFAULT false NOT NULL,
	"draft_edited_by_user_id" text,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_pa_agent_id_agents_id_fk') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_pa_agent_id_agents_id_fk" FOREIGN KEY ("pa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_imap_credential_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_imap_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("imap_credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_smtp_credential_secret_id_company_secrets_id_fk') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_smtp_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("smtp_credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_imap_port_check') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_imap_port_check" CHECK ("imap_port" > 0 AND "imap_port" < 65536);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_smtp_port_check') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_smtp_port_check" CHECK ("smtp_port" > 0 AND "smtp_port" < 65536);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_check_every_minutes_check') THEN
    ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_check_every_minutes_check" CHECK ("check_every_minutes" >= 1);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_messages_company_id_companies_id_fk') THEN
    ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_messages_account_id_mail_accounts_id_fk') THEN
    ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_messages_folder_check') THEN
    ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_folder_check" CHECK ("folder" IN ('inbox', 'archive', 'sent', 'drafts', 'trash'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_messages_direction_check') THEN
    ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_direction_check" CHECK ("direction" IN ('inbound', 'outbound'));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_messages_account_uid_uq" ON "mail_messages" USING btree ("account_id","message_uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_company_idx" ON "mail_accounts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_owner_idx" ON "mail_accounts" USING btree ("company_id","owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_pa_agent_idx" ON "mail_accounts" USING btree ("pa_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_accounts_due_idx" ON "mail_accounts" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_company_folder_idx" ON "mail_messages" USING btree ("company_id","account_id","folder","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_account_message_id_idx" ON "mail_messages" USING btree ("account_id","message_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0195_mail_secretary
-- used, so these tables stay in line with the rest of the tenant tables on a
-- database where those roles exist. Safe where the 0149/0164 roles are
-- absent. Company isolation does NOT rest on this: every query in the code
-- filters on the caller's company, and the owner/PA-agent/emergency-access
-- boundary is enforced in server/src/services/mail-accounts.ts, not here.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['mail_accounts', 'mail_messages'] LOOP
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
    FOREACH t IN ARRAY ARRAY['mail_accounts', 'mail_messages'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
