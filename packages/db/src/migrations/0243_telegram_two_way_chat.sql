CREATE TABLE "telegram_chat_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"question" text NOT NULL,
	"route" text NOT NULL,
	"quick_agent_id" uuid,
	"conversation_id" uuid,
	"issue_id" uuid,
	"status" text NOT NULL,
	"answer_text" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "telegram_chat_requests_route_check" CHECK ("telegram_chat_requests"."route" IN ('quick', 'task')),
	CONSTRAINT "telegram_chat_requests_status_check" CHECK ("telegram_chat_requests"."status" IN ('asking', 'answered', 'waiting', 'ready', 'delivered', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "telegram_chat_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"bot_id" uuid,
	"quick_agent_id" uuid,
	"full_agent_id" uuid,
	"daily_questions_per_person" integer DEFAULT 30 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_chat_settings_daily_cap_check" CHECK ("telegram_chat_settings"."daily_questions_per_person" BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "telegram_person_links" (
	"user_id" text PRIMARY KEY NOT NULL,
	"telegram_user_id" text,
	"telegram_username" text,
	"linked_at" timestamp with time zone,
	"link_code_hash" text,
	"link_code_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_chat_requests" ADD CONSTRAINT "telegram_chat_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_requests" ADD CONSTRAINT "telegram_chat_requests_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_requests" ADD CONSTRAINT "telegram_chat_requests_quick_agent_id_agents_id_fk" FOREIGN KEY ("quick_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_requests" ADD CONSTRAINT "telegram_chat_requests_conversation_id_lane_a_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."lane_a_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_requests" ADD CONSTRAINT "telegram_chat_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_settings" ADD CONSTRAINT "telegram_chat_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_settings" ADD CONSTRAINT "telegram_chat_settings_bot_id_telegram_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."telegram_bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_settings" ADD CONSTRAINT "telegram_chat_settings_quick_agent_id_agents_id_fk" FOREIGN KEY ("quick_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_settings" ADD CONSTRAINT "telegram_chat_settings_full_agent_id_agents_id_fk" FOREIGN KEY ("full_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_chat_requests_company_user_created_idx" ON "telegram_chat_requests" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "telegram_chat_requests_company_status_idx" ON "telegram_chat_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_person_links_telegram_user_uq" ON "telegram_person_links" USING btree ("telegram_user_id") WHERE "telegram_person_links"."telegram_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "telegram_person_links_code_hash_idx" ON "telegram_person_links" USING btree ("link_code_hash");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0240 used. Safe where
-- the 0149/0164 roles are absent. The two company-scoped tables get the
-- company policy; telegram_person_links is per person (no company_id), so it
-- only gets the grants, like user_sidebar_preferences. Company isolation does
-- NOT rest on this alone: every query in server/src/services/telegram-chat.ts
-- also filters on the company the bot belongs to.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telegram_chat_settings', 'telegram_chat_requests'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
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
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telegram_person_links TO paperclip_app_scoped;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telegram_person_links TO paperclip_app_bypass_login;
  END IF;
END $$;
