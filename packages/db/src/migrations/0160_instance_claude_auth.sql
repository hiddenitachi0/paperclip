-- One-click Claude sign-in: a single instance-wide Claude subscription token
-- that every claude_local agent falls back to when it has no
-- CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY of its own. The token itself is
-- sealed with the same local_encrypted material scheme company secrets use
-- (see server/src/secrets/local-encrypted-provider.ts); this table never
-- holds the plaintext. Instance-wide (no company_id), like instance_settings,
-- so it is deliberately outside the company RLS set from migration 0149.
CREATE TABLE "instance_claude_auth" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "singleton_key"         text NOT NULL DEFAULT 'default',
  "token_sealed"          text NOT NULL,
  "fingerprint_sha256"    text NOT NULL,
  "source"                text NOT NULL DEFAULT 'pasted',
  "saved_by_user_id"      text,
  "saved_at"              timestamptz NOT NULL DEFAULT now(),
  "expires_at"            timestamptz,
  "last_check_at"         timestamptz,
  "last_check_ok"         boolean,
  "last_check_message"    text,
  "last_used_at"          timestamptz,
  "last_auth_failure_at"  timestamptz,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_claude_auth_singleton_key_idx" ON "instance_claude_auth"("singleton_key");
