-- DUR-5013: market weather. One label per coin per day (trend, volatility,
-- squeeze) computed from the closed 1d bars in trading_candles. The rules and
-- thresholds are in packages/shared/src/trading-regimes.ts; the table design is
-- in packages/db/src/schema/trading_regimes.ts.
--
-- One new table, instance-wide public market data with NO company_id, so it is
-- in the login-role list of 0164_rls_login_roles.sql and not in the
-- company-scoped one. Nothing here touches an existing table or row.
--
-- Access: the scoped login role may only SELECT (company routes read it); only
-- the bypass login role (the regime scheduler chain) may INSERT and UPDATE. No
-- DELETE for anyone. (0164's default privileges would otherwise hand both roles
-- full write access to every new table, so the grants below take that back.)
-- No RLS policy is added because there is no company to scope by.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback: DROP TABLE "trading_regimes". Safe: nothing references it and it
-- can be rebuilt from trading_candles.
CREATE TABLE IF NOT EXISTS "trading_regimes" (
	"asset" text NOT NULL,
	"rules_version" smallint NOT NULL,
	"day" date NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"trend" text NOT NULL,
	"volatility" text NOT NULL,
	"squeeze" boolean NOT NULL,
	"close" double precision NOT NULL,
	"sma200" double precision NOT NULL,
	"adx" double precision NOT NULL,
	"atr_pct" double precision NOT NULL,
	"atr_pct_percentile" double precision NOT NULL,
	"bb_width_percentile" double precision NOT NULL,
	"spell_no" integer NOT NULL,
	"spell_start_day" date NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_regimes_pk" PRIMARY KEY("asset","rules_version","day"),
	CONSTRAINT "trading_regimes_source_check" CHECK ("trading_regimes"."source" IN ('kraken', 'binance', 'coinbase')),
	CONSTRAINT "trading_regimes_trend_check" CHECK ("trading_regimes"."trend" IN ('uptrend', 'downtrend', 'ranging')),
	CONSTRAINT "trading_regimes_volatility_check" CHECK ("trading_regimes"."volatility" IN ('low', 'normal', 'high')),
	CONSTRAINT "trading_regimes_percentile_check" CHECK ("trading_regimes"."atr_pct_percentile" BETWEEN 0 AND 100 AND "trading_regimes"."bb_width_percentile" BETWEEN 0 AND 100),
	CONSTRAINT "trading_regimes_spell_check" CHECK ("trading_regimes"."spell_no" >= 1 AND "trading_regimes"."spell_start_day" <= "trading_regimes"."day")
);--> statement-breakpoint
-- Grants, the same guarded shape 0265 used (safe where the 0149/0164 roles are absent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    GRANT SELECT ON TABLE "trading_regimes" TO paperclip_app_scoped;
    -- ALTER DEFAULT PRIVILEGES from 0164 already granted the full set to new tables; take the writes back.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "trading_regimes" FROM paperclip_app_scoped;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "trading_regimes" TO paperclip_app_bypass_login;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "trading_regimes" FROM paperclip_app_bypass_login;
  END IF;
END $$;
