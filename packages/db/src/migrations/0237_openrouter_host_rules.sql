-- Settings > Models, OpenRouter hosts: the company's own host rules.
-- openrouter_preferred_hosts: hosts to use for a new OpenRouter model setup
--   when at least one of them runs that model with tool calling.
-- openrouter_blocked_hosts: hosts never to use; added to every OpenRouter
--   setup's "never" list when it is saved (unless that setup marks the host
--   "Use" itself). Both are OpenRouter host slugs such as "novita"; empty by
--   default, so nothing changes for a company until it fills them in.
--
-- Idempotent: safe to run again. The table keeps its RLS and grants from 0236.
--
-- Rollback: ALTER TABLE "model_directory_settings"
--   DROP COLUMN "openrouter_preferred_hosts", DROP COLUMN "openrouter_blocked_hosts";
ALTER TABLE "model_directory_settings" ADD COLUMN IF NOT EXISTS "openrouter_preferred_hosts" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_directory_settings" ADD COLUMN IF NOT EXISTS "openrouter_blocked_hosts" text[] DEFAULT '{}' NOT NULL;
