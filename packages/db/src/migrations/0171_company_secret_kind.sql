-- DUR-3997 slice 1: every secret learns what it is.
--
-- A company secret has been a name, a key and an encrypted value, and nothing
-- in Paperclip knew whether the value was an OpenAI key, a Fiken token or a
-- GitHub token. So no screen could offer "the right tokens for the provider
-- you just picked", and nothing could check a pasted key on the spot.
--
-- This adds four nullable columns to company_secrets:
--   kind               what the value is, one of the ids in
--                      packages/shared/src/secret-kinds.ts (plain text, no
--                      CHECK, so a new kind never needs a migration)
--   last_test_at/ok/   outcome of the last Test for the kinds Paperclip can
--   last_test_message  test (AI-provider keys). The message is one sentence
--                      with anything key-shaped removed before it is stored.
--
-- Then a best-effort backfill: a secret whose key is (or starts with) a
-- well-known env var name gets the matching kind. It only ever fills a NULL
-- kind, so re-running it changes nothing and a kind an operator chose is
-- never overwritten. The pairs here are held equal to the shared taxonomy by
-- packages/db/src/company-secret-kind-backfill.test.ts.
--
-- Strictly additive: no DROP, no TRUNCATE, no REVOKE, no new table, no new
-- role or grant (company_secrets already has its RLS policy and grants from
-- 0164; new columns inherit both). Every statement guarded so a re-run is a
-- no-op. No table is discovered by column shape (see the note at the top of
-- 0164_rls_login_roles.sql). Nothing here ever touches a secret's value.
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_test_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN IF NOT EXISTS "last_test_message" text;--> statement-breakpoint
UPDATE "company_secrets"
SET "kind" = CASE upper(split_part("key", '__', 1))
	WHEN 'ANTHROPIC_API_KEY' THEN 'anthropic_api_key'
	WHEN 'CLAUDE_CODE_OAUTH_TOKEN' THEN 'claude_subscription_token'
	WHEN 'OPENAI_API_KEY' THEN 'openai_api_key'
	WHEN 'GEMINI_API_KEY' THEN 'google_api_key'
	WHEN 'GOOGLE_API_KEY' THEN 'google_api_key'
	WHEN 'OPENROUTER_API_KEY' THEN 'openrouter_api_key'
	WHEN 'GITHUB_TOKEN' THEN 'github_token'
	WHEN 'GH_TOKEN' THEN 'github_token'
	WHEN 'PAPERCLIP_GITHUB_TOKEN' THEN 'github_token'
	WHEN 'SLACK_BOT_TOKEN' THEN 'slack_bot_token'
	ELSE NULL
END
WHERE "kind" IS NULL
	AND upper(split_part("key", '__', 1)) IN (
		'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
		'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'PAPERCLIP_GITHUB_TOKEN', 'SLACK_BOT_TOKEN'
	);
