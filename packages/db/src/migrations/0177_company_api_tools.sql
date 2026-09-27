-- DUR-4004: "API with a key" -- the third kind of tool on the Tools page.
--
-- Until now the Tools page only took an MCP server (a command to run or a
-- URL to connect to). Most services hand out an API key and a plain HTTP
-- API instead. After this migration:
--   * company_api_tools holds one such service per row: name, base address,
--     how the key is sent (auth jsonb: kind bearer/header/query, the header or
--     query name, an optional prefix such as "Key " for Fal.ai, and the id of
--     the company secret that holds the key), the actions an agent may call
--     (actions jsonb), an optional OpenAPI address the actions were imported
--     from, a daily call cap, a status and the outcome of the last Test.
--     The key itself is never in this table; it stays in company_secret_
--     versions and is bound to the row through company_secret_bindings
--     (target_type 'api_tool', config_path 'auth').
--   * company_api_tool_calls is the audit trail and the counter the daily cap
--     is enforced from: one row per call, written as 'started' before the
--     request goes out and updated to its outcome after (at most one
--     'rate_limited' row per tool per hour), never the request input, never
--     the response, never an error text.
--   * agents.api_tool_ids lists which of these tools an agent is checked-on
--     for, exactly like agents.mcp_tool_ids. Empty means none.
--
-- Strictly additive: two new tables, one defaulted column, no row written, no
-- existing row touched. Every statement is guarded so a re-run is a no-op.
-- No table is discovered by column shape anywhere in this file; the only
-- tables named are ones this codebase owns and declares in
-- packages/db/src/schema.
CREATE TABLE IF NOT EXISTS "company_api_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_url" text NOT NULL,
	"auth" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"openapi_url" text,
	"daily_cap" integer DEFAULT 300 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tools_company_id_companies_id_fk') THEN
    ALTER TABLE "company_api_tools" ADD CONSTRAINT "company_api_tools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tools_status_check') THEN
    ALTER TABLE "company_api_tools" ADD CONSTRAINT "company_api_tools_status_check" CHECK ("status" IN ('active', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tools_daily_cap_check') THEN
    ALTER TABLE "company_api_tools" ADD CONSTRAINT "company_api_tools_daily_cap_check" CHECK ("daily_cap" > 0);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_api_tools_company_id_idx" ON "company_api_tools" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_api_tools_company_key_uq" ON "company_api_tools" USING btree ("company_id","key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_api_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tool_id" uuid,
	"action" text NOT NULL,
	"channel" text NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"run_id" text,
	"status" text NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tool_calls_company_id_companies_id_fk') THEN
    ALTER TABLE "company_api_tool_calls" ADD CONSTRAINT "company_api_tool_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tool_calls_tool_id_company_api_tools_id_fk') THEN
    ALTER TABLE "company_api_tool_calls" ADD CONSTRAINT "company_api_tool_calls_tool_id_company_api_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."company_api_tools"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tool_calls_channel_check') THEN
    ALTER TABLE "company_api_tool_calls" ADD CONSTRAINT "company_api_tool_calls_channel_check" CHECK ("channel" IN ('quick_chat', 'agent_run', 'board', 'settings_test'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_api_tool_calls_status_check') THEN
    ALTER TABLE "company_api_tool_calls" ADD CONSTRAINT "company_api_tool_calls_status_check" CHECK ("status" IN ('started', 'ok', 'upstream_error', 'network_error', 'refused', 'rate_limited'));
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_api_tool_calls_company_created_idx" ON "company_api_tool_calls" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_api_tool_calls_tool_created_idx" ON "company_api_tool_calls" USING btree ("tool_id","created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "api_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Row-level security and grants, same guarded shape 0174 and 0175 used, so
-- both tables stay in line with the rest of the tenant tables on a database
-- where those roles exist. Safe where the 0149/0164 roles are absent.
-- Company isolation does NOT rest on this: every query in the code filters
-- on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['company_api_tools', 'company_api_tool_calls'] LOOP
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
    FOREACH t IN ARRAY ARRAY['company_api_tools', 'company_api_tool_calls'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
