-- Quick-agent memory notebook.
--
-- Quick agents only remembered within one conversation (30 minutes idle, the
-- last 20 turns replayed); a new conversation started blank. The operator
-- asked for a place where the agent keeps things he asks it to remember, and
-- where he can read and edit those notes himself.
--
-- After this migration:
--   * agent_memories holds one short note per row (1-500 characters), in the
--     company of the agent it was added through. persona_id set means the
--     note belongs to that PERSON and every job the person holds reads it;
--     persona_id null means it belongs to the JOB in agent_id alone.
--     source says who wrote it: 'agent' (the quick agent's remember tool, on
--     a person's request) or 'user' (typed on the agent's page).
--     Deleting the job, the person or the company deletes their notes.
--
-- Strictly additive: one new table, no row written, no existing row touched.
-- Every statement is guarded so a re-run is a no-op. No table is discovered
-- by column shape anywhere in this file; the only tables named are ones this
-- codebase owns and declares in packages/db/src/schema.
CREATE TABLE IF NOT EXISTS "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"persona_id" uuid,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_company_id_companies_id_fk') THEN
    ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_persona_id_personas_id_fk') THEN
    ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_source_check') THEN
    ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_check" CHECK ("source" IN ('agent', 'user'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_text_length_check') THEN
    ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_text_length_check" CHECK (char_length("text") BETWEEN 1 AND 500);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_company_agent_idx" ON "agent_memories" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_company_persona_idx" ON "agent_memories" USING btree ("company_id","persona_id","created_at");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0177 used, so the
-- table stays in line with the rest of the tenant tables on a database where
-- those roles exist. Safe where the 0149/0164 roles are absent. Company
-- isolation does NOT rest on this: every query in the code filters on the
-- caller's company.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_memories" TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE "agent_memories" ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'agent_memories' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON "agent_memories" USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_memories" TO paperclip_app_bypass_login';
  END IF;
END $$;
