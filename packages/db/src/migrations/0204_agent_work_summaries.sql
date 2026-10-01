-- DUR-4197 (memory improvements, child of DUR-4146/DUR-4141): work-history
-- storage for full agents. One short, already-redacted summary per
-- successful heartbeat run (server/src/services/heartbeat.ts writes it),
-- so a later run of the same agent can search what it did before instead of
-- starting cold (server/src/services/agent-work-summaries.ts). Ships with
-- zero rows and no read path wired into any prompt by default -- no
-- behavior change for any existing company until an agent calls the new
-- search_work_history tool.
--
-- Scoping: always read/written company-scoped, and search is additionally
-- restricted to the requesting agent's own summaries -- never another
-- agent's, never across companies.
--
-- Rollback: DROP TABLE "agent_work_summaries" (nothing references it from
-- another table, only references out to companies/agents/issues/
-- heartbeat_runs, so dropping it loses only this feature's own data).
CREATE TABLE IF NOT EXISTS "agent_work_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_work_summaries_company_id_companies_id_fk') THEN
    ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_work_summaries_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_work_summaries_issue_id_issues_id_fk') THEN
    ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_work_summaries_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_work_summaries_summary_length_check') THEN
    ALTER TABLE "agent_work_summaries" ADD CONSTRAINT "agent_work_summaries_summary_length_check" CHECK (char_length("summary") BETWEEN 1 AND 2000);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_work_summaries_company_agent_created_idx" ON "agent_work_summaries" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_work_summaries_run_unique_idx" ON "agent_work_summaries" USING btree ("run_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape prior tenant tables
-- (e.g. 0186/0188/0198) use, so this table stays in line on a database
-- where those roles exist. Company isolation does NOT rest on this: every
-- query in the code filters on the caller's company and, for search, the
-- caller's own agent id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_work_summaries'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format('CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))', t);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END IF;
  END LOOP;
END $$;
