-- DUR-128: a delegated operator credential. A scoped, revocable token the
-- operator issues himself that authenticates as a delegate acting under his
-- authority -- never as the operator. Also adds the timestamps needed to
-- detect an agent stuck in "error" beyond a threshold, so the stall itself
-- becomes visible instead of only discoverable by an operator who happens
-- to look.

CREATE TABLE "board_delegate_tokens" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name"          text NOT NULL,
  "key_hash"      text NOT NULL,
  "scopes"        jsonb NOT NULL DEFAULT '[]',
  "last_used_at"  timestamptz,
  "revoked_at"    timestamptz,
  "expires_at"    timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "board_delegate_tokens_key_hash_idx" ON "board_delegate_tokens"("key_hash");
--> statement-breakpoint
CREATE INDEX "board_delegate_tokens_user_idx" ON "board_delegate_tokens"("user_id");
--> statement-breakpoint

ALTER TABLE "agents"
  ADD COLUMN "error_at"          timestamptz,
  ADD COLUMN "error_alerted_at"  timestamptz;
