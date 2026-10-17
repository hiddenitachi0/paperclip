-- "Make a short brag video when this task is done" (brag-on-done).
-- Additive and idempotent. Rollback: DROP INDEX "issues_brag_preapproval_pending_idx";
-- ALTER TABLE "issues" DROP COLUMN "brag_preapproval";
-- ALTER TABLE "companies" DROP COLUMN "brag_on_done_enabled", DROP COLUMN "brag_on_done_max_cost_cents";
-- (brag_jobs.project_id can only be made NOT NULL again once no finished-task video without a project exists.)
ALTER TABLE "brag_jobs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "brag_on_done_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "brag_on_done_max_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "brag_preapproval" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_brag_preapproval_pending_idx" ON "issues" USING btree ("company_id") WHERE "issues"."brag_preapproval" is not null and (("issues"."brag_preapproval" ->> 'triggeredAt') is null or ("issues"."brag_preapproval" ->> 'outcome') = 'accepted');
