-- DUR-4347 (backend half of DUR-4343 v2): quick-agent backup-model pool, two
-- ordered fallback chains (no-answer / refusal) and keyword-routing rules,
-- plus per-turn attempt logging on lane_a_messages. All six columns are
-- additive with safe defaults ([] / null) -- every existing agent/message row
-- keeps today's single-model behaviour untouched. Rollback is a plain DROP
-- COLUMN on each (no data to preserve: these columns exist only once an
-- operator configures a backup chain).
ALTER TABLE "agents" ADD COLUMN "lane_a_backup_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lane_a_no_answer_chain_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lane_a_refusal_chain_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lane_a_keyword_routes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lane_a_messages" ADD COLUMN "attempts" jsonb;--> statement-breakpoint
ALTER TABLE "lane_a_messages" ADD COLUMN "answered_by" text;