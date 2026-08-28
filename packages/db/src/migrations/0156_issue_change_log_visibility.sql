-- DUR-312: read-only operator changelog (three-channel model, LOGG /
-- point 3) -- a separate, filterable list of fixed bugs and small changes,
-- deliberately kept out of the approval queue. Reuses the issues table
-- (per the operator's own suggested approach) instead of a new table:
-- change_log_visible is the marker an issue is set when it should surface
-- in the list; change_log_summary is the plain-language "what was wrong /
-- what's fixed / where to see it" text an agent writes at close time,
-- distinct from the (often technical) title/description. "When it went
-- live" reads off the existing completed_at column.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "change_log_visible" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "change_log_summary" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_change_log_idx" ON "issues" ("company_id","change_log_visible","completed_at");
