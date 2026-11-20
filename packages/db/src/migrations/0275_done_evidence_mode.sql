-- DUR-5179: done-gate with evidence. A per-company setting for how hard the server checks
-- an agent's "done" on a code task (commit on GitHub, touches the files the task names,
-- green checks for that exact commit): 'off' (no check), 'report' (a note on the task, the
-- task still closes) or 'enforce' (the task does not close).
--
-- Strictly additive: one new column with a default of 'off', so every existing company
-- (and every company with no settings row) keeps exactly today's behaviour until someone
-- opts in. Guarded so a re-run is a no-op.
--
-- Rollback (safe: only drops the column; nothing references it, so no row is orphaned.
-- A rollback loses only the companies' choice of mode; the gate then does not exist):
--   ALTER TABLE "company_quality_loop_settings" DROP CONSTRAINT IF EXISTS "cqls_done_evidence_mode_check";
--   ALTER TABLE "company_quality_loop_settings" DROP COLUMN IF EXISTS "done_evidence_mode";
ALTER TABLE "company_quality_loop_settings" ADD COLUMN IF NOT EXISTS "done_evidence_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cqls_done_evidence_mode_check') THEN
    ALTER TABLE "company_quality_loop_settings" ADD CONSTRAINT "cqls_done_evidence_mode_check" CHECK ("done_evidence_mode" IN ('off', 'report', 'enforce'));
  END IF;
END $$;
