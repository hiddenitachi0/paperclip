-- DUR-3978 slice 2: Telegram bot connections configured in the app.
--
-- Until now, connecting a Telegram bot meant editing a root-only JSON file on
-- the production host (/root/paperclip/.telegram-agents.json) with the bot
-- token in plain text, and restarting a systemd unit. This table is where a
-- bot connection lives instead, so the operator can do it himself.
--
-- The token is NOT in this table. It is an ordinary company secret
-- (company_secrets + company_secret_versions, encrypted at rest, rotatable,
-- audited), and this row only points at it through token_secret_id. That is
-- what makes "an ordinary read route never returns the token" a property of
-- the schema rather than a habit of the route authors.
--
-- Strictly additive: no DROP, no TRUNCATE, no REVOKE, every statement guarded
-- so a re-run is a no-op. No table is discovered by column shape anywhere in
-- this file -- the only tables named are ones this codebase owns and declares
-- in packages/db/src/schema/*.ts (see the note at the top of
-- 0164_rls_login_roles.sql for the incident that made that a rule).
CREATE TABLE IF NOT EXISTS "telegram_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_secret_id" uuid NOT NULL,
	"token_hint" text DEFAULT '' NOT NULL,
	"ui_base" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_username" text,
	"last_check_error" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Separate ALTER rather than a column in the CREATE above, so a database that
-- already ran an earlier form of this migration still gets the column.
-- Default '[]' is default-DENY on purpose: a bot row whose allowlist is empty
-- grants nobody by itself -- the bridge then falls back to the instance-wide
-- allowlist it already enforced before this feature existed, and never to
-- "everybody". Telegram user ids are 64-bit integers, so they are stored as
-- JSON strings, never as JSON numbers.
ALTER TABLE "telegram_bots" ADD COLUMN IF NOT EXISTS "allowed_telegram_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'telegram_bots_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- A terminated agent takes its bot with it: leaving the row behind would keep
-- a live bot answering for an agent that no longer exists.
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'telegram_bots_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- No ON DELETE here on purpose: deleting the secret out from under a live bot
-- would leave a bot row that can never be resolved. The remove path deletes
-- the bot row first, then the secret.
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'telegram_bots_token_secret_id_company_secrets_id_fk'
	) THEN
		ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_bots_company_idx" ON "telegram_bots" ("company_id");--> statement-breakpoint
-- One bot per agent. Two bots for the same agent would both answer the same
-- person and both file tasks for the same agent.
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_bots_company_agent_uq" ON "telegram_bots" ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_bots_token_secret_uq" ON "telegram_bots" ("token_secret_id");--> statement-breakpoint
-- Row-level security, same shape migration 0165 gave company_service_tokens
-- and 0149 gave the rest of the company-scoped tables. Guarded so this
-- migration is safe on a database where those roles do not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telegram_bots TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE telegram_bots ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'telegram_bots' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON telegram_bots USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
END $$;
