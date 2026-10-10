CREATE TABLE "video_transition_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"external_id" text,
	"anchor_hash" text NOT NULL,
	"prompt" text NOT NULL,
	"note" text,
	"duration_ms" integer NOT NULL,
	"audio_mode" text DEFAULT 'bed_only' NOT NULL,
	"result_provider" text,
	"result_object_key" text,
	"result_content_type" text,
	"result_byte_size" integer,
	"result_sha256" text,
	"reserved_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer,
	"qc" jsonb,
	"error" text,
	"created_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_transition_takes_status_check" CHECK ("video_transition_takes"."status" IN ('generating', 'ready', 'failed')),
	CONSTRAINT "video_transition_takes_provider_check" CHECK ("video_transition_takes"."provider" IN ('fal', 'sogni')),
	CONSTRAINT "video_transition_takes_audio_mode_check" CHECK ("video_transition_takes"."audio_mode" IN ('ambient', 'silent', 'bed_only')),
	CONSTRAINT "video_transition_takes_reserved_check" CHECK ("video_transition_takes"."reserved_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "video_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storyline_id" uuid NOT NULL,
	"from_shot_id" uuid NOT NULL,
	"to_shot_id" uuid NOT NULL,
	"kind" text DEFAULT 'cut' NOT NULL,
	"ai_style" text,
	"duration_ms" integer DEFAULT 500 NOT NULL,
	"placement" text DEFAULT 'insert' NOT NULL,
	"context" jsonb,
	"context_hash" text,
	"plain_line" text,
	"prompt" text,
	"user_note" text,
	"suggested_kind" text,
	"suggest_reason" text,
	"keep_same" jsonb DEFAULT '{"face":true,"clothes":true,"location":true}'::jsonb NOT NULL,
	"audio_mode" text DEFAULT 'bed_only' NOT NULL,
	"provider" text,
	"model" text,
	"chosen_take_id" uuid,
	"locked" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_transitions_kind_check" CHECK ("video_transitions"."kind" IN ('cut', 'blend', 'dissolve', 'fade', 'ai')),
	CONSTRAINT "video_transitions_placement_check" CHECK ("video_transitions"."placement" IN ('insert', 'overlap')),
	CONSTRAINT "video_transitions_audio_mode_check" CHECK ("video_transitions"."audio_mode" IN ('ambient', 'silent', 'bed_only')),
	CONSTRAINT "video_transitions_duration_check" CHECK ("video_transitions"."duration_ms" >= 0 AND "video_transitions"."duration_ms" <= 30000),
	CONSTRAINT "video_transitions_suggested_kind_check" CHECK ("video_transitions"."suggested_kind" IS NULL OR "video_transitions"."suggested_kind" IN ('cut', 'blend', 'dissolve', 'fade', 'ai'))
);
--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "frame_notes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "video_transition_takes" ADD CONSTRAINT "video_transition_takes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transition_takes" ADD CONSTRAINT "video_transition_takes_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transition_takes" ADD CONSTRAINT "video_transition_takes_transition_id_video_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."video_transitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_storyline_id_video_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."video_storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_from_shot_id_video_shots_id_fk" FOREIGN KEY ("from_shot_id") REFERENCES "public"."video_shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_to_shot_id_video_shots_id_fk" FOREIGN KEY ("to_shot_id") REFERENCES "public"."video_shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transitions" ADD CONSTRAINT "video_transitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_transition_takes_transition_idx" ON "video_transition_takes" USING btree ("transition_id","created_at");--> statement-breakpoint
CREATE INDEX "video_transition_takes_poll_queue_idx" ON "video_transition_takes" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "video_transition_takes_company_created_idx" ON "video_transition_takes" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_transitions_pair_uq" ON "video_transitions" USING btree ("storyline_id","from_shot_id","to_shot_id");--> statement-breakpoint
CREATE INDEX "video_transitions_company_idx" ON "video_transitions" USING btree ("company_id");--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0241's report_*
-- tables use. Safe where the 0149/0164 roles are absent. Company isolation
-- does NOT rest on this alone: every query in the code also filters on the
-- caller's company.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['video_transitions', 'video_transition_takes'] LOOP
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
END $$;
