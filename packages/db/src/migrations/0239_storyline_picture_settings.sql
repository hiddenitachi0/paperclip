-- Storylines: how the storyboard pictures (step 2) are made.
--   video_storylines.picture_settings  {providerId?, model?, lookId?} -- the
--     picture service (fal | sogni), its model, and an optional Media Studio
--     look applied to every storyboard picture. {} = the old behaviour
--     (Fal.ai, its cheapest picture model, no look).
--   video_shots.picture_look_id  a shot's own look for its picture: a look
--     id, 'none', or NULL (use the storyline's).
--
-- Strictly additive: two new columns with safe defaults, no existing row
-- changed. Guarded so a re-run is a no-op. Numbered after 0238, the latest
-- on origin/custom when this was written; renumber at merge if another
-- branch also adds 0239.
--
-- Rollback: ALTER TABLE "video_shots" DROP COLUMN "picture_look_id";
--           ALTER TABLE "video_storylines" DROP COLUMN "picture_settings";
-- Safe -- nothing else reads them; a rollback only forgets the picks.
ALTER TABLE "video_shots" ADD COLUMN IF NOT EXISTS "picture_look_id" text;--> statement-breakpoint
ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "picture_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
