-- DUR-4344: Telegram reaction feedback. Two NEW tables, no change to existing rows.
-- Rollback: DROP TABLE "telegram_message_reactions"; DROP TABLE "company_reaction_emoji_config";
-- (reactions are only ever written by the bridge after this ships, so nothing else depends on them).
CREATE TABLE "company_reaction_emoji_config" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"positive" jsonb NOT NULL,
	"negative" jsonb NOT NULL,
	"neutral" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" integer NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"emoji" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"picture_file_id" uuid,
	"picture_prompt" text,
	"picture_look" text,
	"picture_provider" text,
	"picture_model" text,
	"reacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_reaction_emoji_config" ADD CONSTRAINT "company_reaction_emoji_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD CONSTRAINT "telegram_message_reactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD CONSTRAINT "telegram_message_reactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD CONSTRAINT "telegram_message_reactions_conversation_id_lane_a_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."lane_a_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_reactions" ADD CONSTRAINT "telegram_message_reactions_message_id_lane_a_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."lane_a_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_message_reactions_company_agent_idx" ON "telegram_message_reactions" USING btree ("company_id","agent_id","reacted_at");--> statement-breakpoint
CREATE INDEX "telegram_message_reactions_conversation_idx" ON "telegram_message_reactions" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_message_reactions_unique_idx" ON "telegram_message_reactions" USING btree ("company_id","telegram_chat_id","telegram_message_id","telegram_user_id","emoji");

--> statement-breakpoint
-- Row-level security and grants, the same guarded shape prior tenant tables
-- (e.g. 0198/0204/0208) use, so this table stays in line on a database
-- where those roles exist. Company isolation does NOT rest on this: every
-- query in the reaction routes filters on the caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegram_message_reactions','company_reaction_emoji_config'] LOOP
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
