-- DUR-3972 slice S1: business-data connections (Shopify first), which company
-- dataset each one answers, and one audit row per lookup.
--
-- Ships switched off. Nothing reads these tables until an operator connects a
-- source in company settings AND the instance flag enableBusinessData is on,
-- so on its own this migration changes no behaviour for any company.
--
-- The credential is NOT in any of these tables. It is an ordinary company
-- secret (company_secrets + company_secret_versions, encrypted at rest,
-- rotatable, audited), and data_connections only points at it.
--
-- Strictly additive: no DROP, no TRUNCATE, no REVOKE, no change to any
-- existing table, and every statement guarded so a re-run is a no-op. No table
-- is discovered by column shape anywhere in this file -- the only tables named
-- are ones this codebase owns and declares in packages/db/src/schema/*.ts (see
-- the note at the top of 0164_rls_login_roles.sql for the incident that made
-- that a rule).
CREATE TABLE IF NOT EXISTS "data_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"shop_domain" text NOT NULL,
	"api_version" text NOT NULL,
	"credential_kind" text NOT NULL,
	"credential_secret_id" uuid NOT NULL,
	"credential_hint" text DEFAULT '' NOT NULL,
	"access" text DEFAULT 'read' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"daily_lookup_cap" integer DEFAULT 300 NOT NULL,
	"observed" jsonb,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_error" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_dataset_sources" (
	"company_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"granted_by_user_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_dataset_sources_pk" PRIMARY KEY("company_id","dataset")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_read_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid,
	"dataset" text NOT NULL,
	"channel" text NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"run_id" text,
	"lane_a_conversation_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"refusal_code" text,
	"facts" jsonb,
	"upstream_requests" integer DEFAULT 0 NOT NULL,
	"cost_points" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Check constraints. `access` can only ever be 'read', so a write grant cannot
-- be stored by any code path. The shop address must be a *.myshopify.com name,
-- which is also the only host the outbound-call guard lets a Shopify
-- connection reach.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_kind_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_kind_check" CHECK ("kind" IN ('shopify'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_shop_domain_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_shop_domain_check" CHECK ("shop_domain" ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_credential_kind_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_kind_check" CHECK ("credential_kind" IN ('admin_access_token', 'client_credentials'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_access_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_access_check" CHECK ("access" = 'read');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_status_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_status_check" CHECK ("status" IN ('draft', 'active', 'error', 'disabled'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_daily_lookup_cap_check') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_daily_lookup_cap_check" CHECK ("daily_lookup_cap" BETWEEN 1 AND 100000);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_dataset_sources_dataset_check') THEN
		ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_dataset_check" CHECK ("dataset" IN ('sales'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_read_events_channel_check') THEN
		ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_channel_check" CHECK ("channel" IN ('quick_chat', 'telegram', 'settings_test'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_read_events_outcome_check') THEN
		ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_outcome_check" CHECK ("outcome" IN ('ok', 'no_data', 'ambiguous', 'refused', 'rate_limited', 'upstream_error'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_read_events_facts_size_check') THEN
		ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_facts_size_check" CHECK ("facts" IS NULL OR octet_length("facts"::text) <= 8192);
	END IF;
END $$;--> statement-breakpoint
-- UNIQUE(id, company_id) is the target of the composite foreign key below.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_id_company_uq') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_id_company_uq" UNIQUE ("id", "company_id");
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_company_id_companies_id_fk') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	-- No ON DELETE: the remove path deletes the connection row first, then the
	-- secret, so a live connection can never point at a missing credential.
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_connections_credential_secret_id_company_secrets_id_fk') THEN
		ALTER TABLE "data_connections" ADD CONSTRAINT "data_connections_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_dataset_sources_company_id_companies_id_fk') THEN
		ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	-- A company can never point a dataset at another company's connection:
	-- the pair (connection_id, company_id) must exist together.
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_dataset_sources_connection_company_fk') THEN
		ALTER TABLE "data_dataset_sources" ADD CONSTRAINT "data_dataset_sources_connection_company_fk" FOREIGN KEY ("connection_id", "company_id") REFERENCES "public"."data_connections"("id", "company_id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_read_events_company_id_companies_id_fk') THEN
		ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	-- The audit trail outlives the connection it was about.
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'data_read_events_connection_id_data_connections_id_fk') THEN
		ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_connections_company_idx" ON "data_connections" ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_connections_credential_secret_uq" ON "data_connections" ("credential_secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_dataset_sources_connection_idx" ON "data_dataset_sources" ("connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_read_events_company_created_idx" ON "data_read_events" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_read_events_agent_created_idx" ON "data_read_events" ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_read_events_run_idx" ON "data_read_events" ("run_id");--> statement-breakpoint
-- Row-level security, same shape 0166 gave telegram_bots. Guarded so this
-- migration is safe on a database where those roles do not exist. Company
-- isolation does NOT rest on this: every query in the code filters on the
-- caller's company, and the tests prove it. This only keeps the new tables in
-- line with the rest of the tenant tables.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['data_connections', 'data_dataset_sources', 'data_read_events'] LOOP
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
    FOREACH t IN ARRAY ARRAY['data_connections', 'data_dataset_sources', 'data_read_events'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
