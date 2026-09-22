-- DUR-3995: Paperclip's own Claude key, settable from the settings page.
--
-- The server itself calls Claude for a few things that are not an agent run:
-- the quick-answer lane, the request router, the quality check before a task
-- is marked done, and the business-data trial. Until now the only way to give
-- it a key was to write PAPERCLIP_SERVER_ANTHROPIC_API_KEY into a file on the
-- server and restart it, which the owner of a business cannot do. This table
-- lets an instance admin set the same key from the settings page instead.
--
-- The key itself is sealed with the local_encrypted material scheme (see
-- server/src/secrets/local-encrypted-provider.ts), exactly as company secrets
-- and the instance-wide Claude sign-in are: this table never holds the
-- plaintext, and the master key lives outside the database. `hint` is the
-- last four characters only. Nothing here is ever handed to an agent.
--
-- Strictly additive: one new table, no DROP, no TRUNCATE, no REVOKE, every
-- statement guarded so a re-run is a no-op. No table is discovered by column
-- shape (see the note at the top of 0164_rls_login_roles.sql). Instance-wide
-- (no company_id), so no row-level-security policy. The limited app logins
-- from 0164 get the same table privileges 0164 gives every Paperclip table
-- (the name is also in 0164's explicit table list, which its test keeps equal
-- to the schema); guarded so this is safe where those roles do not exist.
CREATE TABLE IF NOT EXISTS "instance_server_anthropic_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"key_sealed" text NOT NULL,
	"hint" text NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"saved_by_user_id" text,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instance_server_anthropic_key_singleton_key_idx" ON "instance_server_anthropic_key" USING btree ("singleton_key");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE instance_server_anthropic_key TO paperclip_app_scoped';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE instance_server_anthropic_key TO paperclip_app_bypass_login';
  END IF;
END $$;
