-- DUR-4470: cache-write tokens/cost on cost_events. Additive with defaults: existing rows read 0 (unknown, not backfilled).
-- Rollback: DROP COLUMN cache_write_input_tokens, cache_write_1h_input_tokens, cache_write_cost_cents; nothing else depends on them.
ALTER TABLE "cost_events" ADD COLUMN "cache_write_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "cache_write_1h_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "cache_write_cost_cents" double precision DEFAULT 0 NOT NULL;