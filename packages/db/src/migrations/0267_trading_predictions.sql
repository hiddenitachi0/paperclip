-- DUR-5010: the prediction ledger. Every call a forecaster makes (a live
-- strategy's rules, a baseline, later a shadow template or a model) is written
-- down BEFORE its outcome is known, in an append-only table the database itself
-- protects, then resolved exactly once from closed candles. See
-- packages/db/src/schema/trading_predictions.ts, packages/shared/src/trading-scoring.ts
-- and server/src/services/trading-evaluator.ts.
--
-- What this migration does (strictly additive; no existing row is rewritten):
--   * trading_predictions: company-scoped (a version is named by strategy_id + spec_version, which is unique in trading_strategy_versions; there is deliberately no foreign key to that table, so 0266's rollback stays independent of this one) (RLS in both lists of 0164, policy and
--     grants below, same shape as 0266). One prediction per bar through a unique
--     key on (forecaster_key, strategy_id, spec_version, asset, bar_close_at).
--   * A trigger on it. INSERT: decided_at must be the server's clock (within 5
--     minutes), the data the call used must end before it was made and no later
--     than the bar's close, and the outcome must not be known yet. UPDATE: no
--     forecast column ever changes; the outcome columns and `independent` are
--     written once, together, no earlier than resolves_at; a resolved row is
--     frozen. DELETE is untouched, so the cascades from companies and strategies
--     still work (every foreign key here is ON DELETE CASCADE, never SET NULL,
--     because SET NULL would be an UPDATE of a forecast column).
--   * trading_prediction_verdicts: company-scoped, insert-only. The verdict of a
--     (strategy, version, forecaster) is written once; the database refuses the
--     insert while fewer than target_samples independent resolved predictions
--     exist or while less than min_running_days of calendar time has passed since
--     the first call. Until a row exists the status is 'collecting'.
--   * trading_evaluator_state: ONE instance-wide row with the evaluator's last
--     heartbeat. Each boot reads it, writes a gap event for the time since, and
--     starts again. Login-role list of 0164 only (no company data).
--   * trading_ledger_entries: the event type check also allows 'evaluator_gap'
--     (a stretch of time the evaluator was not running; bars that closed in it
--     are never backfilled).
--
-- Retention: predictions and verdicts are the evidence for every score and are
-- kept for as long as the strategy exists; nothing prunes them. Size: one row
-- per forecaster, coin and bar (about 6 a day per coin on 4h bars, 4 forecasters
-- per strategy) is roughly 1,500 rows a year per strategy, a few hundred KB; the
-- indicator snapshot is the bulk. Add the three tables to the offsite-backup
-- plan with the rest of the trading data.
--
-- Every statement is guarded so a re-run is a no-op.
--
-- Rollback (safe: only this feature reads the new objects; the trading tick and
-- the paper order path never touch them; the only old table touched is the
-- ledger's event type list, and rows of the new type are removed first):
--   DROP TABLE IF EXISTS "trading_prediction_verdicts";
--   DROP TABLE IF EXISTS "trading_predictions";
--   DROP TABLE IF EXISTS "trading_evaluator_state";
--   DROP FUNCTION IF EXISTS trading_predictions_guard();
--   DROP FUNCTION IF EXISTS trading_prediction_verdicts_guard();
--   DELETE FROM "trading_ledger_entries" WHERE "event_type" = 'evaluator_gap';
--   ALTER TABLE "trading_ledger_entries" DROP CONSTRAINT IF EXISTS "trading_ledger_entries_event_type_check";
--   ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_event_type_check" CHECK ("event_type" IN ('signal', 'order_filled', 'order_rejected', 'risk_block', 'circuit_breaker', 'kill_switch', 'reconciliation', 'wallet_created', 'wallet_tx_requested', 'wallet_tx_blocked', 'wallet_tx_approval_requested', 'wallet_tx_submitted', 'wallet_tx_confirmed', 'wallet_tx_failed', 'wallet_tx_rejected', 'wallet_kill_switch', 'wallet_reconciliation', 'wallet_settings_changed'));
-- Dropping the tables loses only the predictions and verdicts, not any order,
-- ledger row or strategy.
CREATE TABLE IF NOT EXISTS "trading_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"spec_version" integer NOT NULL,
	"forecaster_kind" text NOT NULL,
	"forecaster_key" text NOT NULL,
	"asset" text NOT NULL,
	"timeframe" text NOT NULL,
	"bar_close_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data_cutoff_at" timestamp with time zone NOT NULL,
	"horizon_bars" integer NOT NULL,
	"resolves_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'direction' NOT NULL,
	"direction" text NOT NULL,
	"probability" double precision,
	"probability_source" text,
	"reference_price" double precision NOT NULL,
	"target_price" double precision,
	"stop_price" double precision,
	"flat_band_pct" double precision NOT NULL,
	"r_distance" double precision,
	"regime" jsonb,
	"indicator_snapshot" jsonb,
	"resolved_at" timestamp with time zone,
	"outcome" text,
	"realized_return" double precision,
	"mfe" double precision,
	"mae" double precision,
	"resolver_version" integer,
	"independent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_predictions_kind_check" CHECK ("trading_predictions"."forecaster_kind" IN ('rule', 'shadow_template', 'baseline', 'model', 'llm')),
	CONSTRAINT "trading_predictions_type_check" CHECK ("trading_predictions"."kind" IN ('direction', 'target_before_stop')),
	CONSTRAINT "trading_predictions_direction_check" CHECK ("trading_predictions"."direction" IN ('up', 'down', 'flat')),
	CONSTRAINT "trading_predictions_outcome_check" CHECK ("trading_predictions"."outcome" IS NULL OR "trading_predictions"."outcome" IN ('hit', 'miss', 'flat', 'void')),
	CONSTRAINT "trading_predictions_probability_check" CHECK (("trading_predictions"."probability" IS NULL) = ("trading_predictions"."probability_source" IS NULL) AND ("trading_predictions"."probability" IS NULL OR ("trading_predictions"."probability" >= 0 AND "trading_predictions"."probability" <= 1)) AND ("trading_predictions"."probability_source" IS NULL OR "trading_predictions"."probability_source" IN ('model', 'llm', 'fitted_out_of_sample'))),
	CONSTRAINT "trading_predictions_horizon_check" CHECK ("trading_predictions"."horizon_bars" >= 1 AND "trading_predictions"."spec_version" >= 1),
	CONSTRAINT "trading_predictions_price_check" CHECK ("trading_predictions"."reference_price" > 0 AND "trading_predictions"."flat_band_pct" >= 0 AND ("trading_predictions"."r_distance" IS NULL OR "trading_predictions"."r_distance" > 0)),
	CONSTRAINT "trading_predictions_cutoff_check" CHECK ("trading_predictions"."data_cutoff_at" <= "trading_predictions"."bar_close_at" AND "trading_predictions"."data_cutoff_at" < "trading_predictions"."decided_at"),
	CONSTRAINT "trading_predictions_before_outcome_check" CHECK ("trading_predictions"."bar_close_at" < "trading_predictions"."resolves_at" AND "trading_predictions"."decided_at" < "trading_predictions"."resolves_at"),
	CONSTRAINT "trading_predictions_resolution_pair_check" CHECK (("trading_predictions"."resolved_at" IS NULL) = ("trading_predictions"."outcome" IS NULL) AND ("trading_predictions"."resolved_at" IS NULL) = ("trading_predictions"."resolver_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_prediction_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"spec_version" integer NOT NULL,
	"forecaster_key" text NOT NULL,
	"target_samples" integer NOT NULL,
	"min_running_days" integer NOT NULL,
	"samples_counted" integer NOT NULL,
	"running_ms" bigint NOT NULL,
	"calendar_ms" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verdict" jsonb NOT NULL,
	CONSTRAINT "trading_prediction_verdicts_target_check" CHECK ("trading_prediction_verdicts"."target_samples" >= 1 AND "trading_prediction_verdicts"."min_running_days" >= 0),
	CONSTRAINT "trading_prediction_verdicts_reached_check" CHECK ("trading_prediction_verdicts"."samples_counted" >= "trading_prediction_verdicts"."target_samples" AND "trading_prediction_verdicts"."running_ms" >= "trading_prediction_verdicts"."min_running_days"::bigint * 86400000 AND "trading_prediction_verdicts"."running_ms" <= "trading_prediction_verdicts"."calendar_ms")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_evaluator_state" (
	"id" text PRIMARY KEY DEFAULT 'evaluator' NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"boot_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_evaluator_state_singleton_check" CHECK ("trading_evaluator_state"."id" = 'evaluator')
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_predictions_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_predictions" ADD CONSTRAINT "trading_predictions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_predictions_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_predictions" ADD CONSTRAINT "trading_predictions_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_prediction_verdicts_company_id_companies_id_fk') THEN
    ALTER TABLE "trading_prediction_verdicts" ADD CONSTRAINT "trading_prediction_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_prediction_verdicts_strategy_id_trading_strategies_id_fk') THEN
    ALTER TABLE "trading_prediction_verdicts" ADD CONSTRAINT "trading_prediction_verdicts_strategy_id_trading_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."trading_strategies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_predictions_one_per_bar_uq" ON "trading_predictions" USING btree ("forecaster_key","strategy_id","spec_version","asset","bar_close_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_predictions_series_idx" ON "trading_predictions" USING btree ("strategy_id","spec_version","forecaster_key","bar_close_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_predictions_unresolved_idx" ON "trading_predictions" USING btree ("resolves_at") WHERE "trading_predictions"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_predictions_company_idx" ON "trading_predictions" USING btree ("company_id","bar_close_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_prediction_verdicts_once_uq" ON "trading_prediction_verdicts" USING btree ("strategy_id","spec_version","forecaster_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_prediction_verdicts_company_idx" ON "trading_prediction_verdicts" USING btree ("company_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_predictions_guard() RETURNS trigger AS $$
DECLARE
  outcome_columns text[] := ARRAY['resolved_at', 'outcome', 'realized_return', 'mfe', 'mae', 'resolver_version', 'independent'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF ABS(EXTRACT(EPOCH FROM (NEW.decided_at - clock_timestamp()))) > 300 THEN
      RAISE EXCEPTION 'trading_predictions: decided_at is the server''s clock and cannot be set to another time'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.data_cutoff_at >= NEW.decided_at THEN
      RAISE EXCEPTION 'trading_predictions: a prediction cannot use data from after it was made (data cutoff % is not before the decision at %)', NEW.data_cutoff_at, NEW.decided_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.resolved_at IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW.realized_return IS NOT NULL OR NEW.mfe IS NOT NULL OR NEW.mae IS NOT NULL OR NEW.independent THEN
      RAISE EXCEPTION 'trading_predictions: a prediction is written without an outcome; the resolver adds it later'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'trading_predictions: this prediction is already resolved and is final'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - outcome_columns) IS DISTINCT FROM (to_jsonb(OLD) - outcome_columns) THEN
    RAISE EXCEPTION 'trading_predictions: the forecast columns of a prediction never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'trading_predictions: the only allowed update is the single resolution (outcome, return, MFE/MAE, resolver version)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at < OLD.resolves_at THEN
    RAISE EXCEPTION 'trading_predictions: a prediction cannot be resolved before its outcome time %', OLD.resolves_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolved_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'trading_predictions: resolved_at cannot be in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome = 'void' AND NEW.independent THEN
    RAISE EXCEPTION 'trading_predictions: a void prediction is never part of the independent set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_predictions_guard ON "trading_predictions";
--> statement-breakpoint
CREATE TRIGGER trading_predictions_guard
  BEFORE INSERT OR UPDATE ON "trading_predictions"
  FOR EACH ROW EXECUTE FUNCTION trading_predictions_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trading_prediction_verdicts_guard() RETURNS trigger AS $$
DECLARE
  counted integer;
  first_call timestamp with time zone;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'trading_prediction_verdicts: a verdict is computed once and never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::integer, min(bar_close_at) INTO counted, first_call
  FROM trading_predictions p
  WHERE p.strategy_id = NEW.strategy_id AND p.spec_version = NEW.spec_version AND p.forecaster_key = NEW.forecaster_key
    AND p.independent AND p.outcome IS NOT NULL AND p.outcome <> 'void';
  IF counted < NEW.target_samples OR NEW.samples_counted > counted THEN
    RAISE EXCEPTION 'trading_prediction_verdicts: no verdict before the planned sample size (% independent resolved predictions, % planned)', counted, NEW.target_samples
      USING ERRCODE = 'check_violation';
  END IF;
  IF first_call IS NULL OR clock_timestamp() - first_call < make_interval(days => NEW.min_running_days) THEN
    RAISE EXCEPTION 'trading_prediction_verdicts: no verdict before the minimum test period of % days has passed', NEW.min_running_days
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trading_prediction_verdicts_guard ON "trading_prediction_verdicts";
--> statement-breakpoint
CREATE TRIGGER trading_prediction_verdicts_guard
  BEFORE INSERT OR UPDATE ON "trading_prediction_verdicts"
  FOR EACH ROW EXECUTE FUNCTION trading_prediction_verdicts_guard();
--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" DROP CONSTRAINT IF EXISTS "trading_ledger_entries_event_type_check";--> statement-breakpoint
ALTER TABLE "trading_ledger_entries" ADD CONSTRAINT "trading_ledger_entries_event_type_check" CHECK ("event_type" IN ('signal', 'order_filled', 'order_rejected', 'risk_block', 'circuit_breaker', 'kill_switch', 'reconciliation', 'wallet_created', 'wallet_tx_requested', 'wallet_tx_blocked', 'wallet_tx_approval_requested', 'wallet_tx_submitted', 'wallet_tx_confirmed', 'wallet_tx_failed', 'wallet_tx_rejected', 'wallet_kill_switch', 'wallet_reconciliation', 'wallet_settings_changed', 'evaluator_gap'));--> statement-breakpoint
-- Row-level security and grants, the same guarded shape 0266 used. Safe where
-- the 0149/0164 roles are absent. Company isolation does NOT rest on this:
-- every query in the code filters on the caller's company. The two company
-- tables are listed in both arrays of 0164, trading_evaluator_state in the
-- login-role array only (no company data, so no policy).
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_scoped') THEN
    FOREACH t IN ARRAY ARRAY['trading_predictions', 'trading_prediction_verdicts'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_scoped', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'paperclip_company_scope'
      ) THEN
        EXECUTE format(
          'CREATE POLICY paperclip_company_scope ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member'')) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid OR pg_has_role(current_user, ''paperclip_app_bypass'', ''member''))',
          t
        );
      END IF;
    END LOOP;
    -- Instance-wide: the scoped role may read it, only the scheduler (bypass login) writes.
    EXECUTE 'GRANT SELECT ON TABLE trading_evaluator_state TO paperclip_app_scoped';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE trading_evaluator_state FROM paperclip_app_scoped';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_app_bypass_login') THEN
    FOREACH t IN ARRAY ARRAY['trading_predictions', 'trading_prediction_verdicts', 'trading_evaluator_state'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO paperclip_app_bypass_login', t);
    END LOOP;
  END IF;
END $$;
