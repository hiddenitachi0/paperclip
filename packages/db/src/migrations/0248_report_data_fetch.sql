-- DUR-4072 PR3: report templates read their data through the company's own
-- data connections.
--   report_templates.data_query   the period and up to six named datasets to
--                                 read through data_connection_id (validated
--                                 in code; never a URL, query text or key)
--   report_runs.fetched_data_sha256  sha256 of the stored input snapshot
--   data_read_events channel      + 'report_run' and 'report_preview', so a
--                                 report's reads land in the same audit trail
--                                 (and count against the same daily cap)
--
-- Additive and guarded so a re-run is a no-op: two nullable columns, and the
-- channel check is widened (every existing row still satisfies it).
-- Number 0248 because 0243-0247 are held by other open PRs.
ALTER TABLE "report_runs" ADD COLUMN IF NOT EXISTS "fetched_data_sha256" text;--> statement-breakpoint
ALTER TABLE "report_templates" ADD COLUMN IF NOT EXISTS "data_query" jsonb;--> statement-breakpoint
ALTER TABLE "data_read_events" DROP CONSTRAINT IF EXISTS "data_read_events_channel_check";--> statement-breakpoint
ALTER TABLE "data_read_events" ADD CONSTRAINT "data_read_events_channel_check" CHECK ("data_read_events"."channel" IN ('quick_chat', 'telegram', 'settings_test', 'report_run', 'report_preview'));
