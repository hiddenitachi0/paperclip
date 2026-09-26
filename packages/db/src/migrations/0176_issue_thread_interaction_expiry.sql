-- Card expiry that knows who filed the card.
--
-- Until now every pending issue-thread interaction (request_confirmation,
-- request_checkbox_confirmation, ask_user_questions, suggest_tasks) closed
-- itself after a fixed 24 hours, whoever created it. That rule was written
-- for cards an AGENT files and then abandons; it also swept away checklist
-- cards a board user filed for themselves as a to-do list, and an agent then
-- treated one of those tasks as done because its card had gone.
--
-- After this migration:
--   * expires_after_hours (integer, NULL) is an optional per-card limit in
--     whole hours. NULL means "use the default for whoever created the card":
--     a card created by a board user never closes by itself, a card created
--     by an agent closes after the instance setting (24 hours unless changed).
--   * never_expires (boolean, false) is the explicit "never" for any card.
--     A separate flag rather than a magic number, so 0 stays invalid (the
--     CHECK below refuses it) and no reader has to know a sentinel.
--
-- Additive only: two nullable/defaulted columns and one CHECK constraint.
-- No row is written, so every existing pending card keeps expires_after_hours
-- NULL and never_expires false, and the server's per-creator default decides
-- what happens to it. Every statement is guarded so a re-run is a no-op.
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "expires_after_hours" integer;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "never_expires" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_expires_after_hours_check') THEN
    ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_expires_after_hours_check" CHECK ("expires_after_hours" IS NULL OR "expires_after_hours" > 0);
  END IF;
END $$;
