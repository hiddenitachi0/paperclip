-- Board chat on signed-in Paperclip servers (approved by Filip, 20 Oct 2026, option A).
-- (Numbered 0255: 0254 is brag-on-done.)
--
-- Three new company-scoped tables, see packages/db/src/schema/board_chat.ts:
--   * board_chat_company_settings: per-company on/off switch (no row = off)
--     and the daily message cap.
--   * board_chat_runs: one row per Board chat message on a signed-in server;
--     holds only the HASH of the short-lived credential the run uses (the
--     value is never stored), the count behind the daily cap, and the cost.
--   * board_chat_actions: every change a Board chat run asked for. Changes are
--     held here as a card until the person clicks Approve or Cancel.
-- No existing table or row is changed. Every statement is guarded so a re-run
-- is a no-op. RLS: the guarded grant + paperclip_company_scope policy block at
-- the end, and all three names are in both arrays of 0164_rls_login_roles.sql.
--
-- Rollback: DROP TABLE "board_chat_actions", "board_chat_runs",
-- "board_chat_company_settings"; (that order). Loses only Board chat history
-- of held changes, run costs stay in cost_events.
CREATE TABLE IF NOT EXISTS "board_chat_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"issue_id" uuid,
	"user_id" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"body_json" text,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"exec_token_hash" text,
	"exec_token_expires_at" timestamp with time zone,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"result_status" integer,
	"result_message" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "board_chat_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"daily_message_cap" integer DEFAULT 40 NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "board_chat_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"bootstrap_code_hash" text,
	"token_hash" text,
	"token_exchange_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint,
	"cost_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_actions_company_id_companies_id_fk') THEN
    ALTER TABLE "board_chat_actions" ADD CONSTRAINT "board_chat_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_actions_run_id_board_chat_runs_id_fk') THEN
    ALTER TABLE "board_chat_actions" ADD CONSTRAINT "board_chat_actions_run_id_board_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."board_chat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_actions_issue_id_issues_id_fk') THEN
    ALTER TABLE "board_chat_actions" ADD CONSTRAINT "board_chat_actions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_company_settings_company_id_companies_id_fk') THEN
    ALTER TABLE "board_chat_company_settings" ADD CONSTRAINT "board_chat_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_runs_company_id_companies_id_fk') THEN
    ALTER TABLE "board_chat_runs" ADD CONSTRAINT "board_chat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_runs_issue_id_issues_id_fk') THEN
    ALTER TABLE "board_chat_runs" ADD CONSTRAINT "board_chat_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_chat_actions_company_issue_created_idx" ON "board_chat_actions" USING btree ("company_id","issue_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_chat_actions_exec_token_hash_uq" ON "board_chat_actions" USING btree ("exec_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_chat_company_settings_company_uq" ON "board_chat_company_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_chat_runs_company_created_idx" ON "board_chat_runs" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_chat_runs_token_hash_uq" ON "board_chat_runs" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_chat_runs_bootstrap_code_hash_uq" ON "board_chat_runs" USING btree ("bootstrap_code_hash");
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['board_chat_company_settings', 'board_chat_runs', 'board_chat_actions'] LOOP
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
    FOREACH t IN ARRAY ARRAY['board_chat_company_settings', 'board_chat_runs', 'board_chat_actions'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
