-- DUR-313: DUR-299 point 2's mandatory "ready to go live" approval before a
-- user-facing feature launch reaches done. feature_launch is the marker an
-- issue carries when it should require an approved feature_launch approval
-- (see evaluateFeatureLaunchDoneGate) before it can transition to done.
-- Defaults to false so every existing issue is unaffected.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "feature_launch" boolean NOT NULL DEFAULT false;
