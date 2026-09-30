-- DUR-4059 (morning report overhaul: links, prices, pictures, full briefing
-- page). Two additive columns on the existing morning_report_outbox (0185):
--
--   * facts (jsonb, nullable): the structured MorningReportFacts the report
--     was built from (headlines/hobby/sport with their source URL, prices
--     with change%, weather text, and the fileIds of any pictures Media
--     Studio made) -- kept alongside the model-written `text` so the
--     Telegram bridge can send clickable per-section messages/photos, and so
--     the full briefing page can show every item even ones the model chose
--     not to mention. Null for a report composed before this migration
--     (read as "no structured facts", falling back to plain `text`).
--   * conversation_id (uuid, nullable, FK to lane_a_conversations): the Lane
--     A conversation the report was appended to as an assistant turn, so a
--     later "tell me more about number 3" reply continues the same chat
--     history. Null when the agent is not a quick agent, the company has no
--     board owner to attribute the conversation to, or the insert failed
--     (a missing conversation link must never fail the report itself).
--
-- No existing row is touched; both columns default to NULL, which existing
-- readers (server/src/services/morning-report.ts's outbox() mapping, before
-- this change) never selected.
ALTER TABLE "morning_report_outbox" ADD COLUMN IF NOT EXISTS "facts" jsonb;--> statement-breakpoint
ALTER TABLE "morning_report_outbox" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'morning_report_outbox_conversation_id_lane_a_conversations_id_fk') THEN
    ALTER TABLE "morning_report_outbox" ADD CONSTRAINT "morning_report_outbox_conversation_id_lane_a_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."lane_a_conversations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
