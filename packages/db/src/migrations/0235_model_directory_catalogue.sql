-- Settings > Models as a catalogue: grouping (maker, base model), what a
-- model is good for (lane), whether a local model is ready (availability),
-- free tags, facts for choosing (specs), favourites and archive. All columns
-- are informational; none change how an agent calls a model.
--
-- Idempotent so a partial run can be retried. The table already has row
-- level security and grants from 0216; adding columns does not change them.
--
-- Rollback: ALTER TABLE "model_directory_entries" DROP COLUMN "maker",
-- DROP COLUMN "base_model", DROP COLUMN "lane", DROP COLUMN "availability",
-- DROP COLUMN "tags", DROP COLUMN "specs", DROP COLUMN "favorite",
-- DROP COLUMN "archived_at" (drops the two CHECK constraints with them).
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "maker" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "base_model" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "lane" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "availability" text;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "specs" jsonb;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "favorite" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_directory_entries" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_entries_lane_check') THEN
    ALTER TABLE "model_directory_entries" ADD CONSTRAINT "model_directory_entries_lane_check" CHECK ("model_directory_entries"."lane" IS NULL OR "model_directory_entries"."lane" IN ('quick', 'full', 'both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_directory_entries_availability_check') THEN
    ALTER TABLE "model_directory_entries" ADD CONSTRAINT "model_directory_entries_availability_check" CHECK ("model_directory_entries"."availability" IS NULL OR "model_directory_entries"."availability" IN ('installed', 'downloading', 'planned', 'cloud'));
  END IF;
END $$;
