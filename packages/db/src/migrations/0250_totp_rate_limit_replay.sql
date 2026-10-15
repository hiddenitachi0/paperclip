-- DUR-4297: persisted attempt counter, lockout and replay protection for TOTP.
-- Additive columns only. Rollback: ALTER TABLE "user_totp_secrets" DROP COLUMN
-- "failed_attempts", DROP COLUMN "locked_until", DROP COLUMN "last_used_step";
-- existing rows keep working (defaults: 0 attempts, no lock, no step used).
ALTER TABLE "user_totp_secrets" ADD COLUMN IF NOT EXISTS "failed_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "user_totp_secrets" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
ALTER TABLE "user_totp_secrets" ADD COLUMN IF NOT EXISTS "last_used_step" bigint;
COMMENT ON TABLE "totp_session_tokens" IS 'Records sessions that passed 2FA (session verification only). It is not a rate limiter: attempt limiting lives on user_totp_secrets.failed_attempts/locked_until.';
