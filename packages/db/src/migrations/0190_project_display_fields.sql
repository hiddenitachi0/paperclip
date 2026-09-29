-- DUR-4079 (Project display fields: productionUrl, hostingTarget).
-- Purely additive, no existing column touched, no row rewritten.
--
-- After this migration, `projects` gains two nullable free-text columns:
--   * production_url  -- the live URL, purely descriptive; never read by
--     deploy logic anywhere in this codebase.
--   * hosting_target  -- free-text label of where the project is hosted
--     (e.g. "VPS via deploy-runner", "Vercel"); operator-entered, not
--     derived from deployPolicy.
--
-- Rollback: DROP COLUMN "production_url" and "hosting_target" from
-- projects -- safe, since both default to NULL and nothing else in the
-- codebase depends on their presence.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "production_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "hosting_target" text;
