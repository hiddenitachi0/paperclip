-- DUR-4497: per-company override for the automatic finished-task worktree cleanup window.
-- Additive, nullable: NULL keeps the server default (7 days), so every existing company
-- behaves identically. Rollback: ALTER TABLE "companies" DROP COLUMN "worktree_cleanup_retention_days"
-- (no other data depends on it; the cleanup job simply falls back to the default).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "worktree_cleanup_retention_days" integer;
