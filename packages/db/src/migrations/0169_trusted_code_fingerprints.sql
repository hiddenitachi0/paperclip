-- DUR-3994 Stage 2: agents can't plant code the server will run.
--
-- Paperclip loads add-on code (plugins and external adapters) from folders
-- under /paperclip, which every agent can write (agents run as the same Linux
-- user as the server). An agent that edited one of those files had its code
-- run inside the server, or with the plugin's permissions, at the next load.
-- This table holds a fingerprint (sha256 of every file) of each add-on code
-- folder, recorded when Paperclip installs it; the server refuses to load a
-- folder whose files no longer match. It is a table and not a file because an
-- agent could rewrite a file together with the code.
--
-- Numbered 0169 (not 0168) because 0168 is already taken on custom by a
-- change this branch does not contain; gaps are allowed and the migration
-- runner applies by content hash, not by position.
--
-- Strictly additive: one new table, no DROP, no TRUNCATE, no REVOKE, every
-- statement guarded so a re-run is a no-op. No table is discovered by column
-- shape (see the note at the top of 0164_rls_login_roles.sql). Instance-wide
-- (no company_id), so no row-level-security policy. The limited app logins
-- from 0164 get the same table privileges 0164 gives every Paperclip table
-- (the name is also in 0164's explicit table list, which its test keeps equal
-- to the schema); guarded so this is safe where those roles do not exist.
CREATE TABLE IF NOT EXISTS "trusted_code_fingerprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_root" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"digest" text NOT NULL,
	"file_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"recorded_reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_code_fingerprints_code_root_idx" ON "trusted_code_fingerprints" USING btree ("code_root");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trusted_code_fingerprints TO paperclip_app_scoped';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trusted_code_fingerprints TO paperclip_app_bypass_login';
  END IF;
END $$;
