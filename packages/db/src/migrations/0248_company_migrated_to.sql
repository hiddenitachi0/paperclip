-- Franchise migration, phase B: "Mark as migrated" on the SOURCE company.
-- After a company has been copied to another Paperclip, an owner/admin can mark
-- the old copy as moved. These columns hold that fact:
--   migrated_to_url               where the company lives now (shown in a banner)
--   migrated_at                   when it was marked
--   migrated_by_user_id           who marked it
--   migration_paused_routine_ids  the routines that were active and got paused,
--                                 so "Undo: resume here" resumes exactly those
-- Agents are paused with pause_reason 'company_migrated' (a text column, no
-- constraint change needed). NULL everywhere = not moved.
--
-- Strictly additive: four nullable columns, no existing row changed. Guarded
-- so a re-run is a no-op. companies is already covered by the RLS setup, so
-- nothing changes there.
--
-- Rollback: ALTER TABLE "companies" DROP COLUMN "migrated_to_url";
--           ALTER TABLE "companies" DROP COLUMN "migrated_at";
--           ALTER TABLE "companies" DROP COLUMN "migrated_by_user_id";
--           ALTER TABLE "companies" DROP COLUMN "migration_paused_routine_ids";
-- Safe -- a rollback only forgets the banner and which routines to resume;
-- paused agents/routines stay paused and can be resumed by hand.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "migrated_to_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "migrated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "migration_paused_routine_ids" jsonb;
