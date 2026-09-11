-- DUR-3977: the stateless Lane A transform endpoint.
--
-- Two additive things:
--   1. agents gains three nullable quick-agent settings — which model the
--      quick agent runs on, how long an answer it may produce, and how many
--      stateless transform calls it may serve per UTC day. Null on every
--      existing row means "use the platform default", so nothing changes for
--      a quick agent that is already running.
--   2. company_service_tokens: the per-company machine credential the
--      dashboard authenticates with. Only a SHA-256 hash of the token is
--      stored, exactly as board_api_keys and agent_api_keys do it.
--
-- Strictly additive: no DROP, no TRUNCATE, no REVOKE, every statement guarded
-- so a re-run is a no-op. No table is discovered by column shape anywhere in
-- this file — the only tables named are the two this codebase owns and just
-- declared in packages/db/src/schema/*.ts (see the 2026-09-09 incident
-- recorded at the top of 0164_rls_login_roles.sql for why that rule exists).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_max_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_transform_daily_call_cap" integer;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_service_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"revoked_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Separate ALTER rather than a column in the CREATE above, so a database that
-- already ran an earlier form of this migration still gets the column. Default
-- '[]' is default-DENY on purpose: a token row with no scopes can reach
-- nothing, and every route that accepts a service token names the scope it
-- needs (assertServiceOrBoard in server/src/routes/authz.ts).
ALTER TABLE "company_service_tokens" ADD COLUMN IF NOT EXISTS "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'company_service_tokens_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "company_service_tokens" ADD CONSTRAINT "company_service_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- Unique, not just indexed: two live tokens may never share a hash, so a
-- lookup by hash can never be ambiguous about which company it authenticates.
CREATE UNIQUE INDEX IF NOT EXISTS "company_service_tokens_token_hash_idx" ON "company_service_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_service_tokens_company_idx" ON "company_service_tokens" ("company_id","revoked_at");--> statement-breakpoint
-- Row-level security, same shape migration 0162 gave lane_a_messages and
-- 0149 gave the rest of the company-scoped tables. Guarded so this migration
-- is safe on a database where those roles do not exist.
--
-- Note the bypass clause: the token lookup in server/src/middleware/auth.ts
-- necessarily runs before any company is known (the hash is what tells us
-- which company it is), exactly like the agent_api_keys lookup beside it, so
-- it runs on the unscoped connection. The policy is defence in depth for
-- every OTHER reader of this table — listing and revoking tokens is
-- company-scoped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_service_tokens TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE company_service_tokens ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'company_service_tokens' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON company_service_tokens USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
END $$;
