-- DUR-4317/DUR-4320 (backend half, storyboard-of-stills approval gate):
-- the storyboard-status gate and cheap-still storage pointers on
-- video_shots. Additive only -- the existing preview_* columns (DUR-4196's
-- round-2 QA tool) are untouched.
--
-- Note: `pnpm db:generate` also picked up several already-applied schema
-- changes (agent_work_summaries, totp_2fa, company_job_settings,
-- paperless_ngx's data_connections check constraints) because the
-- migrations/meta snapshot chain was missing the 0206-0208 snapshot files,
-- so drizzle-kit diffed against the stale 0205 snapshot and re-proposed
-- already-migrated tables (0204/0206/0207/0208 all already created them
-- with CREATE TABLE IF NOT EXISTS). Those statements are intentionally
-- NOT included here -- re-running them would be redundant at best and, for
-- the plain (non "IF NOT EXISTS") CREATE TABLE statements drizzle-kit
-- generated, an outright failure against a database that already ran
-- those migrations. The committed 0209_snapshot.json still reflects the
-- FULL accurate current schema (repairing the broken snapshot chain for
-- future `db:generate` runs); only this file's DDL is scoped down to the
-- genuinely new video_shots columns below.
--
-- Rollback: drop the new columns/index/check constraint
-- (video_shots_storyboard_status_check, video_shots_storyline_storyboard_status_idx,
-- and the 9 "storyboard_status"/"still_*" columns) -- nothing else
-- references them, so this is fully reversible with no data loss beyond
-- the storyboard review state itself. Existing rows read
-- storyboard_status = 'pending' (the column default), so no shot is ever
-- left in an unrecognized state in the window before a backfill (there is
-- none needed here, since all existing shots simply start out needing
-- (re-)review).
ALTER TABLE "video_shots" ADD COLUMN "storyboard_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_provider" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_object_key" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_content_type" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_byte_size" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_sha256" text;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_estimated_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "video_shots" ADD COLUMN "still_actual_cost_cents" integer;--> statement-breakpoint
CREATE INDEX "video_shots_storyline_storyboard_status_idx" ON "video_shots" USING btree ("storyline_id","storyboard_status");--> statement-breakpoint
ALTER TABLE "video_shots" ADD CONSTRAINT "video_shots_storyboard_status_check" CHECK ("video_shots"."storyboard_status" IN ('pending', 'approved', 'dropped'));
