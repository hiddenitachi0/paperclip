-- Quick agents (Lane A, round 2): make the shipped-but-dark Lane A primitive a
-- real "quick employee" (a secretary that hands work to colleagues, a weather
-- helper, ...). Strictly additive:
--   1. agents.lane_a_instructions — the operator-written instruction set the
--      quick agent follows (its persona + rules), used by buildSystemPrompt
--      in server/src/services/lane-a.ts together with the agent's name/role.
--   2. lane_a_messages — the actual transcript of a Lane A conversation, one
--      row per turn (user / assistant), so the agent remembers what was said
--      earlier in the same conversation. Replay is bounded server-side by a
--      turn count and a token budget (LANE_A_MEMORY_* in lane-a.ts).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_instructions" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lane_a_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_messages_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "lane_a_messages" ADD CONSTRAINT "lane_a_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_messages_conversation_id_lane_a_conversations_id_fk'
	) THEN
		ALTER TABLE "lane_a_messages" ADD CONSTRAINT "lane_a_messages_conversation_id_lane_a_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."lane_a_conversations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_messages_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "lane_a_messages" ADD CONSTRAINT "lane_a_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_a_messages_conversation_created_idx" ON "lane_a_messages" ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_a_messages_company_agent_idx" ON "lane_a_messages" ("company_id","agent_id");--> statement-breakpoint
-- Defense in depth, same pattern as lane_a_conversations (migration 0147):
-- company_id is forced to the parent conversation's company on every
-- insert/update so a cross-company transcript row cannot be persisted through
-- any path.
CREATE OR REPLACE FUNCTION enforce_lane_a_message_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM lane_a_conversations WHERE id = NEW.conversation_id;
  IF resolved_company_id IS NULL THEN
    RAISE EXCEPTION '% references conversation % which does not exist', TG_TABLE_NAME, NEW.conversation_id;
  END IF;
  IF NEW.company_id IS DISTINCT FROM resolved_company_id THEN
    RAISE WARNING 'Forcing % company_id to % for conversation % to match its conversation; caller supplied %',
      TG_TABLE_NAME, resolved_company_id, NEW.conversation_id, NEW.company_id;
  END IF;
  NEW.company_id := resolved_company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS lane_a_messages_enforce_company_id ON "lane_a_messages";
--> statement-breakpoint
CREATE TRIGGER lane_a_messages_enforce_company_id
  BEFORE INSERT OR UPDATE OF conversation_id, company_id ON "lane_a_messages"
  FOR EACH ROW EXECUTE FUNCTION enforce_lane_a_message_company_id();
--> statement-breakpoint
-- Row-level security, same policy shape as migration 0149 gave
-- lane_a_conversations. Guarded so the migration is safe on a database where
-- 0149's roles are absent (fresh embedded test databases run every
-- migration in order, so the role exists there; the guard is for safety only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE lane_a_messages TO paperclip_app_scoped';
    EXECUTE 'ALTER TABLE lane_a_messages ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'lane_a_messages' AND policyname = 'paperclip_company_scope'
    ) THEN
      EXECUTE 'CREATE POLICY paperclip_company_scope ON lane_a_messages USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))';
    END IF;
  END IF;
END $$;
