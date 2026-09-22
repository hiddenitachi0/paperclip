-- DUR-3997 slice 3: the data-source tables stop being Shopify-shaped.
--
-- data_connections (from 0168) could only hold kind 'shopify', with a
-- NOT NULL *.myshopify.com shop_domain and api_version, and two Shopify
-- credential kinds. This migration lets the same table hold WooCommerce,
-- Fiken and SFTP-file connections next to Shopify:
--   - kind accepts 'shopify', 'woocommerce', 'fiken', 'sftp_file'
--   - shop_domain and api_version become nullable; the *.myshopify.com rule
--     (and NOT NULL) now applies only WHEN kind = 'shopify', so the live
--     Shopify row is bound by exactly the rule it was stored under
--   - a new `config` jsonb column holds per-kind NON-SECRET settings (store
--     URL, Fiken company slug, SFTP host/port/user/path). Credentials stay
--     where 0168 put them: a company secret pointed at by credential_secret_id
--   - credential_kind becomes a per-kind set: the two Shopify values stay,
--     plus 'consumer_key_secret' (WooCommerce), 'api_token' (Fiken),
--     'password' and 'private_key' (SFTP); the pair (kind, credential_kind)
--     must belong together
--   - data_dataset_sources.dataset accepts 'sales', 'finance', 'custom'
--
-- The PRIMARY KEY (company_id, dataset) of data_dataset_sources is left ALONE
-- on purpose: whether one dataset may ever have two sources is a later
-- decision, and relaxing the key now would silently allow it.
--
-- Every existing row satisfies the new rules (they are strictly wider for
-- kind = 'shopify'), so no row is touched, no data is rewritten and nothing
-- changes for a company until a board user adds a connection of a new kind.
-- Every statement is guarded so a re-run is a no-op: ADD COLUMN IF NOT EXISTS,
-- DROP NOT NULL (idempotent), DROP CONSTRAINT IF EXISTS before each ADD. No
-- table is discovered by column shape anywhere in this file; the only tables
-- named are ones this codebase owns and declares in packages/db/src/schema.
ALTER TABLE "data_connections" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "data_connections" ALTER COLUMN "shop_domain" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_connections" ALTER COLUMN "api_version" DROP NOT NULL;--> statement-breakpoint
-- The widened check constraints. Each one is dropped and re-added under its
-- 0168 name, so the Drizzle schema and the database keep agreeing on names.
DO $$ BEGIN
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_kind_check" CHECK ("kind" IN ('shopify', 'woocommerce', 'fiken', 'sftp_file'));
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_shop_domain_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_shop_domain_check" CHECK ("kind" <> 'shopify' OR ("shop_domain" IS NOT NULL AND "api_version" IS NOT NULL AND "shop_domain" ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'));
	ALTER TABLE "data_connections" DROP CONSTRAINT IF EXISTS "data_connections_credential_kind_check";
	ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_kind_check" CHECK (("kind" = 'shopify' AND "credential_kind" IN ('admin_access_token', 'client_credentials')) OR ("kind" = 'woocommerce' AND "credential_kind" = 'consumer_key_secret') OR ("kind" = 'fiken' AND "credential_kind" = 'api_token') OR ("kind" = 'sftp_file' AND "credential_kind" IN ('password', 'private_key')));
	ALTER TABLE "data_dataset_sources" DROP CONSTRAINT IF EXISTS "data_dataset_sources_dataset_check";
	ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_dataset_check" CHECK ("dataset" IN ('sales', 'finance', 'custom'));
END $$;--> statement-breakpoint
-- Row-level security and grants, re-asserted in the same guarded shape 0168
-- used so the tables stay in line with the rest of the tenant tables on a
-- database where those roles exist. Nothing here changes on a database that
-- already has them; a new column needs no new grant. Company isolation does
-- NOT rest on this: every query in the code filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['data_connections', 'data_dataset_sources'] LOOP
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
    FOREACH t IN ARRAY ARRAY['data_connections', 'data_dataset_sources'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
