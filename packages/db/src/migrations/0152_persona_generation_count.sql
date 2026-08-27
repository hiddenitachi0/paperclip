-- DUR-177 item 18: enforce personas.dailyGenerationCap (added by DUR-186 /
-- migration 0144) in code, not just store it. `generation_count_today` +
-- `generation_count_date` back an atomic per-persona daily counter -- see
-- personaGenerationGuard in server/src/services/persona-generation-guard.ts,
-- which gates POST /plugins/tools/execute for the media-studio
-- generate-image tool. The date column lets the counter self-reset lazily
-- (compare-and-reset on the next write) instead of needing a cron job to
-- zero every persona out at midnight.

ALTER TABLE "personas" ADD COLUMN "generation_count_today" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "generation_count_date" date;
