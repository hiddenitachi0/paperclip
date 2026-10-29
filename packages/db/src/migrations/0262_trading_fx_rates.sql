-- DUR-5001: a real NOK rate per fill, and strategies scored in USD.
-- (Numbered 0262: 0261 is trading-candle-timeframe.)
--
-- Until now every trading figure in NOK used one fixed 11.5 NOK per USD. From
-- this migration the service stores Norges Bank's daily USD/NOK rate and
-- stamps it on every new fill, and scores strategies in USD (the market's own
-- currency) so the NOK rate cannot create fake gains or losses. NOK stays the
-- display currency and the tax ledger. See packages/db/src/schema/fx_rates.ts
-- and packages/db/src/schema/trading.ts.
--
-- What it does:
--   * fx_rates (new, instance-wide, no company_id): rate_date (unique), rate,
--     source, published_at. Instance-wide market data, so no row-level policy;
--     the app login roles get the same table privileges 0164 gives every
--     Paperclip table (the name is also in 0164's grant-only list, which its
--     test keeps equal to the schema), guarded so it is safe where those roles
--     do not exist.
--   * trading_orders / trading_fifo_lots: fx_rate, fx_date, fx_source (nullable).
--     Every existing row was converted at the fixed 11.5, so it is marked
--     fx_rate = 11.5, fx_source = 'fixed_estimate_11.5', fx_date NULL. That
--     includes rejected and pending orders: their signal price was converted at
--     11.5 too.
--   * trading_strategies: starting_quote_usd, starting_cash_usd, cash_usd,
--     peak_equity_usd (nullable), backfilled as the existing NOK figure / 11.5
--     (exact, because every earlier fill used 11.5). The *_nok columns are left
--     exactly as they are.
-- Resetting each strategy's peak equity to its current equity (so a daily rate
-- below 11.5 cannot trip the drawdown limit right after deploy) needs a live
-- price, so the server does it once at boot and writes a ledger note; it is
-- not done in SQL.
--
-- Every statement is guarded and every backfill only touches rows not yet
-- backfilled, so a re-run is a no-op.
--
-- Rollback (nothing else reads any of this; old code ignores the columns and
-- keeps using 11.5):
--   ALTER TABLE "trading_strategies" DROP COLUMN IF EXISTS "starting_quote_usd",
--     DROP COLUMN IF EXISTS "starting_cash_usd", DROP COLUMN IF EXISTS "cash_usd",
--     DROP COLUMN IF EXISTS "peak_equity_usd";
--   ALTER TABLE "trading_fifo_lots" DROP COLUMN IF EXISTS "fx_rate",
--     DROP COLUMN IF EXISTS "fx_date", DROP COLUMN IF EXISTS "fx_source";
--   ALTER TABLE "trading_orders" DROP COLUMN IF EXISTS "fx_rate",
--     DROP COLUMN IF EXISTS "fx_date", DROP COLUMN IF EXISTS "fx_source";
--   DROP TABLE IF EXISTS "fx_rates";
-- Safe: the only data lost is the stored daily rates and the per-fill rate
-- stamps; no order, lot or strategy row is removed or changed.
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_date" date NOT NULL,
	"rate" double precision NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_unique" UNIQUE("rate_date"),
	CONSTRAINT "fx_rates_rate_check" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "trading_orders" ADD COLUMN IF NOT EXISTS "fx_rate" double precision;--> statement-breakpoint
ALTER TABLE "trading_orders" ADD COLUMN IF NOT EXISTS "fx_date" date;--> statement-breakpoint
ALTER TABLE "trading_orders" ADD COLUMN IF NOT EXISTS "fx_source" text;--> statement-breakpoint
ALTER TABLE "trading_fifo_lots" ADD COLUMN IF NOT EXISTS "fx_rate" double precision;--> statement-breakpoint
ALTER TABLE "trading_fifo_lots" ADD COLUMN IF NOT EXISTS "fx_date" date;--> statement-breakpoint
ALTER TABLE "trading_fifo_lots" ADD COLUMN IF NOT EXISTS "fx_source" text;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "starting_quote_usd" double precision;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "starting_cash_usd" double precision;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "cash_usd" double precision;--> statement-breakpoint
ALTER TABLE "trading_strategies" ADD COLUMN IF NOT EXISTS "peak_equity_usd" double precision;--> statement-breakpoint
UPDATE "trading_orders" SET "fx_rate" = 11.5, "fx_source" = 'fixed_estimate_11.5' WHERE "fx_source" IS NULL;--> statement-breakpoint
UPDATE "trading_fifo_lots" SET "fx_rate" = 11.5, "fx_source" = 'fixed_estimate_11.5' WHERE "fx_source" IS NULL;--> statement-breakpoint
UPDATE "trading_strategies" SET
	"starting_quote_usd" = CASE WHEN "starting_quote_usd" IS NULL AND "starting_quote_nok" IS NOT NULL THEN "starting_quote_nok" / 11.5 ELSE "starting_quote_usd" END,
	"starting_cash_usd" = COALESCE("starting_cash_usd", "starting_cash_nok" / 11.5),
	"cash_usd" = COALESCE("cash_usd", "cash_nok" / 11.5),
	"peak_equity_usd" = COALESCE("peak_equity_usd", "peak_equity_nok" / 11.5)
WHERE "starting_cash_usd" IS NULL OR "cash_usd" IS NULL OR "peak_equity_usd" IS NULL OR ("starting_quote_usd" IS NULL AND "starting_quote_nok" IS NOT NULL);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fx_rates TO paperclip_app_scoped';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fx_rates TO paperclip_app_bypass_login';
  END IF;
END $$;
