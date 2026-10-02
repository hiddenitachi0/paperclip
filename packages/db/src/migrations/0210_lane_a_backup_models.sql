ALTER TABLE "agents" ADD COLUMN "lane_a_backup_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lane_a_messages" ADD COLUMN "attempts" jsonb;--> statement-breakpoint
ALTER TABLE "lane_a_messages" ADD COLUMN "answered_by" text;