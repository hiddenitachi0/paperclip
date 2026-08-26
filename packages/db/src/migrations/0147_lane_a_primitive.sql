-- DUR-217: Lane A primitive — a direct-model-call text endpoint with no
-- agent runtime, no tool access, no CLI subprocess. See the DUR-157 plan
-- doc's "Lane A v1 design" section.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lane_a_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lane_a_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"requested_by_user_id" text,
	"requested_by_agent_id" uuid,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_conversations_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "lane_a_conversations" ADD CONSTRAINT "lane_a_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_conversations_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "lane_a_conversations" ADD CONSTRAINT "lane_a_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'lane_a_conversations_requested_by_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "lane_a_conversations" ADD CONSTRAINT "lane_a_conversations_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_a_conversations_company_agent_idx" ON "lane_a_conversations" ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_a_conversations_company_requester_last_message_idx" ON "lane_a_conversations" ("company_id","requested_by_user_id","requested_by_agent_id","last_message_at");--> statement-breakpoint
-- Defense in depth, DUR-110 style: force company_id to match the parent
-- agent's company_id on every insert/update, regardless of what the caller
-- supplied. This makes a cross-company lane_a_conversations row structurally
-- impossible to persist through any path, including ones the app layer
-- hasn't guarded yet.
CREATE OR REPLACE FUNCTION enforce_lane_a_conversation_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM agents WHERE id = NEW.agent_id;
  IF resolved_company_id IS NULL THEN
    RAISE EXCEPTION '% references agent % which does not exist', TG_TABLE_NAME, NEW.agent_id;
  END IF;
  IF NEW.company_id IS DISTINCT FROM resolved_company_id THEN
    RAISE WARNING 'Forcing % company_id to % for agent % to match its agent; caller supplied %',
      TG_TABLE_NAME, resolved_company_id, NEW.agent_id, NEW.company_id;
  END IF;
  NEW.company_id := resolved_company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS lane_a_conversations_enforce_company_id ON "lane_a_conversations";
--> statement-breakpoint
CREATE TRIGGER lane_a_conversations_enforce_company_id
  BEFORE INSERT OR UPDATE OF agent_id, company_id ON "lane_a_conversations"
  FOR EACH ROW EXECUTE FUNCTION enforce_lane_a_conversation_company_id();
