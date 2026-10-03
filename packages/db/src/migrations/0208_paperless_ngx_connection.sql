-- DUR-4302 (paperless-ngx Phase 1 plumbing): a `paperless_ngx` data-connections
-- kind, one container per company, bound to that company's own internal host
-- and port -- never a public address (Filip, 1 Oct 2026). This adds:
--   - kind accepts 'paperless_ngx' next to the existing kinds
--   - credential_kind: a paperless_ngx row takes 'paperless_api_token', and
--     only that kind -- the pair (kind, credential_kind) must still belong
--     together, same rule as every other kind
--   - data_dataset_sources.dataset accepts 'documents' next to
--     'sales'/'finance'/'custom'
--
-- Every existing row satisfies the new rules (they are strictly wider), so no
-- row is touched, no data is rewritten and nothing changes for a company until
-- a board user adds a paperless-ngx connection. Every statement is guarded so
-- a re-run is a no-op: DROP CONSTRAINT IF EXISTS before each ADD, under the
-- names 0168 gave them, so the Drizzle schema and the database keep agreeing.
DO $$ BEGIN
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_kind_check" CHECK ("kind" IN ('shopify', 'woocommerce', 'fiken', 'ftp_file', 'ftps_file', 'sftp_file', 'paperless_ngx'));
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_credential_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_kind_check" CHECK (("kind" = 'shopify' AND "credential_kind" IN ('admin_access_token', 'client_credentials')) OR ("kind" = 'woocommerce' AND "credential_kind" = 'consumer_key_secret') OR ("kind" = 'fiken' AND "credential_kind" = 'api_token') OR ("kind" IN ('ftp_file', 'ftps_file') AND "credential_kind" = 'password') OR ("kind" = 'sftp_file' AND "credential_kind" IN ('password', 'private_key')) OR ("kind" = 'paperless_ngx' AND "credential_kind" = 'paperless_api_token'));
	ALTER TABLE "data_dataset_sources" DROP CONSTRAINT IF EXISTS "data_dataset_sources_dataset_check";
	ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_dataset_check" CHECK ("dataset" IN ('sales', 'finance', 'custom', 'documents'));
END $$;--> statement-breakpoint
-- Row-level security and grants, re-asserted in the same guarded shape 0168,
-- 0173 and 0174 used so the table stays in line with the rest of the tenant
-- tables on a database where those roles exist. Nothing here changes on a
-- database that already has them. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company.
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
