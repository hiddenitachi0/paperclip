-- DUR-3997 (files on a server): FTP, FTPS and SFTP connections, read or
-- read-write.
--
-- 0173 admitted one file kind, 'sftp_file', with no transport behind it and
-- `access` pinned to 'read'. This migration lets data_connections hold the
-- three file-server kinds and an access mode:
--   - kind accepts 'ftp_file' and 'ftps_file' next to 'sftp_file'
--   - credential_kind: plain FTP and FTPS take a 'password'; SFTP keeps
--     'password' or 'private_key'. The pair (kind, credential_kind) must still
--     belong together, so a private key can never sit on an FTP row
--   - access accepts 'read' (a partner's server) or 'read_write' (the
--     company's own server, where agents will push reports). The service only
--     ever writes 'read_write' for a file-server kind; every other kind stays
--     'read' by code, and 'read' stays the column default
--
-- Every existing row satisfies the new rules (they are strictly wider), so no
-- row is touched, no data is rewritten and nothing changes for a company until
-- a board user adds a file-server connection. Every statement is guarded so a
-- re-run is a no-op: DROP CONSTRAINT IF EXISTS before each ADD, under the
-- names 0168 gave them, so the Drizzle schema and the database keep agreeing.
-- No table is discovered by column shape anywhere in this file; the only
-- tables named are ones this codebase owns and declares in
-- packages/db/src/schema.
DO $$ BEGIN
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_kind_check" CHECK ("kind" IN ('shopify', 'woocommerce', 'fiken', 'ftp_file', 'ftps_file', 'sftp_file'));
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_credential_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_kind_check" CHECK (("kind" = 'shopify' AND "credential_kind" IN ('admin_access_token', 'client_credentials')) OR ("kind" = 'woocommerce' AND "credential_kind" = 'consumer_key_secret') OR ("kind" = 'fiken' AND "credential_kind" = 'api_token') OR ("kind" IN ('ftp_file', 'ftps_file') AND "credential_kind" = 'password') OR ("kind" = 'sftp_file' AND "credential_kind" IN ('password', 'private_key')));
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_access_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_access_check" CHECK ("access" IN ('read', 'read_write'));
END $$;--> statement-breakpoint
-- Row-level security and grants, re-asserted in the same guarded shape 0168
-- and 0173 used so the table stays in line with the rest of the tenant tables
-- on a database where those roles exist. Nothing here changes on a database
-- that already has them. Company isolation does NOT rest on this: every query
-- in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['data_connections'] LOOP
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
    FOREACH t IN ARRAY ARRAY['data_connections'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
