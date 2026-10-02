-- DUR-4318 (video storylines: automatic quality check after stitching): a
-- storyline that finishes stitching now lands on "needs_attention" instead
-- of "done" when the post-stitch quality check (server/src/services/
-- video-quality-check.ts) finds a problem -- qualityCheckIssues carries the
-- structured findings (code/message/shot/time), qualityCheckedAt when the
-- check last ran. Purely additive: existing rows get an empty issues array
-- and a null qualityCheckedAt, which reads as "not checked yet", and no
-- existing status value is removed.
--
-- NOTE: this migration's auto-generated SQL also tried to re-create several
-- tables/columns from 0204/0206/0207/0208 (agent_work_summaries,
-- user_totp_secrets, user_recovery_codes, totp_session_tokens, the "user"
-- totp_* columns, company_job_settings, and the data_connections/
-- data_dataset_sources check constraints) -- drizzle-kit's last committed
-- snapshot (meta/0205_snapshot.json) predates those migrations, which never
-- committed their own snapshot file. Hand-trimmed to just this ticket's
-- actual delta; meta/0209_snapshot.json (committed alongside this file) now
-- reflects the real end-state schema so this gap does not repeat.
--
-- Rollback: ALTER TABLE "video_storylines" DROP COLUMN "quality_check_issues", DROP COLUMN "quality_checked_at"; then restore the prior status check (drop 'needs_attention' from the IN list).
DO $$ BEGIN
	ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "quality_check_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;
	ALTER TABLE "video_storylines" ADD COLUMN IF NOT EXISTS "quality_checked_at" timestamp with time zone;
	ALTER TABLE "video_storylines" DROP CONSTRAINT IF EXISTS "video_storylines_status_check";
	ALTER TABLE "video_storylines" ADD CONSTRAINT "video_storylines_status_check" CHECK ("status" IN ('draft', 'estimated', 'rendering', 'paused', 'ready_to_stitch', 'stitching', 'done', 'needs_attention', 'failed', 'cancelled'));
END $$;
