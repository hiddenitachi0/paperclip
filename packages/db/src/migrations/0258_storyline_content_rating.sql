-- Film studio Phase 0 (DUR-4895 under DUR-4891): one migration for the two
-- database changes the parallel Phase 0 cards share, so they do not collide.
--
--   * video_storylines.content_rating ('sfw' | 'mature', default 'sfw'),
--     content_rating_set_by and content_rating_set_at (both NULL until
--     someone sets it). Every existing row becomes 'sfw' (strictest default
--     first).
--   * Data fix: a shot that is not finished and has no render job in flight
--     loses its provider/model pin (provider_id, model -> NULL), so the next
--     render picks up the storyline's current model. Finished shots (status
--     'done') KEEP their pin: clip timing, trims, transitions and estimates
--     read it for the real length of a finished clip (Kling 1.6/2.1 stretch
--     7 s to 10 s). Shots with a 'running' render job keep it too.
--
-- No new table, so 0164_rls_login_roles.sql does not change.
--
-- Every statement is guarded, and the UPDATE only ever sets NULLs where
-- something is not NULL, so a re-run is a no-op.
--
-- Rollback: ALTER TABLE "video_storylines" DROP CONSTRAINT
-- "video_storylines_content_rating_check", then DROP COLUMN
-- "content_rating_set_at", "content_rating_set_by", "content_rating". The only
-- data lost is the rating columns. The cleared shot pins are not restored
-- (they were stale for unfinished shots; the storyline's model is the source
-- of truth for the next render), and nothing else reads them as a record.
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "content_rating" text DEFAULT 'sfw' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "content_rating_set_by" text;
--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "content_rating_set_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_storylines_content_rating_check'
      AND conrelid = 'public.video_storylines'::regclass
  ) THEN
    ALTER TABLE "video_storylines"
      ADD CONSTRAINT "video_storylines_content_rating_check"
      CHECK ("content_rating" IN ('sfw', 'mature'));
  END IF;
END $$;
--> statement-breakpoint
UPDATE "video_shots" AS s
SET "provider_id" = NULL, "model" = NULL
WHERE s."status" <> 'done'
  AND (s."provider_id" IS NOT NULL OR s."model" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "video_shot_render_jobs" AS j
    WHERE j."shot_id" = s."id" AND j."status" = 'running'
  );
