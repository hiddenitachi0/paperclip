-- Two-Factor Authentication (2FA/TOTP) support for board users

-- TOTP secrets table
-- Stores encrypted TOTP secrets for users who have enabled 2FA
CREATE TABLE IF NOT EXISTS "user_totp_secrets" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,

  -- The encrypted TOTP secret (base32-encoded)
  "secret" text NOT NULL,

  -- Whether this TOTP secret is verified (used during setup)
  "verified" boolean NOT NULL DEFAULT false,

  -- When 2FA was enabled (set when verified = true)
  "enabled_at" timestamp with time zone,

  -- When 2FA was disabled (if applicable)
  "disabled_at" timestamp with time zone,

  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,

  CONSTRAINT only_one_active_totp_per_user UNIQUE ("user_id") WHERE ("disabled_at" IS NULL)
);

-- Recovery codes table
-- Stores hashed recovery codes for account recovery if user loses TOTP device
CREATE TABLE IF NOT EXISTS "user_recovery_codes" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,

  -- Hashed recovery code
  "code_hash" text NOT NULL,

  -- When this code was used (NULL if unused)
  "used_at" timestamp with time zone,

  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,

  CONSTRAINT unique_recovery_code UNIQUE ("code_hash")
);

-- 2FA session tokens table
-- Tracks sessions that have been verified with 2FA (for rate limiting and session verification)
CREATE TABLE IF NOT EXISTS "totp_session_tokens" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,

  -- When the 2FA verification occurred
  "verified_at" timestamp with time zone NOT NULL,

  -- Session expiration
  "expires_at" timestamp with time zone NOT NULL,

  "created_at" timestamp with time zone NOT NULL
);

-- Add optional column to track if 2FA is required for user
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "totp_required" boolean NOT NULL DEFAULT false;

-- Add column to track last 2FA verification for security purposes
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "totp_verified_at" timestamp with time zone;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_totp_secrets_user_id ON "user_totp_secrets"("user_id");
CREATE INDEX IF NOT EXISTS idx_user_totp_secrets_verified ON "user_totp_secrets"("verified", "user_id");
CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user_id ON "user_recovery_codes"("user_id");
CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_hash ON "user_recovery_codes"("code_hash");
CREATE INDEX IF NOT EXISTS idx_totp_session_tokens_user_id ON "totp_session_tokens"("user_id");
CREATE INDEX IF NOT EXISTS idx_totp_session_tokens_session_id ON "totp_session_tokens"("session_id");
CREATE INDEX IF NOT EXISTS idx_totp_session_tokens_expires_at ON "totp_session_tokens"("expires_at");
