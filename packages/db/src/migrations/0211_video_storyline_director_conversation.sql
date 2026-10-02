-- DUR-4327 (backend half of DUR-4325): the AI director conversation --
-- whole-storyline review, turn-by-turn dialogue, per-shot proposals. Hand
-- written, same reason as 0200_video_storyline_director_and_transitions.sql
-- (no drizzle-kit snapshot past migration 0099 in this sandbox).
--
-- Additive on top of video_storyline_director_runs (0200), which keeps its
-- existing single-shot draft/approve/reject flow untouched.
CREATE TABLE "video_storyline_director_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"status" text DEFAULT 'reviewing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_storyline_director_conversations_status_check" CHECK ("video_storyline_director_conversations"."status" IN ('reviewing', 'asking', 'proposing', 'done'))
);--> statement-breakpoint
ALTER TABLE "video_storyline_director_conversations" ADD CONSTRAINT "video_storyline_director_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_conversations" ADD CONSTRAINT "video_storyline_director_conversations_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_storyline_director_conversations_storyline_uq" ON "video_storyline_director_conversations" USING btree ("storyline_id");--> statement-breakpoint
CREATE INDEX "video_storyline_director_conversations_company_idx" ON "video_storyline_director_conversations" USING btree ("company_id");--> statement-breakpoint

CREATE TABLE "video_storyline_director_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_storyline_director_messages_role_check" CHECK ("video_storyline_director_messages"."role" IN ('director', 'person')),
	CONSTRAINT "video_storyline_director_messages_kind_check" CHECK ("video_storyline_director_messages"."kind" IN ('review', 'question', 'answer', 'proposal', 'system'))
);--> statement-breakpoint
ALTER TABLE "video_storyline_director_messages" ADD CONSTRAINT "video_storyline_director_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_storyline_director_messages" ADD CONSTRAINT "video_storyline_director_messages_conversation_id_video_storyline_director_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."video_storyline_director_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_storyline_director_messages_conversation_created_idx" ON "video_storyline_director_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "video_storyline_director_messages_company_idx" ON "video_storyline_director_messages" USING btree ("company_id","conversation_id");--> statement-breakpoint

-- Defense in depth, same pattern as lane_a_messages (migration 0162):
-- company_id is forced to the parent conversation's company on every
-- insert/update so a cross-company transcript row cannot be persisted
-- through any path.
CREATE OR REPLACE FUNCTION enforce_video_storyline_director_message_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM video_storyline_director_conversations WHERE id = NEW.conversation_id;
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
DROP TRIGGER IF EXISTS video_storyline_director_messages_enforce_company_id ON "video_storyline_director_messages";
--> statement-breakpoint
CREATE TRIGGER video_storyline_director_messages_enforce_company_id
  BEFORE INSERT OR UPDATE OF conversation_id, company_id ON "video_storyline_director_messages"
  FOR EACH ROW EXECUTE FUNCTION enforce_video_storyline_director_message_company_id();
--> statement-breakpoint

-- Same defense for the conversation anchor itself: company_id is forced to
-- its storyline's own company, same pattern as lane_a_conversations deriving
-- from its agent (migration 0147).
CREATE OR REPLACE FUNCTION enforce_video_storyline_director_conversation_company_id() RETURNS trigger AS $$
DECLARE
  resolved_company_id uuid;
BEGIN
  SELECT company_id INTO resolved_company_id FROM video_storylines WHERE id = NEW.storyline_id;
  IF resolved_company_id IS NULL THEN
    RAISE EXCEPTION '% references storyline % which does not exist', TG_TABLE_NAME, NEW.storyline_id;
  END IF;
  IF NEW.company_id IS DISTINCT FROM resolved_company_id THEN
    RAISE WARNING 'Forcing % company_id to % for storyline % to match its storyline; caller supplied %',
      TG_TABLE_NAME, resolved_company_id, NEW.storyline_id, NEW.company_id;
  END IF;
  NEW.company_id := resolved_company_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS video_storyline_director_conversations_enforce_company_id ON "video_storyline_director_conversations";
--> statement-breakpoint
CREATE TRIGGER video_storyline_director_conversations_enforce_company_id
  BEFORE INSERT OR UPDATE OF storyline_id, company_id ON "video_storyline_director_conversations"
  FOR EACH ROW EXECUTE FUNCTION enforce_video_storyline_director_conversation_company_id();
--> statement-breakpoint

-- DUR-4327: per-shot director proposal + restorable history columns.
ALTER TABLE "video_shots" ADD COLUMN "proposed_prompt" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "proposed_camera_notes" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "proposed_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "proposed_transition_in" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "proposal_status" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "proposal_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "prompt_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_proposed_transition_in_check" CHECK ("video_shots"."proposed_transition_in" IS NULL OR "video_shots"."proposed_transition_in" IN ('cut', 'fade', 'dissolve'));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_proposed_duration_seconds_check" CHECK ("video_shots"."proposed_duration_seconds" IS NULL OR ("video_shots"."proposed_duration_seconds" > 0 AND "video_shots"."proposed_duration_seconds" <= 60));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_proposal_status_check" CHECK ("video_shots"."proposal_status" IS NULL OR "video_shots"."proposal_status" IN ('pending', 'accepted', 'edited', 'rejected'));--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_proposal_conversation_id_video_storyline_director_conversations_id_fk" FOREIGN KEY ("proposal_conversation_id") REFERENCES "public"."video_storyline_director_conversations"("id") ON DELETE SET NULL ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_shots_proposal_status_idx" ON "video_shots" USING btree ("proposal_conversation_id","proposal_status");--> statement-breakpoint

-- Row-level security and grants for the two new tables, the same guarded
-- shape 0200 used for video_storyline_director_runs -- see that migration's
-- convention comment. video_shots already has RLS enabled from 0196; a new
-- column on an already-policed table needs nothing further.
-- video_storyline_director_conversations/_messages are also added to
-- migration 0164's paperclip_tables/company_scope_tables arrays, same
-- documented exception as every other table added after 0164 (see
-- packages/db/src/rls-login-roles.test.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_conversations" TO paperclip_app_scoped;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_messages" TO paperclip_app_scoped;
    ALTER TABLE "video_storyline_director_conversations" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "video_storyline_director_messages" ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'video_storyline_director_conversations' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "video_storyline_director_conversations" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'video_storyline_director_messages' AND policyname = 'paperclip_company_scope'
    ) THEN
      CREATE POLICY paperclip_company_scope ON "video_storyline_director_messages" USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member')) WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid OR pg_has_role(current_user, 'paperclip_app_bypass', 'member'));
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_conversations" TO paperclip_app_bypass_login;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_storyline_director_messages" TO paperclip_app_bypass_login;
  END IF;
END $$;
