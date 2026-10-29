-- DUR-5007: the candle store. Years of closed candles, kept per exchange, for
-- past-data tests (packages/db/src/schema/trading_candles.ts has the design).
--
-- Two new tables, both instance-wide public market data with NO company_id
-- (so they are in the login-role list of 0164_rls_login_roles.sql and not in
-- the company-scoped one):
--   * trading_candles: one row per (source, market, timeframe, open_time).
--     Closed bars only and immutable: a trigger refuses any UPDATE, inserts
--     use ON CONFLICT DO NOTHING, and a later difference is logged to
--     trading_candle_ingest_events instead of overwriting the bar.
--   * trading_candle_ingest_events: append-only log of backfill progress
--     (finished archives, corrections found, a source telling us to stop). The
--     backfill resumes from it after an interruption.
--
-- Access: the scoped login role may only SELECT (company routes read these
-- tables); only the bypass login role (the candle scheduler chain) may INSERT.
-- (0164's default privileges would otherwise hand both roles full write access
-- to every new table, so the grants below explicitly take that back.)
-- No RLS policy is added because there is no company to scope by. Nothing here
-- touches an existing table or row.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "trading_candle_ingest_events", "trading_candles";
-- DROP FUNCTION "trading_candles_refuse_update"(). Safe: nothing else
-- references either table, and the data can be rebuilt from the exchanges.
CREATE TABLE IF NOT EXISTS "trading_candles" (
	"source" text NOT NULL,
	"market" text NOT NULL,
	"timeframe" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_candles_pk" PRIMARY KEY("source","market","timeframe","open_time"),
	CONSTRAINT "trading_candles_source_check" CHECK ("source" IN ('kraken', 'binance', 'coinbase')),
	CONSTRAINT "trading_candles_timeframe_check" CHECK ("timeframe" IN ('5m', '1h', '4h', '1d')),
	CONSTRAINT "trading_candles_sanity_check" CHECK ("open" > 0 AND "high" > 0 AND "low" > 0 AND "close" > 0 AND "volume" >= 0 AND "high" >= "low")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_candle_ingest_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"market" text,
	"timeframe" text,
	"ref" text,
	"open_time" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_candle_ingest_events_kind_check" CHECK ("kind" IN ('archive_done', 'correction', 'invalid_bars', 'source_stopped', 'gap_note'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_candle_ingest_events_kind_ref_idx" ON "trading_candle_ingest_events" USING btree ("kind","source","ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_candle_ingest_events_created_idx" ON "trading_candle_ingest_events" USING btree ("created_at");--> statement-breakpoint
-- Immutability: a stored bar is never rewritten. (The event log is append-only
-- by convention; its rows are inserted once and never updated by the code.)
CREATE OR REPLACE FUNCTION "trading_candles_refuse_update"() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'trading_candles is immutable: a stored candle is never updated (log a correction instead)';
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trading_candles_immutable' AND tgrelid = 'trading_candles'::regclass) THEN
    CREATE TRIGGER "trading_candles_immutable" BEFORE UPDATE ON "trading_candles" FOR EACH ROW EXECUTE FUNCTION "trading_candles_refuse_update"();
  END IF;
END $$;--> statement-breakpoint
-- Grants, the same guarded shape 0251 used (safe where the 0149/0164 roles are
-- absent), but narrower: read for the scoped role, read + insert for the
-- bypass login role. No RLS: these tables hold no company data.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['trading_candles', 'trading_candle_ingest_events'] LOOP
      EXECUTE format('GRANT SELECT ON TABLE %I TO paperclip_app_scoped', t);
      -- ALTER DEFAULT PRIVILEGES from 0164 already granted the full set to new tables; take the writes back.
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM paperclip_app_scoped', t);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['trading_candles', 'trading_candle_ingest_events'] LOOP
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO paperclip_app_bypass_login', t);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I FROM paperclip_app_bypass_login', t);
    END LOOP;
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE trading_candle_ingest_events_id_seq TO paperclip_app_bypass_login';
  END IF;
END $$;
