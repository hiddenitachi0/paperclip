-- DUR-4999: closed candles only. Each trading strategy now decides on its own
-- candle size, and remembers the newest closed bar it has evaluated so a tick
-- after a gap can catch up on the bars it missed (see
-- packages/db/src/schema/trading.ts and server/src/services/trading.ts).
--
-- Two additive columns on trading_strategies and one CHECK:
--   * timeframe: NOT NULL DEFAULT '15m'. Every row that exists today was a 15m
--     strategy, so existing rows keep 15m; new rows get their timeframe
--     (default 4h) written by the service.
--   * last_evaluated_bar_at: nullable. Null = never evaluated; the first tick
--     evaluates only the latest closed bar and never trades old history.
--   * trading_strategies_timeframe_check: IN ('15m', '1h', '4h', '1d'). The
--     existing asset check is deliberately left unchanged.
-- No existing row is rewritten beyond the column default, no data is lost.
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: ALTER TABLE "trading_strategies" DROP CONSTRAINT IF EXISTS
-- "trading_strategies_timeframe_check", DROP COLUMN IF EXISTS "timeframe",
-- DROP COLUMN IF EXISTS "last_evaluated_bar_at". Safe: nothing else reads
-- these columns; the old code ignores them and trades 15m as before.
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "timeframe" text DEFAULT '15m' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "last_evaluated_bar_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_strategies_timeframe_check') THEN
    ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_timeframe_check" CHECK ("timeframe" IN ('15m', '1h', '4h', '1d'));
  END IF;
END $$;
